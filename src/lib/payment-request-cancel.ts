type CancellableRequest = {
  requested_by: string | null;
  status: string | null;
  approval_status: string | null;
};

export type CancelEligibility = { allowed: true } | { allowed: false; reason: string };

function isReturned(request: CancellableRequest) {
  return String(request.status ?? "").toLowerCase() === "returned" ||
    String(request.approval_status ?? "").toUpperCase() === "RETURNED";
}

/**
 * A requester may cancel their own request while nobody has approved it yet, or once it has been
 * returned to them (e.g. returned as a duplicate). Anything approved, in processing, paid, rejected
 * or already cancelled can't be cancelled.
 */
export function paymentRequestCancelEligibility(
  request: CancellableRequest,
  userId: string,
  hasAnyApproval: boolean
): CancelEligibility {
  if (request.requested_by !== userId) return { allowed: false, reason: "Only the person who raised this request can cancel it." };
  const status = String(request.status ?? "").toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  const closed = ["CANCELLED", "REJECTED", "PROCESSING", "PROCESSED", "APPROVED"];
  if (closed.includes(status) || closed.includes(approvalStatus)) {
    return { allowed: false, reason: "This request is already closed or with Finance, so it can't be cancelled." };
  }
  if (isReturned(request)) return { allowed: true };
  if (hasAnyApproval || approvalStatus.endsWith("_APPROVED") || status.endsWith("_APPROVED")) {
    return { allowed: false, reason: "An approver has already approved this request, so it can't be cancelled." };
  }
  return { allowed: true };
}
