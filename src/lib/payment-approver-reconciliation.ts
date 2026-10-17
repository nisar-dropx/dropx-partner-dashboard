import { readAllRows } from "@/lib/supabase-pagination";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { advanceApproval, loadApprovalSteps, resolveStepApprover } from "@/lib/payment-approval-steps";
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
  adhoc_approval_steps: unknown;
  approval_routing_reason: string | null;
  updated_at: string | null;
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
    .select("id,request_no,company_id,location_id,payment_head_id,status,approval_status,current_step_order,current_approver_user_id,current_approver_role_id,adhoc_approval_steps,approval_routing_reason,updated_at")
    .not("status", "in", "(approved,processed,processing,returned,rejected,cancelled)")
    .order("id");
  if (options.companyId) query = query.eq("company_id", options.companyId);
  const pendingResult = options.limit ? await query.limit(options.limit) : await readAllRows(query);
  if (pendingResult.error) throw new Error(pendingResult.error.message);

  const rows = ((pendingResult.data ?? []) as PendingPaymentRequest[])
    .filter(row => isPendingPaymentApproval(row.status, row.approval_status));
  const stepsCache = new Map<string, Awaited<ReturnType<typeof loadApprovalSteps>>>();
  const targetCache = new Map<string, Awaited<ReturnType<typeof resolveStepApprover>>>();

  for (const request of rows) {
    result.checked += 1;
    if (!request.payment_head_id || !request.location_id) continue;
    try {
      const stepsKey = `${request.company_id}:${request.payment_head_id}:${JSON.stringify(request.adhoc_approval_steps ?? null)}`;
      let steps = stepsCache.get(stepsKey);
      if (!steps) {
        steps = await loadApprovalSteps(request.company_id, request.payment_head_id, request.id);
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
      let targetStepOrder = resolvedStepOrder;
      if (!target && !step.is_required) {
        const advance = await advanceApproval(request.company_id, steps, resolvedStepOrder, request.location_id);
        if (advance.approver && advance.nextStepOrder) {
          target = {
            ...advance.approver,
            routingReason: `Optional approval stage skipped because no eligible approver is mapped; ${advance.approver.routingReason || "advanced to the next configured approval stage"}`
          };
          targetStepOrder = advance.nextStepOrder;
        } else if (advance.noApproverConfigured && advance.nextStepOrder) {
          targetStepOrder = advance.nextStepOrder;
        }
      }
      if (!paymentApproverNeedsReconciliation(request, target, targetStepOrder) && (!target?.routingReason || target.routingReason === request.approval_routing_reason)) continue;

      const now = new Date().toISOString();
      const update = target ? {
        ...(request.approval_status === "NO_APPROVER_CONFIGURED" ? { approval_status: "PENDING" } : {}),
        approval_routing_reason: target.routingReason || "Approver mapping refreshed",
        updated_by: null,
        current_approver_user_id: target.userId,
        current_approver_role_id: target.roleId,
        current_approver_role_ids: [target.roleId],
        current_step_order: targetStepOrder,
        email_next_reminder_at: null,
        updated_at: now
      } : {
        approval_status: "NO_APPROVER_CONFIGURED",
        approval_routing_reason: "No eligible approver: check required role, location access and leave cover",
        updated_by: null,
        current_approver_user_id: null,
        current_approver_role_id: null,
        current_approver_role_ids: [],
        current_step_order: targetStepOrder,
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
      updateQuery = request.updated_at ? updateQuery.eq("updated_at", request.updated_at) : updateQuery.is("updated_at", null);
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
