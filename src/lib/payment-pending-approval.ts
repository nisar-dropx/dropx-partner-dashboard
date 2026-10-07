/** Shared by the approvals queue and command center; workspace selection is not an access filter. */
export function isPendingPaymentApproval(request: {
  status?: string | null; approval_status?: string | null;
  current_approver_user_id?: string | null; current_approver_role_id?: string | null;
  current_approver_role_ids?: string[] | null;
}) {
  const status = String(request.approval_status || request.status || '').trim().toUpperCase();
  if (['RE_APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'PROCESSING', 'PROCESSED'].includes(status)) return false;
  return Boolean(request.current_approver_user_id || request.current_approver_role_id || request.current_approver_role_ids?.length || ['PENDING', 'RESUBMITTED', 'RE_PENDING'].includes(status));
}
