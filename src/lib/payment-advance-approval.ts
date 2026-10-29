import { resolveConnectApproverUserId } from "@/lib/connect-approver-identity";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { supabaseAdmin } from "@/lib/supabase-admin";

type AdvanceProfileType = "employee" | "contractor" | "workforce";

type ManagerApprover = {
  personId: string;
  userId: string;
  stepName: string;
  resolvedVia: "reporting_manager" | "station_manager";
};

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

async function financeApprover(companyId: string) {
  const asOf = indiaToday();
  const designationResult = await db().from("designations").select("id,code,name")
    .eq("company_id", companyId).eq("is_active", true);
  if (designationResult.error) throw new Error(designationResult.error.message);
  const financeIds = (designationResult.data ?? []).filter((designation) => {
    const code = String(designation.code ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    const name = String(designation.name ?? "").trim().toLowerCase().replace(/[\s-]+/g, " ");
    return ["FINMGR", "FINANCE_MANAGER"].includes(code) || name === "finance manager";
  }).map((designation) => designation.id);
  const unavailable = "An active Finance Manager with a DropX One approval login is required. Configure it in People before submitting advances.";
  if (!financeIds.length) throw new Error(unavailable);
  const assignments = await db().from("hr_work_assignments").select("id,engagement_id,designation_id")
    .eq("company_id", companyId).eq("is_primary", true).in("designation_id", financeIds)
    .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`);
  if (assignments.error) throw new Error(assignments.error.message);
  const engagementIds = [...new Set((assignments.data ?? []).map((row) => row.engagement_id))];
  if (!engagementIds.length) throw new Error(unavailable);
  const engagements = await db().from("hr_engagements").select("id,person_id")
    .eq("company_id", companyId).eq("status", "active").in("id", engagementIds)
    .lte("start_date", asOf).or(`end_date.is.null,end_date.gte.${asOf}`);
  if (engagements.error) throw new Error(engagements.error.message);
  const candidates: Array<{ personId: string; userId: string }> = [];
  for (const engagement of engagements.data ?? []) {
    const userId = await resolveConnectApproverUserId(companyId, engagement.person_id);
    if (userId && !candidates.some((candidate) => candidate.personId === engagement.person_id)) {
      candidates.push({ personId: engagement.person_id, userId });
    }
  }
  if (!candidates.length) throw new Error(unavailable);
  if (candidates.length === 1) return candidates[0];
  const routes = await db().from("hr_approval_workflow_routes")
    .select("workflow_code,hr_final_fallback_mode,hr_final_fallback_person_id,priority")
    .eq("company_id", companyId).eq("is_active", true)
    .in("workflow_code", ["pay_advance", "reimbursement"])
    .eq("hr_final_fallback_mode", "specific_person")
    .order("priority", { ascending: false });
  if (routes.error && !/does not exist|schema cache/i.test(routes.error.message)) throw new Error(routes.error.message);
  const preferred = (routes.data ?? []).flatMap((route) =>
    candidates.filter((candidate) => candidate.personId === route.hr_final_fallback_person_id))[0];
  if (preferred) return preferred;
  throw new Error("More than one Finance Manager is active. Select the Finance approver in the Pay Advance approval master.");
}

async function requesterPersonId(
  companyId: string,
  profileType: AdvanceProfileType,
  accountId: string
) {
  if (profileType === "workforce") return null;
  const workerColumn = profileType === "employee" ? "employee_id" : "contractor_id";
  const engagement = await db().from("hr_engagements").select("id,person_id,status")
    .eq("company_id", companyId).eq("worker_type", profileType).eq(workerColumn, accountId)
    .eq("status", "active").order("start_date", { ascending: false }).limit(1).maybeSingle();
  if (engagement.error) throw new Error(engagement.error.message);
  return engagement.data?.person_id ?? null;
}

/** Solid-line manager with a DropX One login; walks up past unavailable / excluded people. */
async function reportingManagerApprover(
  companyId: string,
  profileType: AdvanceProfileType,
  accountId: string,
  excludePersonIds: Set<string> = new Set()
): Promise<ManagerApprover | null> {
  if (profileType === "workforce") return null;
  const asOf = indiaToday();
  const workerColumn = profileType === "employee" ? "employee_id" : "contractor_id";
  const engagement = await db().from("hr_engagements").select("id,person_id,status")
    .eq("company_id", companyId).eq("worker_type", profileType).eq(workerColumn, accountId)
    .eq("status", "active").order("start_date", { ascending: false }).limit(1).maybeSingle();
  if (engagement.error) throw new Error(engagement.error.message);
  if (!engagement.data) return null;

  const assignment = await db().from("hr_work_assignments")
    .select("id,engagement_id,position_title")
    .eq("company_id", companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignment.error) throw new Error(assignment.error.message);
  if (!assignment.data) return null;

  const seen = new Set([assignment.data.id]);
  let currentAssignmentId = assignment.data.id;
  for (let depth = 0; depth < 16; depth += 1) {
    const relationship = await db().from("hr_reporting_relationships")
      .select("manager_assignment_id")
      .eq("company_id", companyId).eq("subject_assignment_id", currentAssignmentId)
      .eq("relationship_type", "solid_line").eq("is_primary", true)
      .lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (relationship.error) throw new Error(relationship.error.message);
    if (!relationship.data || seen.has(relationship.data.manager_assignment_id)) return null;
    seen.add(relationship.data.manager_assignment_id);

    const managerAssignment = await db().from("hr_work_assignments")
      .select("id,engagement_id,position_title")
      .eq("company_id", companyId).eq("id", relationship.data.manager_assignment_id).maybeSingle();
    if (managerAssignment.error) throw new Error(managerAssignment.error.message);
    if (!managerAssignment.data) return null;

    const managerEngagement = await db().from("hr_engagements").select("id,person_id,status")
      .eq("company_id", companyId).eq("id", managerAssignment.data.engagement_id).maybeSingle();
    if (managerEngagement.error) throw new Error(managerEngagement.error.message);
    currentAssignmentId = managerAssignment.data.id;
    if (!managerEngagement.data || managerEngagement.data.status !== "active") continue;
    if (managerEngagement.data.person_id === engagement.data.person_id) continue;
    if (excludePersonIds.has(managerEngagement.data.person_id)) continue;

    const person = await db().from("hr_people").select("id,display_name,status")
      .eq("company_id", companyId).eq("id", managerEngagement.data.person_id).maybeSingle();
    if (person.error) throw new Error(person.error.message);
    if (!person.data || person.data.status !== "active") continue;

    const userId = await resolveConnectApproverUserId(companyId, person.data.id);
    if (!userId) continue;

    const title = String(managerAssignment.data.position_title ?? "").trim() || "Reporting manager";
    return {
      personId: person.data.id,
      userId,
      stepName: `${title} approval`,
      resolvedVia: "reporting_manager"
    };
  }
  return null;
}

async function stationManagerApprover(
  companyId: string,
  locationId: string,
  excludePersonIds: Set<string>
): Promise<ManagerApprover> {
  const hierarchy = await loadPeopleOperationalHierarchy(companyId, [locationId]);
  if (hierarchy.error) throw new Error(hierarchy.error);
  const station = hierarchy.byLocation.get(locationId);
  const clusterManagers = (station?.clusterManagers ?? []).filter((manager) => !excludePersonIds.has(manager.personId));
  const areaManagers = (station?.areaOperationsManagers ?? []).filter((manager) => !excludePersonIds.has(manager.personId));
  if (clusterManagers.length > 1 && clusterManagers[0].supportCount === clusterManagers[1].supportCount) {
    throw new Error("More than one Cluster Manager is mapped equally to this station. Correct Managed locations in People before submitting the advance.");
  }
  const manager = clusterManagers[0] ?? areaManagers[0];
  if (!manager) {
    throw new Error("No reporting manager, Cluster Manager, or Area Operations Manager is available for this advance. Fix the People reporting line or Managed locations.");
  }
  const userId = await resolveConnectApproverUserId(companyId, manager.personId);
  if (!userId) throw new Error(`${manager.name} does not have an active DropX One approval login.`);
  return {
    personId: manager.personId,
    userId,
    stepName: clusterManagers.length ? "Cluster Manager approval" : "Area Operations Manager approval",
    resolvedVia: "station_manager"
  };
}

/** Prefer the requester's solid-line manager; fall back to station CM/AOM only when needed. */
export async function resolvePayAdvanceManagerApprover(input: {
  companyId: string;
  profileType: AdvanceProfileType;
  accountId: string;
  locationId: string;
  excludePersonIds?: Set<string>;
}): Promise<ManagerApprover> {
  const personId = await requesterPersonId(input.companyId, input.profileType, input.accountId);
  const exclude = new Set(input.excludePersonIds ?? []);
  if (personId) exclude.add(personId);
  const reporting = await reportingManagerApprover(
    input.companyId,
    input.profileType,
    input.accountId,
    exclude
  );
  if (reporting) return reporting;
  return stationManagerApprover(input.companyId, input.locationId, exclude);
}

/** Pay advances have exactly one operational approval and one Finance processing decision. */
export async function openPayAdvanceApproval(input: {
  companyId: string;
  profileType: AdvanceProfileType;
  accountId: string;
  locationId: string;
  amount: number;
  purpose: string;
  paymentRequestId: string;
  outstandingPay: number;
  eligibilityPercent: number;
  maxEligibleAmount: number;
  requesterUserId?: string | null;
}) {
  const reason = input.purpose.trim();
  if (reason.length < 10) throw new Error("Enter a clearer purpose for this advance (at least 10 characters).");
  const [manager, finance] = await Promise.all([
    resolvePayAdvanceManagerApprover(input),
    financeApprover(input.companyId)
  ]);
  if (manager.userId === finance.userId) throw new Error("The operational approver and Finance processor must be different people.");
  const requesterUserId = input.requesterUserId
    || (await requesterPersonId(input.companyId, input.profileType, input.accountId)
      .then(async (personId) => personId ? resolveConnectApproverUserId(input.companyId, personId) : null))
    || manager.userId;
  const steps = [
    {
      step_type: "manager", step_name: manager.stepName,
      approver_user_id: manager.userId, approver_person_id: manager.personId
    },
    {
      step_type: "finance", step_name: "Finance processing",
      approver_user_id: finance.userId, approver_person_id: finance.personId
    }
  ];
  const created = await db().rpc("hr_create_pay_advance_request_v2", {
    p_company_id: input.companyId,
    p_worker_type: input.profileType,
    p_worker_id: input.accountId,
    p_requested_amount: input.amount,
    p_recovery_mode: "one_time",
    p_requested_installments: 1,
    p_reason: reason,
    p_needed_by: null,
    p_requester: requesterUserId,
    p_steps: steps,
    p_outstanding_pay: input.outstandingPay,
    p_eligibility_percent: input.eligibilityPercent,
    p_max_eligible_amount: input.maxEligibleAmount,
    p_external_reference: input.paymentRequestId
  });
  if (created.error) throw new Error(created.error.message);
  const requestId = String(created.data ?? "");
  if (!requestId) throw new Error("Advance approval could not be opened.");
  return { requestId, firstApproverUserId: manager.userId, resolvedVia: manager.resolvedVia };
}

/**
 * Reassigns pending manager steps to the current reporting-manager (or station
 * fallback) owner. Decided steps stay immutable.
 */
export async function remapPendingPayAdvanceManagerSteps(companyId: string) {
  const pending = await db().from("hr_pay_advance_steps")
    .select("id,request_id,step_name,approver_user_id,approver_person_id,status,hr_pay_advance_requests!inner(id,company_id,worker_type,worker_id,location_id,status)")
    .eq("company_id", companyId).eq("status", "pending").eq("step_type", "manager")
    .eq("hr_pay_advance_requests.status", "pending")
    .order("created_at", { ascending: false }).limit(200);
  if (pending.error) throw new Error(pending.error.message);

  const changes: Array<{
    requestId: string;
    stepId: string;
    fromPersonId: string | null;
    toPersonId: string;
    stepName: string;
    resolvedVia: string;
  }> = [];

  for (const step of pending.data ?? []) {
    const request = Array.isArray(step.hr_pay_advance_requests)
      ? step.hr_pay_advance_requests[0]
      : step.hr_pay_advance_requests;
    if (!request?.location_id) continue;
    if (!["employee", "contractor", "workforce"].includes(String(request.worker_type))) continue;

    // Multi-step legacy advances may already have an earlier manager approval.
    // Never reassign the open seat back to someone who already decided on this request.
    const prior = await db().from("hr_pay_advance_steps")
      .select("approver_person_id,status")
      .eq("company_id", companyId).eq("request_id", request.id)
      .in("status", ["approved", "rejected", "returned"]);
    if (prior.error) throw new Error(prior.error.message);
    const excludePersonIds = new Set(
      (prior.data ?? []).map((row) => row.approver_person_id).filter((id): id is string => Boolean(id))
    );

    const desired = await resolvePayAdvanceManagerApprover({
      companyId,
      profileType: request.worker_type as AdvanceProfileType,
      accountId: request.worker_id,
      locationId: request.location_id,
      excludePersonIds
    });
    if (desired.userId === step.approver_user_id && desired.personId === step.approver_person_id
      && desired.stepName === step.step_name) {
      continue;
    }

    const updated = await db().from("hr_pay_advance_steps").update({
      step_name: desired.stepName,
      approver_user_id: desired.userId,
      approver_person_id: desired.personId,
      updated_at: new Date().toISOString()
    }).eq("company_id", companyId).eq("id", step.id).eq("status", "pending")
      .select("id").maybeSingle();
    if (updated.error) throw new Error(updated.error.message);
    if (!updated.data) continue;

    changes.push({
      requestId: request.id,
      stepId: step.id,
      fromPersonId: step.approver_person_id,
      toPersonId: desired.personId,
      stepName: desired.stepName,
      resolvedVia: desired.resolvedVia
    });
  }

  return changes;
}
