/** Shared by the approvals queue and command center; workspace selection is not an access filter. */
export function isPendingPaymentApproval(request: {
  status?: string | null; approval_status?: string | null;
  current_approver_user_id?: string | null; current_approver_role_id?: string | null;
  current_approver_role_ids?: string[] | null;
}) {
  if (String(request.status ?? '').trim().toUpperCase() === 'APPROVED') return false;
  const status = String(request.approval_status || request.status || '').trim().toUpperCase();
  if (['FINAL_APPROVED', 'OWNER_APPROVED', 'RE_APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'PROCESSING', 'PROCESSED'].includes(status)) return false;
  return Boolean(request.current_approver_user_id || request.current_approver_role_id || request.current_approver_role_ids?.length || ['PENDING', 'RESUBMITTED', 'RE_PENDING', 'NO_APPROVER_CONFIGURED'].includes(status));
}
