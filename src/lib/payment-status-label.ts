export type PaymentStatusLike = {
  status?: string | null;
  approval_status?: string | null;
  current_approver_user_id?: string | null;
  current_approver_role_id?: string | null;
  current_approver_role_ids?: string[] | null;
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

  if (effectiveStatus === "RESUBMITTED" || effectiveStatus.startsWith("RE_")) return "Resubmitted";
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
  if (effectiveStatus === "APPROVED") return hasCurrentApprover ? "Final Approval Pending" : "Final Approved";
  if (effectiveStatus.endsWith("_APPROVED")) return hasCurrentApprover ? "Initial Approved" : "Final Approved";
  if (effectiveStatus === "PENDING") return "Pending Initial Approval";

  return effectiveStatus
    ? effectiveStatus.toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
    : "-";
}
