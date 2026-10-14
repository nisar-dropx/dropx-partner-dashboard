import "server-only";

import { resolveConfiguredApprovalWorkflow } from "./configured-approval-routing";
import { resolveConnectApproverUserId } from "./connect-approver-identity";
import { supabaseAdmin } from "./supabase-admin";
import type { ConfiguredApprovalStep } from "./approval-workflow-routing";

type ReimbursementStep = ConfiguredApprovalStep & { stage_code: "manager" | "finance" };

/** One claims only: do not change the shared routes used by other products. */
export async function resolveOneReimbursementWorkflow(input: {
  companyId: string;
  workerType: "employee" | "contractor";
  workerId: string;
  requesterPersonId: string;
  asOf: string;
  directRequester: boolean;
}) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  // Keep the configured manager levels, SSA station-manager policy and cover.
  // The route's optional final stage must not control One's mandatory Finance gate.
  const configured = await resolveConfiguredApprovalWorkflow({
    companyId: input.companyId,
    workflowCode: "reimbursement",
    workerId: input.workerId,
    workerType: input.workerType,
    asOf: input.asOf,
    maxLevel: 2,
    reportingChainOnly: true,
    reportingChainMaxLevel: 2,
    allowMissingApprovers: true
  });
  if (!configured) throw new Error("The reimbursement manager route is not configured for your designation. Contact HR.");
  if (!input.directRequester && !configured.steps.length) {
    throw new Error("No reporting manager is configured. Configure the reporting hierarchy before submitting a claim.");
  }

  const [designations, route] = await Promise.all([
    supabaseAdmin.from("designations").select("id,code,name")
      .eq("company_id", input.companyId).eq("is_active", true),
    supabaseAdmin.from("hr_approval_workflow_routes")
      .select("hr_final_fallback_mode,hr_final_fallback_person_id")
      .eq("company_id", input.companyId).eq("id", configured.routeId).maybeSingle()
  ]);
  if (designations.error) throw new Error(designations.error.message);
  if (route.error) throw new Error(route.error.message);
  const financeIds = new Set((designations.data ?? []).filter((designation) => {
    const code = String(designation.code ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    const name = String(designation.name ?? "").trim().toLowerCase().replace(/[\s-]+/g, " ");
    return code === "FINMGR" || code === "FINANCE_MANAGER" || name === "finance manager";
  }).map((designation) => designation.id));
  const unavailable = "An active Finance Manager with a DropX One approval login is required for reimbursements. Contact HR to configure the Finance Manager.";
  if (!financeIds.size) throw new Error(unavailable);
  const assignments = await supabaseAdmin.from("hr_work_assignments")
    .select("engagement_id").eq("company_id", input.companyId)
    .in("designation_id", [...financeIds]).eq("is_primary", true)
    .lte("effective_from", input.asOf).or(`effective_to.is.null,effective_to.gte.${input.asOf}`);
  if (assignments.error) throw new Error(assignments.error.message);
  const engagementIds = [...new Set((assignments.data ?? []).map((assignment) => assignment.engagement_id))];
  if (!engagementIds.length) throw new Error(unavailable);
  const engagements = await supabaseAdmin.from("hr_engagements").select("id,person_id")
    .eq("company_id", input.companyId).in("id", engagementIds).eq("status", "active")
    .lte("start_date", input.asOf).or(`end_date.is.null,end_date.gte.${input.asOf}`);
  if (engagements.error) throw new Error(engagements.error.message);

  const eligible = new Map<string, ReimbursementStep>();
  for (const engagement of engagements.data ?? []) {
    if (engagement.person_id === input.requesterPersonId || eligible.has(engagement.person_id)) continue;
    // A stale overlapping assignment must not confer Finance authority after a transfer.
    const current = await supabaseAdmin.from("hr_work_assignments").select("designation_id")
      .eq("company_id", input.companyId).eq("engagement_id", engagement.id).eq("is_primary", true)
      .lte("effective_from", input.asOf).or(`effective_to.is.null,effective_to.gte.${input.asOf}`)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    if (!current.data || !financeIds.has(current.data.designation_id)) continue;
    const person = await supabaseAdmin.from("hr_people").select("display_name")
      .eq("company_id", input.companyId).eq("id", engagement.person_id).eq("status", "active").maybeSingle();
    if (person.error) throw new Error(person.error.message);
    if (!person.data) continue;
    const userId = await resolveConnectApproverUserId(input.companyId, engagement.person_id);
    if (!userId) continue;
    eligible.set(engagement.person_id, {
      step_name: "Finance approval", stage_code: "finance",
      approver_user_id: userId, approver_person_id: engagement.person_id,
      approver_name: person.data.display_name, route_id: configured.routeId,
      resolved_via: "configured_designation", original_approver_person_id: null, fallback_reason: null
    });
  }
  // Respect an explicit Finance seat when multiple Finance Managers exist, but
  // never let a generic fallback (HR, tech, next manager) become the Finance gate.
  const preferred = route.data?.hr_final_fallback_mode === "specific_person"
    ? eligible.get(route.data.hr_final_fallback_person_id ?? "") : undefined;
  if (!eligible.size) throw new Error(unavailable);
  if (!preferred && eligible.size > 1) {
    throw new Error("More than one Finance Manager is available. Ask HR to select the final Finance Manager in the reimbursement route.");
  }
  const finance = preferred ?? [...eligible.values()][0];
  // If Finance is also a reporting manager, retain a single final Finance step.
  const steps: ReimbursementStep[] = configured.steps
    .filter((step) => step.approver_person_id !== finance.approver_person_id)
    .map((step) => ({ ...step, stage_code: "manager" }));
  steps.push(finance);
  return { ...configured, steps };
}
