import "server-only";
import { isStationFloorRosterDesignation } from "@/lib/approval-designation-labels";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadPeopleDesignations } from "@/lib/people-designation";
import { supabaseAdmin } from "@/lib/supabase-admin";

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

export type SalaryHoldRecord = {
  id: string;
  workerType: "employee" | "contractor";
  workerId: string;
  workerDisplayName: string;
  holdType: "amount" | "days";
  amount: number | null;
  days: number | null;
  reason: string;
  status: "pending" | "applied" | "cancel_requested" | "cancelled";
  requestedAt: string;
  cancelRequestedAt: string | null;
  cancelRequestNote: string | null;
  cancellationNote: string | null;
  appliedAt: string | null;
  appliedAmount: number | null;
};

export type SalaryHoldWorkspace = {
  checkedAt: string;
  designationTierCleared: boolean;
  eligibleWorkers: SalaryHoldWorker[];
  holds: SalaryHoldRecord[];
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

type RawHold = {
  id: string;
  worker_type: "employee" | "contractor";
  worker_id: string;
  hold_type: "amount" | "days";
  amount: number | null;
  days: number | null;
  reason: string;
  status: "pending" | "applied" | "cancel_requested" | "cancelled";
  requested_at: string;
  cancel_requested_at: string | null;
  cancel_request_note: string | null;
  cancellation_note: string | null;
  applied_at: string | null;
  applied_amount: number | null;
};

/**
 * Loads the salary-hold workspace for the logged-in manager: whether they
 * clear the station-floor-tier gate (Senior Store Manager and above only -
 * see isStationFloorRosterDesignation), their current direct reports as
 * eligible hold targets, and every hold they have personally requested (any
 * status) for their own visibility/accountability.
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

  if (!designationTierCleared) {
    return { checkedAt, designationTierCleared: false, eligibleWorkers: [], holds: [] };
  }

  const { reports, error: reportsError } = await loadDirectReportsForSalaryHold(companyId, auth.userId);
  if (reportsError) throw new Error("Your reporting team could not be resolved. Please contact HR.");

  const holdsResult = await supabaseAdmin
    .from("ops_salary_holds")
    .select("id,worker_type,worker_id,hold_type,amount,days,reason,status,requested_at,cancel_requested_at,cancel_request_note,cancellation_note,applied_at,applied_amount")
    .eq("company_id", companyId)
    .eq("requested_by_user_id", auth.userId)
    .order("requested_at", { ascending: false });
  if (holdsResult.error) throw new Error("Previously placed salary holds could not be loaded.");

  const nameByWorker = new Map(reports.map((r) => [`${r.workerType}:${r.workerId}`, r.displayName]));
  const holds: SalaryHoldRecord[] = ((holdsResult.data ?? []) as RawHold[]).map((row) => ({
    id: row.id,
    workerType: row.worker_type,
    workerId: row.worker_id,
    workerDisplayName: nameByWorker.get(`${row.worker_type}:${row.worker_id}`) ?? "Former direct report",
    holdType: row.hold_type,
    amount: row.amount,
    days: row.days,
    reason: row.reason,
    status: row.status,
    requestedAt: row.requested_at,
    cancelRequestedAt: row.cancel_requested_at,
    cancelRequestNote: row.cancel_request_note,
    cancellationNote: row.cancellation_note,
    appliedAt: row.applied_at,
    appliedAmount: row.applied_amount
  }));

  return { checkedAt, designationTierCleared: true, eligibleWorkers: reports, holds };
}
