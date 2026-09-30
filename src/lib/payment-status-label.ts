export type PaymentStatusLike = {
  status?: string | null;
  approval_status?: string | null;
  current_approver_user_id?: string | null;
  current_approver_role_id?: string | null;
  current_approver_role_ids?: string[] | null;
  current_step_order?: number | null;
  total_steps?: number | null;
};

export function isResubmittedPaymentStage(request: PaymentStatusLike) {
  const status = String(request.status ?? "").trim().toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").trim().toUpperCase();
  return status === "RESUBMITTED" || status.startsWith("RE_") || approvalStatus === "RESUBMITTED" || approvalStatus.startsWith("RE_");
}

export function paymentStatusLabel(request: PaymentStatusLike) {
  const status = String(request.status ?? "").trim().toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").trim().toUpperCase();
  const effectiveStatus = approvalStatus || status;
  const currentStep = Number(request.current_step_order) || 0;
  const totalSteps = Number(request.total_steps) || 0;

  if (effectiveStatus === "RE_PENDING") return "Resubmitted - Initial Approval";
  if (effectiveStatus === "RE_CLUSTER_APPROVED") return "Resubmitted - Final Approval";
  if (effectiveStatus === "RE_APPROVED") return "Resubmitted - Payment Processing";
  if (effectiveStatus === "RESUBMITTED") return "Resubmitted";
  if (effectiveStatus === "PROCESSED") return "Processed";
  if (effectiveStatus === "PROCESSING") return "Processing";
  if (effectiveStatus === "RETURNED") return "Returned";
  if (effectiveStatus === "REJECTED") return "Rejected";
  if (effectiveStatus === "CANCELLED") return "Cancelled";

  const hasCurrentApprover = Boolean(
    request.current_approver_user_id ||
    request.current_approver_role_id ||
    request.current_approver_role_ids?.length
  );
  if (effectiveStatus === "APPROVED" || effectiveStatus.endsWith("_APPROVED")) {
    if (!hasCurrentApprover) return "Final Approved";
    if (totalSteps && currentStep >= totalSteps) return "Final Approval Pending";
    return "Approval In Progress";
  }
  if (effectiveStatus === "PENDING") return "Pending Initial Approval";

  return effectiveStatus
    ? effectiveStatus.toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
    : "-";
}
