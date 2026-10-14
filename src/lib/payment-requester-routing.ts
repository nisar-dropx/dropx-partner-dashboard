import type { ApprovalStage, StageTarget } from './payment-stage-policy';

/** Remove only stages assigned to the requester, never missing required stages.
 * The final configured stage must still have an independent approver. */
export async function requesterSafeSteps<T extends ApprovalStage>(
  steps: T[], requesterId: string,
  resolve: (step: T, excludedUserId?: string) => Promise<StageTarget>
) {
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order);
  const retained: T[] = [];
  const skipped: { step_order: number; role_id: string; reason: 'requester_is_approver' }[] = [];
  for (const step of ordered) {
    const original = await resolve(step);
    if (original?.userId === requesterId) {
      const alternative = await resolve(step, requesterId);
      if (!alternative) {
        if (step === ordered.at(-1)) throw new Error('An independent final approver is required. Ask an administrator to update Payment Approvals.');
        skipped.push({ step_order: step.step_order, role_id: original.roleId, reason: 'requester_is_approver' });
        continue;
      }
    }
    retained.push(step);
  }
  return { steps: retained.map((step, index) => ({ ...step, step_order: index + 1 })), skipped };
}

export type PaymentApprovalOrigin = {
  requester_id: string;
  requester_role_id: string | null;
  original_step_count: number;
  skipped: { step_order: number; role_id: string; reason: string }[];
};
