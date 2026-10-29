import {loadCurrentAdvanceCapacity} from "./connect-advance-context";
import "server-only";
import type { ConnectAccount } from "./connect-auth";
import {
  adoptPendingStepForHigherManager,
  resolveConnectActorUserIds,
  resolveConnectVisibleApproverUserIds
} from "./connect-approver-identity";
import { payAdvanceApprovalPayContext, payAdvanceDecision, payAdvanceFinanceTerms, type PayAdvanceApproval } from "./connect-pay-advance-approval";
import { supabaseAdmin } from "./supabase-admin";

function db() { if (!supabaseAdmin) throw new Error("Database configuration is unavailable."); return supabaseAdmin; }

async function mapPayAdvanceRows(
  companyId: string,
  steps: Array<{ id: string; request_id: string; step_name: string; step_type: string }>,
  requests: Array<Record<string, unknown>>
): Promise<PayAdvanceApproval[]> {
  const month = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit"}).format(new Date()) + "-01";
  return Promise.all(requests.map(async (row) => {
    const result = await db().rpc("pay_advance_worker_summary", {
      p_company: companyId, p_worker_type: row.worker_type, p_worker: row.worker_id, p_month: month
    });
    if (result.error) throw new Error("Unable to verify the worker's paid advance history. Please retry.");
    const history = result.data;
    const live = await loadCurrentAdvanceCapacity(companyId,String(row.id));
    const step = steps.find((item) => item.request_id === row.id)!;
    const pay = payAdvanceApprovalPayContext(row.worker_type, row.requested_amount, row.outstanding_pay_snapshot,
      row.eligibility_percent_snapshot, row.max_eligible_amount_snapshot);
    return {
      id: step.id,
      requestId: String(row.id),
      requestNumber: String(row.request_number),
      workerName: String(row.worker_name),
      workerCode: String(row.worker_code ?? ""),
      stepName: step.step_name,
      stepType: step.step_type,
      requestedAmount: Number(row.requested_amount),
      approvedAmount: row.approved_amount == null ? null : Number(row.approved_amount),
      ...pay,
      outstandingPay:live.outstandingPay,
      maxEligibleAmount:Math.min(live.maxEligibleAmount,Number(row.max_eligible_amount_snapshot??row.requested_amount)),
      monthPaidCount: Number(history.monthPaidCount), monthPaidAmount: Number(history.monthPaidAmount),
      outstandingAdvance: Number(history.outstandingAdvance), reservedRecovery: Number(history.reservedRecovery),
      recoveryMode: String(row.recovery_mode),
      installments: Number(row.approved_installments ?? row.requested_installments),
      reason: String(row.reason),
      neededBy: row.needed_by == null ? null : String(row.needed_by)
    };
  }));
}

const REQUEST_SELECT = "id,request_number,worker_type,worker_id,worker_name,worker_code,requested_amount,approved_amount,outstanding_pay_snapshot,eligibility_percent_snapshot,max_eligible_amount_snapshot,recovery_mode,requested_installments,approved_installments,reason,needed_by";

/** Only steps assigned to this login — not subordinates' queues. */
export async function listConnectPayAdvanceApprovals(account: ConnectAccount): Promise<PayAdvanceApproval[]> {
  const actorIds = await resolveConnectActorUserIds(account);
  if (!actorIds.length) return [];
  const steps = await db().from("hr_pay_advance_steps").select("id,request_id,step_name,step_type")
    .eq("company_id", account.companyId).in("approver_user_id", actorIds).eq("status", "pending").order("created_at");
  if (steps.error) throw new Error(steps.error.message);
  if (!steps.data?.length) return [];
  const requests = await db().from("hr_pay_advance_requests")
    .select(REQUEST_SELECT)
    .eq("company_id", account.companyId).eq("status", "pending").in("id", steps.data.map((step) => step.request_id));
  if (requests.error) throw new Error(requests.error.message);
  return mapPayAdvanceRows(account.companyId, steps.data, requests.data ?? []);
}

/**
 * Pending advances assigned to people below this manager on the reporting line.
 * Shown only under All team (not the assigned list), but still actionable.
 */
export async function listConnectPayAdvanceOversight(account: ConnectAccount): Promise<PayAdvanceApproval[]> {
  const [selfIds, visibleIds] = await Promise.all([
    resolveConnectActorUserIds(account),
    resolveConnectVisibleApproverUserIds(account)
  ]);
  const self = new Set(selfIds);
  const below = visibleIds.filter((id) => !self.has(id));
  if (!below.length) return [];
  const steps = await db().from("hr_pay_advance_steps").select("id,request_id,step_name,step_type")
    .eq("company_id", account.companyId).in("approver_user_id", below).eq("status", "pending").order("created_at");
  if (steps.error) throw new Error(steps.error.message);
  if (!steps.data?.length) return [];
  const requests = await db().from("hr_pay_advance_requests")
    .select(REQUEST_SELECT)
    .eq("company_id", account.companyId).eq("status", "pending").in("id", steps.data.map((step) => step.request_id));
  if (requests.error) throw new Error(requests.error.message);
  return mapPayAdvanceRows(account.companyId, steps.data, requests.data ?? []);
}

export async function decideConnectPayAdvanceApproval(account: ConnectAccount, requestId: string, action: unknown, note: unknown, amount?: unknown, installments?: unknown) {
  const decision = payAdvanceDecision(action, note);
  const actorIds = await resolveConnectActorUserIds(account);
  if (!actorIds.length) throw new Error("This pay advance is not assigned to your account.");
  // Higher managers may act from All team: adopt the subordinate's pending step first.
  await adoptPendingStepForHigherManager({
    companyId: account.companyId,
    actorUserId: actorIds[0],
    table: "hr_pay_advance_steps",
    parentColumn: "request_id",
    parentId: requestId
  });
  const pending = await db().from("hr_pay_advance_steps").select("step_type,approver_user_id")
    .eq("company_id", account.companyId).eq("request_id", requestId).eq("status", "pending")
    .in("approver_user_id", actorIds).order("step_order").limit(1).maybeSingle();
  if (pending.error) throw new Error(pending.error.message);
  const step = pending.data;
  if (!step) throw new Error("This pay advance is not assigned to you or is no longer pending.");
  let terms: ReturnType<typeof payAdvanceFinanceTerms> | null = null;
  if (decision.decision === "approved") {
    const request = await db().from("hr_pay_advance_requests").select("requested_amount,max_eligible_amount_snapshot,requested_installments")
      .eq("company_id", account.companyId).eq("id", requestId).eq("status", "pending").maybeSingle();
    if (request.error) throw new Error(request.error.message);
    if (!request.data) throw new Error("This pay advance is no longer pending.");
    const live = await loadCurrentAdvanceCapacity(account.companyId,requestId);
    const snapshotMaximum = step.step_type === "finance"
      ? Number(request.data.max_eligible_amount_snapshot ?? request.data.requested_amount)
      : Number(request.data.requested_amount);
    terms = payAdvanceFinanceTerms(
      amount,
      step.step_type === "finance" ? installments : request.data.requested_installments,
      Math.min(snapshotMaximum,live.maxEligibleAmount)
    );
  }
  const result = await db().rpc("hr_decide_pay_advance_step", {
    p_company_id: account.companyId, p_request_id: requestId, p_actor_user_id: step.approver_user_id,
    p_decision: decision.decision, p_note: decision.note, p_approved_amount: terms?.approvedAmount ?? null, p_approved_installments: terms?.approvedInstallments ?? null
  });
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
