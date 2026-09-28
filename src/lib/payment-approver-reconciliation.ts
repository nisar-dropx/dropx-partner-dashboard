import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadApprovalSteps, resolveStepApprover } from "@/lib/payment-approval-steps";
import { effectiveApprovalStepOrder, isPendingPaymentApproval } from "@/lib/payment-stage-policy";
import { paymentApproverNeedsReconciliation } from "@/lib/payment-approver-reconciliation-policy";

type PendingPaymentRequest = {
  approval_status: string | null;
  company_id: string;
  current_approver_role_id: string | null;
  current_approver_user_id: string | null;
  current_step_order: number | null;
  id: string;
  location_id: string | null;
  payment_head_id: string | null;
  request_no: string;
  status: string | null;
};

export type PaymentApproverReconciliationResult = {
  checked: number;
  cleared: number;
  errors: Array<{ error: string; requestNo: string }>;
  reassigned: number;
};

/**
 * Re-resolves open payment approvals from the current People/product membership
 * source of truth. This prevents a request from remaining with a manager who
 * left, changed role, or lost the station after the request was created.
 */
export async function reconcilePendingPaymentApprovers(options: { companyId?: string; limit?: number } = {}) {
  const result: PaymentApproverReconciliationResult = { checked: 0, cleared: 0, errors: [], reassigned: 0 };
  if (!supabaseAdmin) return result;

  let query = supabaseAdmin
    .from("payment_requests")
    .select("id,request_no,company_id,location_id,payment_head_id,status,approval_status,current_step_order,current_approver_user_id,current_approver_role_id")
    .not("status", "in", "(approved,processed,processing,returned,rejected,cancelled)")
    .order("updated_at", { ascending: false })
    .limit(options.limit ?? 250);
  if (options.companyId) query = query.eq("company_id", options.companyId);
  const pendingResult = await query;
  if (pendingResult.error) throw new Error(pendingResult.error.message);

  const rows = ((pendingResult.data ?? []) as PendingPaymentRequest[])
    .filter(row => isPendingPaymentApproval(row.status, row.approval_status));
  const stepsCache = new Map<string, Awaited<ReturnType<typeof loadApprovalSteps>>>();
  const targetCache = new Map<string, Awaited<ReturnType<typeof resolveStepApprover>>>();

  for (const request of rows) {
    result.checked += 1;
    if (!request.payment_head_id || !request.location_id) continue;
    try {
      const stepsKey = `${request.company_id}:${request.payment_head_id}`;
      let steps = stepsCache.get(stepsKey);
      if (!steps) {
        steps = await loadApprovalSteps(request.company_id, request.payment_head_id);
        stepsCache.set(stepsKey, steps);
      }
      if (!steps.length) continue; // Preserve legacy two-phase requests.

      const resolvedStepOrder = effectiveApprovalStepOrder(
        steps,
        request.current_step_order ?? steps[0].step_order,
        request.current_approver_role_id
      );
      const step = steps.find(item => item.step_order === resolvedStepOrder);
      if (!step) continue;

      const targetKey = `${stepsKey}:${request.location_id}:${resolvedStepOrder}`;
      let target = targetCache.get(targetKey);
      if (target === undefined) {
        target = await resolveStepApprover(request.company_id, step, request.location_id);
        targetCache.set(targetKey, target);
      }
      if (!paymentApproverNeedsReconciliation(request, target, resolvedStepOrder)) continue;

      const now = new Date().toISOString();
      const update = target ? {
        current_approver_user_id: target.userId,
        current_approver_role_id: target.roleId,
        current_approver_role_ids: [target.roleId],
        current_step_order: resolvedStepOrder,
        email_next_reminder_at: null,
        updated_at: now
      } : {
        approval_status: "NO_APPROVER_CONFIGURED",
        current_approver_user_id: null,
        current_approver_role_id: null,
        current_approver_role_ids: [],
        current_step_order: resolvedStepOrder,
        email_next_reminder_at: null,
        updated_at: now
      };
      let updateQuery = supabaseAdmin.from("payment_requests").update(update)
        .eq("company_id", request.company_id)
        .eq("id", request.id)
        .eq("current_step_order", request.current_step_order ?? resolvedStepOrder);
      updateQuery = request.current_approver_user_id
        ? updateQuery.eq("current_approver_user_id", request.current_approver_user_id)
        : updateQuery.is("current_approver_user_id", null);
      const saved = await updateQuery.select("id").maybeSingle();
      if (saved.error) throw new Error(saved.error.message);
      if (!saved.data) continue; // Another action advanced the request concurrently.

      if (target) result.reassigned += 1; else result.cleared += 1;
    } catch (error) {
      result.errors.push({ requestNo: request.request_no, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}
