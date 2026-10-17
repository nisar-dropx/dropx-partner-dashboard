import "server-only";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforceClassification } from "@/lib/workforce-classification";
import { loadHoldStations, type HoldStation } from "./salary-hold-data";
import { holdApprovers } from "./salary-hold-policy";

export type WorkforceHoldStatus = "awaiting_approval" | "active" | "rejected" | "cancelled" | "release_requested" | "released";
export type WorkforceHoldAction = "approve" | "reject" | "withdraw" | "request_release" | "approve_release" | "reject_release";

export type WorkforceHoldRequest = {
  id: string; version: number; workforceId: string; name: string; dropxId: string | null; stationCode: string | null;
  month: string; reason: string; status: WorkforceHoldStatus; raisedByName: string; raisedAt: string;
  decidedByName: string | null; decisionNote: string | null; releaseRequestNote: string | null; releasedByName: string | null;
  approverNames: string[]; actions: WorkforceHoldAction[];
  history: Array<{ action: string; actorName: string | null; note: string | null; createdAt: string }>;
};
/** A payout hold that is in force now, however it was placed (this desk or Payments). */
export type LiveWorkforceHold = { workforceId: string; name: string; dropxId: string | null; stationCode: string | null; month: string; remarks: string; since: string; viaRequest: boolean };
export type WorkforceHoldTarget = { workforceId: string; name: string; dropxId: string | null };

export type WorkforceHoldWorkspace = {
  stations: HoldStation[];
  requests: WorkforceHoldRequest[];
  live: LiveWorkforceHold[];
  canRaise: boolean;
  viewerId: string;
};

const DECISIONS: Partial<Record<WorkforceHoldStatus, WorkforceHoldAction[]>> = {
  awaiting_approval: ["approve", "reject"],
  release_requested: ["approve_release", "reject_release"],
};

export function workforceHoldActions(r: { status: WorkforceHoldStatus; raisedBy: string; releaseRequestedBy: string | null }, viewer: string, isApprover: boolean, canRaise: boolean): WorkforceHoldAction[] {
  const out: WorkforceHoldAction[] = [];
  if (r.raisedBy === viewer && canRaise) {
    if (r.status === "awaiting_approval") out.push("withdraw");
    if (r.status === "active") out.push("request_release");
  }
  const asked = r.status === "awaiting_approval" ? r.raisedBy : r.status === "release_requested" ? r.releaseRequestedBy : null;
  if (isApprover && asked !== viewer) out.push(...(DECISIONS[r.status] ?? []));
  return out;
}

const monthKey = (d: string) => String(d).slice(0, 7);
const scopeFilter = (auth: AuthorizationContext) => (auth.hasAllLocationAccess ? null : auth.locationScopeIds.length ? auth.locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);

export async function loadWorkforceHoldWorkspace(auth: AuthorizationContext): Promise<WorkforceHoldWorkspace> {
  if (!supabaseAdmin) throw new Error("Database is unavailable.");
  const companyId = requireCompanyId(auth);
  const scope = scopeFilter(auth);
  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  let requestsQ = supabaseAdmin.from("ops_workforce_hold_requests").select("*").eq("company_id", companyId)
    .or(`status.in.(awaiting_approval,active,release_requested),period_start.gte.${since}`).order("raised_at", { ascending: false }).limit(300);
  if (scope) requestsQ = requestsQ.in("station_id", scope);
  // Live payout holds: latest event per person and month over a bounded window; small and indexed.
  const eventsQ = supabaseAdmin.from("workforce_payout_payment_hold_events").select("workforce_id,period_start,action,remarks,created_at").eq("company_id", companyId)
    .gte("period_start", since).order("created_at", { ascending: false }).limit(2000);
  const [stations, requestsR, eventsR, links] = await Promise.all([
    loadHoldStations(auth),
    requestsQ,
    eventsQ,
    supabaseAdmin.from("hr_user_person_links").select("person_id").eq("company_id", companyId).eq("user_id", auth.userId).eq("status", "active"),
  ]);
  if (requestsR.error) throw new Error(/does not exist|schema cache/i.test(requestsR.error.message) ? "Workforce hold approvals are not available until the latest database update is applied." : "Workforce holds could not be loaded.");
  if (eventsR.error) throw new Error("Live payout holds could not be loaded.");
  const latest = new Map<string, { workforce_id: string; period_start: string; action: string; remarks: string; created_at: string }>();
  for (const e of (eventsR.data ?? []) as Array<{ workforce_id: string; period_start: string; action: string; remarks: string; created_at: string }>) {
    const key = `${e.workforce_id}|${e.period_start}`;
    if (!latest.has(key)) latest.set(key, e);
  }
  const liveEvents = [...latest.values()].filter((e) => e.action === "hold");
  const requests = (requestsR.data ?? []) as Array<Record<string, any>>;
  const workforceIds = [...new Set([...requests.map((r) => r.workforce_id as string), ...liveEvents.map((e) => e.workforce_id)])];
  const people = new Map<string, { full_name: string | null; dropx_id: string | null; location_id: string | null }>();
  for (let i = 0; i < workforceIds.length; i += 200) {
    const r = await supabaseAdmin.from("workforce").select("id,full_name,dropx_id,location_id").eq("company_id", companyId).in("id", workforceIds.slice(i, i + 200));
    if (r.error) throw new Error("Associates could not be loaded.");
    for (const w of r.data ?? []) people.set(w.id as string, w as { full_name: string | null; dropx_id: string | null; location_id: string | null });
  }
  const allowedStation = (id: string | null | undefined) => !scope || (!!id && scope.includes(id));
  const locationIds = [...new Set([...requests.map((r) => r.station_id as string), ...[...people.values()].map((p) => p.location_id)].filter(Boolean) as string[])];
  const requesterIds = [...new Set(requests.map((r) => r.raised_by as string))];
  const [hierarchy, stationRows, events, requesterLinks] = await Promise.all([
    loadPeopleOperationalHierarchy(companyId, [...new Set(requests.map((r) => r.station_id as string).filter(Boolean))]),
    locationIds.length ? supabaseAdmin.from("stations").select("id,station_code").eq("company_id", companyId).in("id", locationIds) : Promise.resolve({ data: [] as Array<{ id: string; station_code: string }> }),
    requests.length ? supabaseAdmin.from("ops_workforce_hold_events").select("request_id,action,actor_name,note,created_at").eq("company_id", companyId).in("request_id", requests.map((r) => r.id)).order("created_at") : Promise.resolve({ data: [] as Array<Record<string, any>> }),
    requesterIds.length ? supabaseAdmin.from("hr_user_person_links").select("user_id,person_id").eq("company_id", companyId).eq("status", "active").in("user_id", requesterIds) : Promise.resolve({ data: [] as Array<{ user_id: string; person_id: string }> }),
  ]);
  if (hierarchy.error) throw new Error("Cluster managers could not be resolved from People. Please retry.");
  const code = new Map(((stationRows.data ?? []) as Array<{ id: string; station_code: string }>).map((s) => [s.id, s.station_code]));
  const viewerPeople = new Set((links.data ?? []).map((l) => l.person_id as string));
  const requesterPeople = new Map<string, Set<string>>();
  for (const l of (requesterLinks.data ?? []) as Array<{ user_id: string; person_id: string }>) requesterPeople.set(l.user_id, new Set([...(requesterPeople.get(l.user_id) ?? []), l.person_id]));
  const history = new Map<string, WorkforceHoldRequest["history"]>();
  for (const e of (events.data ?? []) as Array<Record<string, any>>) history.set(e.request_id, [...(history.get(e.request_id) ?? []), { action: e.action, actorName: e.actor_name, note: e.note, createdAt: e.created_at }]);
  const canRaise = !auth.readOnly && hasPermission(auth, "ops_salary_hold", "edit");
  const viaRequest = new Set(requests.filter((r) => r.status === "active" || r.status === "release_requested").map((r) => `${r.workforce_id}|${r.period_start}`));
  return {
    stations,
    viewerId: auth.userId,
    canRaise,
    requests: requests.map((r) => {
      const approvers = holdApprovers(hierarchy.byLocation.get(r.station_id), requesterPeople.get(r.raised_by) ?? new Set());
      const isApprover = !auth.readOnly && approvers.personIds.some((p) => viewerPeople.has(p));
      const p = people.get(r.workforce_id);
      return {
        id: r.id, version: r.version, workforceId: r.workforce_id, name: p?.full_name ?? "Associate", dropxId: p?.dropx_id ?? null,
        stationCode: r.station_id ? code.get(r.station_id) ?? null : null, month: monthKey(r.period_start), reason: r.reason, status: r.status,
        raisedByName: r.raised_by_name, raisedAt: r.raised_at, decidedByName: r.decided_by_name, decisionNote: r.decision_note,
        releaseRequestNote: r.release_request_note, releasedByName: r.released_by_name, approverNames: approvers.names,
        actions: workforceHoldActions({ status: r.status, raisedBy: r.raised_by, releaseRequestedBy: r.release_requested_by }, auth.userId, isApprover, canRaise),
        history: history.get(r.id) ?? [],
      };
    }),
    live: liveEvents
      .filter((e) => allowedStation(people.get(e.workforce_id)?.location_id))
      .map((e) => {
        const p = people.get(e.workforce_id);
        return { workforceId: e.workforce_id, name: p?.full_name ?? "Associate", dropxId: p?.dropx_id ?? null, stationCode: p?.location_id ? code.get(p.location_id) ?? null : null, month: monthKey(e.period_start), remarks: e.remarks, since: e.created_at, viaRequest: viaRequest.has(`${e.workforce_id}|${e.period_start}`) };
      })
      .sort((a, b) => b.month.localeCompare(a.month) || a.name.localeCompare(b.name)),
  };
}

/** Delivery-network associates at one station in the viewer's scope; loaded only when picked. */
export async function loadWorkforceHoldTargets(auth: AuthorizationContext, stationId: string): Promise<WorkforceHoldTarget[]> {
  if (!supabaseAdmin) throw new Error("Database is unavailable.");
  if (!/^[0-9a-f-]{36}$/i.test(stationId)) throw new Error("Choose a station.");
  if (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(stationId)) throw new Error("That station is outside your access.");
  const companyId = requireCompanyId(auth);
  const [rows, eligible] = await Promise.all([
    supabaseAdmin.from("workforce").select("id,full_name,dropx_id,designation_id,designation").eq("company_id", companyId).eq("location_id", stationId).is("deleted_at", null).neq("migration_state", "reclassified").order("full_name").limit(800),
    workforceClassification(companyId),
  ]);
  if (rows.error) throw new Error("Associates could not be loaded.");
  return (rows.data ?? []).filter(eligible).map((w) => ({ workforceId: w.id as string, name: (w.full_name as string | null) ?? "Unnamed", dropxId: (w.dropx_id as string | null) ?? null }));
}
