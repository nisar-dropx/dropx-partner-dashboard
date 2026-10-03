import { resolveConfiguredApprovalWorkflow } from "@/lib/approval-workflow-routing";
import { supabaseAdmin } from "@/lib/supabase-admin";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

/** Salary advances follow the business expense claim chain: reporting manager, next manager, then Finance. */
export async function openPayAdvanceOnExpenseChain(input: {
  companyId: string;
  profileType: "employee" | "contractor";
  accountId: string;
  amount: number;
  purpose: string;
  paymentRequestId: string;
}) {
  const configured = await resolveConfiguredApprovalWorkflow({
    companyId: input.companyId,
    workflowCode: "reimbursement",
    workerId: input.accountId,
    workerType: input.profileType,
    maxLevel: 3,
    reportingChainOnly: true,
    reportingChainMaxLevel: 2,
    level3StepName: "Finance approval"
  });
  if (!configured?.steps.length) {
    throw new Error("The reimbursement approval route is not configured for your designation. Contact HR.");
  }
  if (!configured.steps.some((step) => step.step_name === "Finance approval")) {
    throw new Error("A final Finance approver is not configured for this reimbursement route. Contact HR.");
  }
  const steps = configured.steps.map((step) => ({
    step_type: step.step_name === "Finance approval" ? "finance" : "manager",
    step_name: step.step_name,
    approver_user_id: step.approver_user_id,
    approver_person_id: step.approver_person_id
  }));
  const reason = input.purpose.trim();
  if (reason.length < 10) throw new Error("Enter a clearer purpose for this advance (at least 10 characters).");
  const created = await db().rpc("hr_create_pay_advance_request", {
    p_company_id: input.companyId,
    p_worker_type: input.profileType,
    p_worker_id: input.accountId,
    p_requested_amount: input.amount,
    p_recovery_mode: "one_time",
    p_requested_installments: 1,
    p_reason: reason,
    p_needed_by: null,
    p_requester: steps[0].approver_user_id,
    p_steps: steps
  });
  if (created.error) throw new Error(created.error.message);
  const requestId = String(created.data ?? "");
  if (!requestId) throw new Error("Advance approval could not be opened.");
  const linked = await db().from("hr_pay_advance_requests").update({
    external_source: "payment_advance_requests",
    external_reference: input.paymentRequestId
  }).eq("company_id", input.companyId).eq("id", requestId);
  if (linked.error) throw new Error(linked.error.message);
  return { requestId, firstApproverUserId: steps[0].approver_user_id };
}
