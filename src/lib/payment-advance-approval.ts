import { resolveConnectApproverUserId } from "@/lib/connect-approver-identity";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { supabaseAdmin } from "@/lib/supabase-admin";

type AdvanceProfileType = "employee" | "contractor" | "workforce";

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

async function managerApprover(companyId: string, locationId: string) {
  const hierarchy = await loadPeopleOperationalHierarchy(companyId, [locationId]);
  if (hierarchy.error) throw new Error(hierarchy.error);
  const station = hierarchy.byLocation.get(locationId);
  if (station?.hasClusterManagerConflict) {
    throw new Error("More than one Cluster Manager is mapped equally to this station. Correct Managed locations in People before submitting the advance.");
  }
  const manager = station?.clusterManagers[0] ?? station?.areaOperationsManagers[0];
  if (!manager) throw new Error("No Cluster Manager or Area Operations Manager is mapped to this station in People.");
  const userId = await resolveConnectApproverUserId(companyId, manager.personId);
  if (!userId) throw new Error(`${manager.name} does not have an active DropX One approval login.`);
  return {
    personId: manager.personId,
    userId,
    stepName: station?.clusterManagers.length ? "Cluster Manager approval" : "Area Operations Manager approval"
  };
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
}) {
  const reason = input.purpose.trim();
  if (reason.length < 10) throw new Error("Enter a clearer purpose for this advance (at least 10 characters).");
  const [manager, finance] = await Promise.all([
    managerApprover(input.companyId, input.locationId),
    financeApprover(input.companyId)
  ]);
  if (manager.userId === finance.userId) throw new Error("The operational approver and Finance processor must be different people.");
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
    p_requester: manager.userId,
    p_steps: steps,
    p_outstanding_pay: input.outstandingPay,
    p_eligibility_percent: input.eligibilityPercent,
    p_max_eligible_amount: input.maxEligibleAmount,
    p_external_reference: input.paymentRequestId
  });
  if (created.error) throw new Error(created.error.message);
  const requestId = String(created.data ?? "");
  if (!requestId) throw new Error("Advance approval could not be opened.");
  return { requestId, firstApproverUserId: manager.userId };
}
