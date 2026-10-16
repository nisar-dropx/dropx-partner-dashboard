import "server-only";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nlStationScope } from "./nl-loss";
import type { LossSettings, NlCase, Recovery, RecoveryOutcome } from "./nl-loss-policy";
import { holdApprovers } from "./salary-hold-policy";
import { claimActions, type ClaimAction, type ClaimCategory, type ClaimStatus } from "./station-claims-policy";

export type ClaimEvent = { action: string; toStatus: string; actorName: string | null; note: string | null; createdAt: string };
export type StationClaim = {
  id: string; version: number; stationId: string; stationCode: string; reference: string; incidentDate: string;
  category: ClaimCategory; amount: number; description: string; evidenceUrl: string | null; people: string | null;
  status: ClaimStatus; raisedByName: string; raisedAt: string; decidedByName: string | null; decidedAt: string | null;
  decisionNote: string | null; caseMonth: string | null; caseKey: string | null;
  approverNames: string[]; actions: ClaimAction[]; history: ClaimEvent[];
};

const COLUMNS = "id,version,station_id,station_code,reference,incident_date,category,amount,description,evidence_url,people_involved,status,raised_by,raised_by_name,raised_at,decided_by_name,decided_at,decision_note,case_month,case_key";

export function canRaiseClaims(auth: AuthorizationContext) {
  return !auth.readOnly && (hasPermission(auth, "ops_losses", "add") || hasPermission(auth, "ops_workforce_losses", "add"));
}

/** Claims of the user's stations (open ones, and anything raised in the last 180 days), with who decides each. */
export async function loadStationClaims(auth: AuthorizationContext) {
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const db = supabaseAdmin;
  const { company, stations } = await nlStationScope(auth);
  const stationIds = stations.map((s) => s.id);
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  const [claimsResult, links] = await Promise.all([
    stationIds.length
      ? db.from("ops_station_loss_claims").select(COLUMNS).eq("company_id", company).in("station_id", stationIds)
          .or(`status.in.(submitted,returned),raised_at.gte.${since}`).order("raised_at", { ascending: false }).limit(500)
      : Promise.resolve({ data: [], error: null }),
    db.from("hr_user_person_links").select("person_id").eq("company_id", company).eq("user_id", auth.userId).eq("status", "active"),
  ]);
  if (claimsResult.error) {
    if (/does not exist|schema cache/i.test(claimsResult.error.message)) return { ready: false as const, company, stations, claims: [] as StationClaim[], cases: [] as NlCase[], outcomes: [] as RecoveryOutcome[], settings: null as LossSettings | null };
    throw Error("Station claims could not be loaded.");
  }
  const rows = (claimsResult.data ?? []) as Array<Record<string, any>>;
  const viewerPeople = new Set((links.data ?? []).map((r) => r.person_id as string));
  const claimStations = [...new Set(rows.map((r) => r.station_id as string))];
  const approvedKeys = rows.filter((r) => r.status === "approved" && r.case_key).map((r) => r.case_key as string);
  const [hierarchy, events, cases, recoveries, outcomes, settings] = await Promise.all([
    loadPeopleOperationalHierarchy(company, claimStations),
    rows.length ? db.from("ops_station_loss_claim_events").select("claim_id,action,to_status,actor_name,note,created_at").eq("company_id", company).in("claim_id", rows.map((r) => r.id)).order("created_at") : Promise.resolve({ data: [], error: null }),
    approvedKeys.length ? db.from("nl_loss_month_cases").select("*").eq("company_id", company).eq("report", "station").in("case_key", approvedKeys) : Promise.resolve({ data: [], error: null }),
    approvedKeys.length ? db.from("nl_loss_recoveries").select("*").eq("company_id", company).in("case_key", approvedKeys) : Promise.resolve({ data: [], error: null }),
    db.from("nl_recovery_outcomes").select("*").eq("company_id", company).order("sort_order").order("label"),
    db.from("nl_loss_sources").select("recoverable_statuses,allow_equal_split,allow_custom_split,include_inactive_people,history_months,updated_at,recovery_policy").eq("company_id", company).maybeSingle(),
  ]);
  if (hierarchy.error) throw Error("Cluster managers could not be resolved from People. Please retry.");
  if (events.error || cases.error || recoveries.error || outcomes.error || settings.error) throw Error("Station claim details could not be loaded.");
  const history = new Map<string, ClaimEvent[]>();
  for (const e of (events.data ?? []) as Array<Record<string, any>>) {
    const list = history.get(e.claim_id) ?? [];
    list.push({ action: e.action, toStatus: e.to_status, actorName: e.actor_name, note: e.note, createdAt: e.created_at });
    history.set(e.claim_id, list);
  }
  const canRaise = canRaiseClaims(auth);
  const claims: StationClaim[] = rows.map((r) => {
    const approvers = holdApprovers(hierarchy.byLocation.get(r.station_id));
    const isApprover = !auth.readOnly && approvers.personIds.some((id) => viewerPeople.has(id));
    return {
      id: r.id, version: r.version, stationId: r.station_id, stationCode: r.station_code, reference: r.reference,
      incidentDate: r.incident_date, category: r.category, amount: Number(r.amount), description: r.description,
      evidenceUrl: r.evidence_url, people: r.people_involved, status: r.status, raisedByName: r.raised_by_name,
      raisedAt: r.raised_at, decidedByName: r.decided_by_name, decidedAt: r.decided_at, decisionNote: r.decision_note,
      caseMonth: r.case_month, caseKey: r.case_key, approverNames: approvers.names,
      actions: claimActions({ status: r.status, raisedBy: r.raised_by }, auth.userId, isApprover, canRaise),
      history: history.get(r.id) ?? [],
    };
  });
  const plans = new Map(((recoveries.data ?? []) as Recovery[] & Array<{ month: string; case_key: string }>).map((p: any) => [`${p.month}::${p.case_key}`, p as Recovery]));
  const caseRows = ((cases.data ?? []) as Array<Record<string, any>>).map((c) => ({ ...c, recovery: plans.get(`${c.month}::${c.case_key}`) ?? null })) as NlCase[];
  return { ready: true as const, company, stations, claims, cases: caseRows, outcomes: (outcomes.data ?? []) as RecoveryOutcome[], settings: settings.data as LossSettings | null };
}
