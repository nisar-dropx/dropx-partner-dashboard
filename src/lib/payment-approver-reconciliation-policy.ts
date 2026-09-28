export type PersistedPaymentApprover = {
  current_approver_role_id: string | null;
  current_approver_user_id: string | null;
  current_step_order: number | null;
};

export type ResolvedPaymentApprover = {
  roleId: string;
  userId: string;
};

export function paymentApproverNeedsReconciliation(
  request: PersistedPaymentApprover,
  resolved: ResolvedPaymentApprover | null,
  resolvedStepOrder: number
) {
  if (!resolved) return Boolean(request.current_approver_user_id || request.current_approver_role_id);
  return request.current_approver_user_id !== resolved.userId ||
    request.current_approver_role_id !== resolved.roleId ||
    request.current_step_order !== resolvedStepOrder;
}
