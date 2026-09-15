import "server-only";
import type { ConnectAccount } from "./connect-auth";
import { resolveConnectActorUserIds } from "./connect-approver-identity";
import { payAdvanceDecision, payAdvanceFinanceTerms, type PayAdvanceApproval } from "./connect-pay-advance-approval";
import { supabaseAdmin } from "./supabase-admin";

function db() { if (!supabaseAdmin) throw new Error("Database configuration is unavailable."); return supabaseAdmin; }

export async function listConnectPayAdvanceApprovals(account: ConnectAccount): Promise<PayAdvanceApproval[]> {
  const actorIds = await resolveConnectActorUserIds(account);
  if (!actorIds.length) return [];
  const steps = await db().from("hr_pay_advance_steps").select("id,request_id,step_name,step_type")
    .eq("company_id", account.companyId).in("approver_user_id", actorIds).eq("status", "pending").order("created_at");
  if (steps.error) throw new Error(steps.error.message);
  if (!steps.data?.length) return [];
  const requests = await db().from("hr_pay_advance_requests")
    .select("id,request_number,worker_name,worker_code,requested_amount,approved_amount,recovery_mode,requested_installments,approved_installments,reason,needed_by")
    .eq("company_id", account.companyId).eq("status", "pending").in("id", steps.data.map(step => step.request_id));
  if (requests.error) throw new Error(requests.error.message);
  return (requests.data ?? []).map(row => {
    const step = steps.data.find(item => item.request_id === row.id)!;
    return { id: step.id, requestId: row.id, requestNumber: row.request_number, workerName: row.worker_name,
      workerCode: row.worker_code ?? "", stepName: step.step_name, stepType: step.step_type, requestedAmount: Number(row.requested_amount),
      approvedAmount: row.approved_amount == null ? null : Number(row.approved_amount), recoveryMode: row.recovery_mode,
      installments: row.approved_installments ?? row.requested_installments, reason: row.reason, neededBy: row.needed_by };
  });
}

export async function decideConnectPayAdvanceApproval(account: ConnectAccount, requestId: string, action: unknown, note: unknown, amount?: unknown, installments?: unknown) {
  const decision = payAdvanceDecision(action, note);
  const actorIds = await resolveConnectActorUserIds(account);
  if (!actorIds.length) throw new Error("This pay advance is not assigned to your account.");
  // Resolve the actor from the authenticated account and its exact pending step.
  // Never trust a caller-supplied approver ID or a company-wide role alone.
  const step = await db().from("hr_pay_advance_steps").select("id,approver_user_id,step_type")
    .eq("company_id", account.companyId).eq("request_id", requestId).eq("status", "pending")
    .in("approver_user_id", actorIds).limit(1).maybeSingle();
  if (step.error) throw new Error(step.error.message);
  if (!step.data) throw new Error("This pay advance is no longer assigned to your account.");
  let terms: ReturnType<typeof payAdvanceFinanceTerms> | null = null;
  if (step.data.step_type === "finance" && decision.decision === "approved") {
    const request = await db().from("hr_pay_advance_requests").select("requested_amount")
      .eq("company_id", account.companyId).eq("id", requestId).eq("status", "pending").maybeSingle();
    if (request.error) throw new Error(request.error.message);
    if (!request.data) throw new Error("This pay advance is no longer pending.");
    terms = payAdvanceFinanceTerms(amount, installments, Number(request.data.requested_amount));
  }
  const result = await db().rpc("hr_decide_pay_advance_step", {
    p_company_id: account.companyId, p_request_id: requestId, p_actor_user_id: step.data.approver_user_id,
    p_decision: decision.decision, p_note: decision.note, p_approved_amount: terms?.approvedAmount ?? null, p_approved_installments: terms?.approvedInstallments ?? null
  });
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
