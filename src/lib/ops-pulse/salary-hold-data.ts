import "server-only";
import { isStationFloorRosterDesignation } from "@/lib/approval-designation-labels";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadActiveApprovalCovers } from "@/lib/approval-covers";
import { loadPeopleDesignations } from "@/lib/people-designation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import {
  approverActions,
  holdApprovers,
  requesterActions,
  type SalaryHoldAction,
  type SalaryHoldStatus,
} from "./salary-hold-policy";

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

export type SalaryHoldWorker = {
  personId: string;
  assignmentId: string;
  displayName: string;
  designationName: string | null;
  workerType: "employee" | "contractor";
  workerId: string;
};

/**
 * Direct reports of the logged-in manager, resolved identically to
 * offboarding-checklist-data.ts's loadDirectReports (hr_user_person_links ->
 * hr_engagements -> hr_work_assignments (is_primary) ->
 * hr_reporting_relationships (solid_line, is_primary) -> subject
 * hr_work_assignments/hr_engagements -> employees/contractors + designations).
 * Duplicated here (with this attribution comment) rather than extracted into a
 * shared helper, given time constraints - a follow-up could hoist both copies
 * into a single "direct reports of a manager" module in
 * people-operational-hierarchy.ts.
 */
export async function loadDirectReportsForSalaryHold(companyId: string, managerUserId: string): Promise<{ reports: SalaryHoldWorker[]; error: string | null }> {
  const empty = { reports: [] as SalaryHoldWorker[], error: null as string | null };
  if (!supabaseAdmin) return { ...empty, error: "Supabase service role key is not configured." };

  const linkResult = await supabaseAdmin
    .from("hr_user_person_links")
    .select("person_id")
    .eq("company_id", companyId)
    .eq("user_id", managerUserId)
    .eq("status", "active");
  if (linkResult.error) return { ...empty, error: linkResult.error.message };
  const managerPersonIds = [...new Set((linkResult.data ?? []).map((row) => row.person_id).filter(Boolean))];
  if (!managerPersonIds.length) return empty;

  const day = indiaToday();
  const managerEngagementsResult = await supabaseAdmin
    .from("hr_engagements")
    .select("id,person_id,status")
    .eq("company_id", companyId)
    .eq("status", "active")
    .in("person_id", managerPersonIds);
  if (managerEngagementsResult.error) return { ...empty, error: managerEngagementsResult.error.message };
  const managerEngagementIds = (managerEngagementsResult.data ?? []).map((row) => row.id);
  if (!managerEngagementIds.length) return empty;

  const managerAssignmentsResult = await supabaseAdmin
    .from("hr_work_assignments")
    .select("id,engagement_id")
    .eq("company_id", companyId)
    .eq("is_primary", true)
    .in("engagement_id", managerEngagementIds)
    .lte("effective_from", day)
    .or(`effective_to.is.null,effective_to.gte.${day}`);
  if (managerAssignmentsResult.error) return { ...empty, error: managerAssignmentsResult.error.message };
  const managerAssignmentIds = [...new Set((managerAssignmentsResult.data ?? []).map((row) => row.id))];
  if (!managerAssignmentIds.length) return empty;

  const relationshipsResult = await supabaseAdmin
    .from("hr_reporting_relationships")
    .select("subject_assignment_id,manager_assignment_id")
    .eq("company_id", companyId)
    .eq("relationship_type", "solid_line")
    .eq("is_primary", true)
    .in("manager_assignment_id", managerAssignmentIds)
    .lte("effective_from", day)
    .or(`effective_to.is.null,effective_to.gte.${day}`);
  if (relationshipsResult.error) return { ...empty, error: relationshipsResult.error.message };
  const subjectAssignmentIds = [...new Set((relationshipsResult.data ?? []).map((row) => row.subject_assignment_id).filter(Boolean))];
  if (!subjectAssignmentIds.length) return empty;

  const subjectAssignmentsResult = await supabaseAdmin
    .from("hr_work_assignments")
    .select("id,engagement_id,designation_id")
    .eq("company_id", companyId)
    .in("id", subjectAssignmentIds);
  if (subjectAssignmentsResult.error) return { ...empty, error: subjectAssignmentsResult.error.message };
  const subjectAssignments = subjectAssignmentsResult.data ?? [];
  const subjectEngagementIds = [...new Set(subjectAssignments.map((row) => row.engagement_id))];
  if (!subjectEngagementIds.length) return empty;

  const [subjectEngagementsResult, designationsResult] = await Promise.all([
    supabaseAdmin
      .from("hr_engagements")
      .select("id,person_id,worker_type,employee_id,contractor_id,status")
      .eq("company_id", companyId)
      .eq("status", "active")
      .in("id", subjectEngagementIds),
    supabaseAdmin
      .from("designations")
      .select("id,name")
      .eq("company_id", companyId)
  ]);
  if (subjectEngagementsResult.error) return { ...empty, error: subjectEngagementsResult.error.message };
  if (designationsResult.error) return { ...empty, error: designationsResult.error.message };
  const designationById = new Map((designationsResult.data ?? []).map((row) => [row.id, row.name as string | null]));
  const engagementById = new Map((subjectEngagementsResult.data ?? []).map((row) => [row.id, row]));

  const personIds = [...new Set((subjectEngagementsResult.data ?? []).map((row) => row.person_id).filter(Boolean))];
  const peopleResult = personIds.length
    ? await supabaseAdmin.from("hr_people").select("id,display_name").eq("company_id", companyId).in("id", personIds)
    : { data: [], error: null };
  if (peopleResult.error) return { ...empty, error: peopleResult.error.message };
  const nameByPersonId = new Map((peopleResult.data ?? []).map((row) => [row.id, row.display_name as string]));

  const reports: SalaryHoldWorker[] = subjectAssignments.flatMap((assignment) => {
    const engagement = engagementById.get(assignment.engagement_id);
    if (!engagement) return [];
    const workerType = engagement.worker_type === "contractor" ? "contractor" as const : "employee" as const;
    const workerId = workerType === "contractor" ? engagement.contractor_id : engagement.employee_id;
    if (!workerId || !engagement.person_id) return [];
    return [{
      personId: engagement.person_id,
      assignmentId: assignment.id,
      displayName: nameByPersonId.get(engagement.person_id) ?? "Unknown",
      designationName: assignment.designation_id ? designationById.get(assignment.designation_id) ?? null : null,
      workerType,
      workerId
    }];
  });

  return { reports, error: null };
}

export type SalaryHoldEvent = { action: string; toStatus: string; actorName: string | null; note: string | null; createdAt: string };

export type SalaryHoldRecord = {
  id: string;
  version: number;
  workerType: "employee" | "contractor";
  workerId: string;
  workerName: string;
  workerCode: string | null;
  stationCode: string | null;
  holdType: "amount" | "days";
  amount: number | null;
  days: number | null;
  reason: string;
  status: SalaryHoldStatus;
  requestedAt: string;
  requestedByName: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  cancelRequestNote: string | null;
  appliedAmount: number | null;
  appliedAt: string | null;
  releaseRequestNote: string | null;
  releasedByName: string | null;
  releasedAt: string | null;
  releaseAmount: number | null;
  paidBack: boolean;
  approverNames: string[];
  approverLevel: "cluster_manager" | "aom" | "none";
  /** What the viewer may do now. */
  actions: SalaryHoldAction[];
  history: SalaryHoldEvent[];
};

export type HoldStation = { id: string; code: string };
export type HoldTarget = { workerType: "employee" | "contractor"; workerId: string; displayName: string; code: string | null; designation: string | null; stationCode: string | null };

export type SalaryHoldWorkspace = {
  /** Stations the viewer may raise holds for (their Ops location scope). */
  stations: HoldStation[];
  checkedAt: string;
  viewerId: string;
  designationTierCleared: boolean;
  eligibleWorkers: SalaryHoldWorker[];
  /** Holds the viewer raised. */
  holds: SalaryHoldRecord[];
  /** Open requests the viewer decides as the station's cluster manager. */
  approvals: SalaryHoldRecord[];
  /** Holds the viewer approved, rejected or released in the last 60 days. */
  decided: SalaryHoldRecord[];
};

const HOLD_COLUMNS =
  "id,version,worker_type,worker_id,location_id,hold_type,amount,days,reason,status,requested_at,requested_by_user_id,requested_by_name,decided_by,decided_by_name,decided_at,decision_note,cancel_requested_by_user_id,cancel_request_note,applied_at,applied_amount,release_requested_by,release_request_note,released_by,released_by_name,released_at,release_amount,release_run_id";

type RawHold = {
  id: string; version: number; worker_type: "employee" | "contractor"; worker_id: string; location_id: string | null;
  hold_type: "amount" | "days"; amount: number | null; days: number | null; reason: string; status: SalaryHoldStatus;
  requested_at: string; requested_by_user_id: string | null; requested_by_name: string | null;
  decided_by: string | null; decided_by_name: string | null; decided_at: string | null; decision_note: string | null;
  cancel_requested_by_user_id: string | null; cancel_request_note: string | null;
  applied_at: string | null; applied_amount: number | null;
  release_requested_by: string | null; release_request_note: string | null;
  released_by: string | null; released_by_name: string | null; released_at: string | null; release_amount: number | null; release_run_id: string | null;
};
type NamedRow = { id: string; full_name: string | null; employee_code?: string | null; dropx_id?: string | null };
type LocatedRow = { id: string; location_id: string | null };

/** People records linked to a login. */
async function personIdsForUser(companyId: string, userId: string) {
  const result = await supabaseAdmin!.from("hr_user_person_links").select("person_id").eq("company_id", companyId).eq("user_id", userId).eq("status", "active");
  if (result.error) throw new Error("Your People profile could not be resolved.");
  return new Set((result.data ?? []).map((row) => row.person_id as string).filter(Boolean));
}

/** The station of a worker, used to route a new hold to that station's cluster manager. */
export async function workerLocation(companyId: string, workerType: "employee" | "contractor", workerId: string) {
  const result = await supabaseAdmin!.from(workerType === "employee" ? "employees" : "contractors").select("location_id").eq("company_id", companyId).eq("id", workerId).maybeSingle();
  if (result.error) throw new Error("The person's station could not be resolved.");
  return (result.data?.location_id as string | null) ?? null;
}

/** Each hold's station (saved when raised; older holds fall back to the person's current station). */
async function holdLocations(companyId: string, holds: RawHold[]) {
  const byHold = new Map<string, string | null>();
  const missing = holds.filter((h) => !h.location_id);
  const employeeIds = [...new Set(missing.filter((h) => h.worker_type === "employee").map((h) => h.worker_id))];
  const contractorIds = [...new Set(missing.filter((h) => h.worker_type === "contractor").map((h) => h.worker_id))];
  const [employees, contractors] = await Promise.all([
    employeeIds.length ? supabaseAdmin!.from("employees").select("id,location_id").eq("company_id", companyId).in("id", employeeIds) : Promise.resolve({ data: [] as LocatedRow[], error: null }),
    contractorIds.length ? supabaseAdmin!.from("contractors").select("id,location_id").eq("company_id", companyId).in("id", contractorIds) : Promise.resolve({ data: [] as LocatedRow[], error: null }),
  ]);
  if (employees.error || contractors.error) throw new Error("Salary hold stations could not be resolved.");
  const loc = new Map<string, string | null>([
    ...((employees.data ?? []) as LocatedRow[]).map((r) => [`employee:${r.id}`, r.location_id] as [string, string | null]),
    ...((contractors.data ?? []) as LocatedRow[]).map((r) => [`contractor:${r.id}`, r.location_id] as [string, string | null]),
  ]);
  for (const h of holds) byHold.set(h.id, h.location_id ?? loc.get(`${h.worker_type}:${h.worker_id}`) ?? null);
  return byHold;
}

async function describeHolds(companyId: string, viewerId: string, viewerPeople: Set<string>, rows: RawHold[]) {
  if (!rows.length) return [] as SalaryHoldRecord[];
  const locations = await holdLocations(companyId, rows);
  const locationIds = [...new Set([...locations.values()].filter(Boolean) as string[])];
  const employeeIds = [...new Set(rows.filter((h) => h.worker_type === "employee").map((h) => h.worker_id))];
  const contractorIds = [...new Set(rows.filter((h) => h.worker_type === "contractor").map((h) => h.worker_id))];
  const requesterIds = [...new Set(rows.map((h) => h.requested_by_user_id).filter(Boolean) as string[])];
  const [hierarchy, employees, contractors, stations, events, requesterLinks, covers] = await Promise.all([
    loadPeopleOperationalHierarchy(companyId, locationIds),
    employeeIds.length ? supabaseAdmin!.from("employees").select("id,employee_code,full_name").eq("company_id", companyId).in("id", employeeIds) : Promise.resolve({ data: [] as NamedRow[], error: null }),
    contractorIds.length ? supabaseAdmin!.from("contractors").select("id,dropx_id,full_name").eq("company_id", companyId).in("id", contractorIds) : Promise.resolve({ data: [] as NamedRow[], error: null }),
    locationIds.length ? supabaseAdmin!.from("stations").select("id,station_code").eq("company_id", companyId).in("id", locationIds) : Promise.resolve({ data: [] as Array<{ id: string; station_code: string }>, error: null }),
    supabaseAdmin!.from("ops_salary_hold_events").select("hold_id,action,to_status,actor_name,note,created_at").eq("company_id", companyId).in("hold_id", rows.map((r) => r.id)).order("created_at"),
    requesterIds.length ? supabaseAdmin!.from("hr_user_person_links").select("user_id,person_id").eq("company_id", companyId).eq("status", "active").in("user_id", requesterIds) : Promise.resolve({ data: [] as Array<{ user_id: string; person_id: string }>, error: null }),
    loadActiveApprovalCovers(companyId),
  ]);
  const requesterPeople = new Map<string, Set<string>>();
  for (const link of (requesterLinks.data ?? []) as Array<{ user_id: string; person_id: string }>) {
    const set = requesterPeople.get(link.user_id) ?? new Set<string>();
    set.add(link.person_id);
    requesterPeople.set(link.user_id, set);
  }
  if (hierarchy.error) throw new Error("Cluster managers could not be resolved from People. Please retry.");
  if (employees.error || contractors.error || stations.error || events.error) throw new Error("Salary hold details could not be loaded.");
  const people = new Map<string, { name: string; code: string | null }>([
    ...((employees.data ?? []) as NamedRow[]).map((r) => [`employee:${r.id}`, { name: r.full_name ?? "Unknown", code: r.employee_code ?? null }] as [string, { name: string; code: string | null }]),
    ...((contractors.data ?? []) as NamedRow[]).map((r) => [`contractor:${r.id}`, { name: r.full_name ?? "Unknown", code: r.dropx_id ?? null }] as [string, { name: string; code: string | null }]),
  ]);
  const stationCode = new Map(((stations.data ?? []) as Array<{ id: string; station_code: string }>).map((r) => [r.id, r.station_code]));
  const history = new Map<string, SalaryHoldEvent[]>();
  for (const e of (events.data ?? []) as Array<{ hold_id: string; action: string; to_status: string; actor_name: string | null; note: string | null; created_at: string }>) {
    const list = history.get(e.hold_id) ?? [];
    list.push({ action: e.action, toStatus: e.to_status, actorName: e.actor_name, note: e.note, createdAt: e.created_at });
    history.set(e.hold_id, list);
  }
  return rows.map((h) => {
    const location = locations.get(h.id) ?? null;
    const approvers = holdApprovers(location ? hierarchy.byLocation.get(location) : undefined, requesterPeople.get(h.requested_by_user_id ?? "") ?? new Set(), covers);
    const isApprover = approvers.personIds.some((id) => viewerPeople.has(id));
    const person = people.get(`${h.worker_type}:${h.worker_id}`);
    const mine = h.requested_by_user_id === viewerId;
    const actions = [
      ...(mine ? requesterActions(h.status) : []),
      ...approverActions(
        { status: h.status, requestedBy: h.requested_by_user_id, cancelRequestedBy: h.cancel_requested_by_user_id, releaseRequestedBy: h.release_requested_by },
        viewerId,
        isApprover,
      ),
    ];
    const record: SalaryHoldRecord = {
      id: h.id,
      version: h.version,
      workerType: h.worker_type,
      workerId: h.worker_id,
      workerName: person?.name ?? "Former team member",
      workerCode: person?.code ?? null,
      stationCode: location ? stationCode.get(location) ?? null : null,
      holdType: h.hold_type,
      amount: h.amount == null ? null : Number(h.amount),
      days: h.days == null ? null : Number(h.days),
      reason: h.reason,
      status: h.status,
      requestedAt: h.requested_at,
      requestedByName: h.requested_by_name,
      decidedByName: h.decided_by_name,
      decidedAt: h.decided_at,
      decisionNote: h.decision_note,
      cancelRequestNote: h.cancel_request_note,
      appliedAmount: h.applied_amount == null ? null : Number(h.applied_amount),
      appliedAt: h.applied_at,
      releaseRequestNote: h.release_request_note,
      releasedByName: h.released_by_name,
      releasedAt: h.released_at,
      releaseAmount: h.release_amount == null ? null : Number(h.release_amount),
      paidBack: !!h.release_run_id,
      approverNames: approvers.names,
      approverLevel: approvers.level,
      actions: [...new Set(actions)],
      history: history.get(h.id) ?? [],
    };
    return record;
  });
}

/** The hold as this user sees it now, with the actions they may take. Re-checked on every change; never trusted from the client. */
export async function loadHoldForViewer(companyId: string, viewerId: string, holdId: string) {
  if (!supabaseAdmin) throw new Error("Salary hold service unavailable.");
  const result = await supabaseAdmin.from("ops_salary_holds").select(HOLD_COLUMNS).eq("company_id", companyId).eq("id", holdId).maybeSingle();
  if (result.error || !result.data) throw new Error("Salary hold could not be found.");
  const [record] = await describeHolds(companyId, viewerId, await personIdsForUser(companyId, viewerId), [result.data as unknown as RawHold]);
  return record;
}

/**
 * The salary hold desk for the signed-in user: holds they raised (Senior Store Manager and above, for
 * direct reports), open requests they decide as a station's cluster manager, and their recent decisions.
 */
export async function loadSalaryHoldWorkspace(auth: AuthorizationContext): Promise<SalaryHoldWorkspace> {
  if (!hasPermission(auth, "ops_salary_hold", "access")) throw new Error("Salary hold access is required.");
  if (!supabaseAdmin) throw new Error("Salary hold service unavailable.");
  const companyId = requireCompanyId(auth);
  const checkedAt = new Date().toISOString();

  const designationByUser = await loadPeopleDesignations(companyId, [auth.userId]);
  const viewerDesignation = designationByUser.get(auth.userId);
  const designationTierCleared = Boolean(viewerDesignation) && !isStationFloorRosterDesignation({
    name: viewerDesignation?.name ?? "",
    code: viewerDesignation?.code ?? null
  });

  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const [reportsResult, viewerPeople, mine, open, decided] = await Promise.all([
    designationTierCleared ? loadDirectReportsForSalaryHold(companyId, auth.userId) : Promise.resolve({ reports: [] as SalaryHoldWorker[], error: null }),
    personIdsForUser(companyId, auth.userId),
    supabaseAdmin.from("ops_salary_holds").select(HOLD_COLUMNS).eq("company_id", companyId).eq("requested_by_user_id", auth.userId).order("requested_at", { ascending: false }).limit(200),
    supabaseAdmin.from("ops_salary_holds").select(HOLD_COLUMNS).eq("company_id", companyId).in("status", ["awaiting_approval", "cancel_requested", "release_requested"]).order("requested_at").limit(500),
    supabaseAdmin.from("ops_salary_holds").select(HOLD_COLUMNS).eq("company_id", companyId).or(`decided_by.eq.${auth.userId},released_by.eq.${auth.userId}`).gte("updated_at", since).order("updated_at", { ascending: false }).limit(50),
  ]);
  if (reportsResult.error) throw new Error("Your reporting team could not be resolved. Please contact HR.");
  const failed = [mine.error, open.error, decided.error].find(Boolean);
  if (failed) {
    throw new Error(/column|does not exist|schema cache/i.test(failed.message)
      ? "Salary hold approvals are not available until the latest database update is applied."
      : "Salary holds could not be loaded.");
  }
  const mineRows = (mine.data ?? []) as unknown as RawHold[];
  const openRows = ((open.data ?? []) as unknown as RawHold[]).filter((h) => h.requested_by_user_id !== auth.userId);
  const decidedRows = ((decided.data ?? []) as unknown as RawHold[]).filter((h) => h.requested_by_user_id !== auth.userId);
  const unique = [...new Map([...mineRows, ...openRows, ...decidedRows].map((h) => [h.id, h])).values()];
  const described = await describeHolds(companyId, auth.userId, viewerPeople, unique);
  const mineIds = new Set(mineRows.map((h) => h.id));
  const openIds = new Set(openRows.map((h) => h.id));
  const decidedIds = new Set(decidedRows.map((h) => h.id));
  // Open requests become approvals only at stations where the viewer is the cluster manager.
  const decisions = new Set(["approve", "reject", "approve_cancel", "reject_cancel", "approve_release", "reject_release"]);
  const approvals = described.filter((h) => openIds.has(h.id) && h.actions.some((a) => decisions.has(a)));
  const approvalIds = new Set(approvals.map((h) => h.id));
  return {
    stations: designationTierCleared ? await loadHoldStations(auth) : [],
    checkedAt,
    viewerId: auth.userId,
    designationTierCleared,
    eligibleWorkers: reportsResult.reports,
    holds: described.filter((h) => mineIds.has(h.id)),
    approvals,
    decided: described.filter((h) => decidedIds.has(h.id) && !approvalIds.has(h.id)),
  };
}

/** The viewer's Ops stations: everything for all-location access, else their location scope. */
export async function loadHoldStations(auth: AuthorizationContext): Promise<HoldStation[]> {
  if (!supabaseAdmin) return [];
  const companyId = requireCompanyId(auth);
  let q = supabaseAdmin.from("stations").select("id,station_code").eq("company_id", companyId).order("station_code").limit(1000);
  if (!auth.hasAllLocationAccess) q = q.in("id", auth.locationScopeIds.length ? auth.locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
  const result = await q;
  if (result.error) throw new Error("Your stations could not be loaded.");
  return (result.data ?? []).map((r) => ({ id: r.id as string, code: r.station_code as string }));
}

/**
 * Active People (employees and contractors) at one station the viewer may act for. Loaded only when a
 * station is picked, so the page never reads the whole company.
 */
export async function loadStationHoldTargets(auth: AuthorizationContext, stationId: string): Promise<HoldTarget[]> {
  if (!supabaseAdmin) throw new Error("Salary hold service unavailable.");
  if (!/^[0-9a-f-]{36}$/i.test(stationId)) throw new Error("Choose a station.");
  if (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(stationId)) throw new Error("That station is outside your access.");
  const companyId = requireCompanyId(auth);
  const [station, employees, contractors] = await Promise.all([
    supabaseAdmin.from("stations").select("station_code").eq("company_id", companyId).eq("id", stationId).maybeSingle(),
    supabaseAdmin.from("employees").select("id,employee_code,full_name,people_lifecycle_status,designations(name)").eq("company_id", companyId).eq("location_id", stationId).eq("is_active", true).order("full_name").limit(500),
    supabaseAdmin.from("contractors").select("id,dropx_id,full_name,designation,people_lifecycle_status").eq("company_id", companyId).eq("location_id", stationId).eq("is_active", true).order("full_name").limit(500),
  ]);
  if (station.error || !station.data) throw new Error("Station not found.");
  if (employees.error || contractors.error) throw new Error("Station people could not be loaded.");
  const leaving = new Set(["offboarded", "exited", "closed"]);
  const code = station.data.station_code as string;
  const rel = <T,>(v: T | T[] | null | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  return [
    ...((employees.data ?? []) as Array<{ id: string; employee_code: string | null; full_name: string | null; people_lifecycle_status: string | null; designations: { name: string } | { name: string }[] | null }>)
      .filter((e) => !leaving.has(String(e.people_lifecycle_status ?? "")))
      .map((e) => ({ workerType: "employee" as const, workerId: e.id, displayName: e.full_name ?? "Unnamed", code: e.employee_code, designation: rel(e.designations)?.name ?? null, stationCode: code })),
    ...((contractors.data ?? []) as Array<{ id: string; dropx_id: string | null; full_name: string | null; designation: string | null; people_lifecycle_status: string | null }>)
      .filter((c) => !leaving.has(String(c.people_lifecycle_status ?? "")))
      .map((c) => ({ workerType: "contractor" as const, workerId: c.id, displayName: c.full_name ?? "Unnamed", code: c.dropx_id, designation: c.designation, stationCode: code })),
  ].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Server check before raising: the person is a direct report, or active at one of the viewer's stations. */
export async function holdTargetAllowed(auth: AuthorizationContext, workerType: "employee" | "contractor", workerId: string) {
  const companyId = requireCompanyId(auth);
  const { reports } = await loadDirectReportsForSalaryHold(companyId, auth.userId);
  const direct = reports.find((r) => r.workerType === workerType && r.workerId === workerId);
  if (direct) return { allowed: true, name: direct.displayName };
  const row = await supabaseAdmin!.from(workerType === "employee" ? "employees" : "contractors").select("full_name,location_id,is_active").eq("company_id", companyId).eq("id", workerId).maybeSingle();
  if (row.error || !row.data || row.data.is_active !== true || !row.data.location_id) return { allowed: false, name: "" };
  const inScope = auth.hasAllLocationAccess || auth.locationScopeIds.includes(row.data.location_id as string);
  return { allowed: inScope, name: (row.data.full_name as string | null) ?? "this person" };
}
