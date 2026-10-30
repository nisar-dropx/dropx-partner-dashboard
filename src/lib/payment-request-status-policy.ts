const paymentRequestLifecycleStatuses = new Set([
  "draft",
  "pending",
  "approved",
  "processing",
  "processed",
  "rejected",
  "returned",
  "cancelled",
  "resubmitted"
]);

export function canonicalPaymentRequestStatus(value: unknown) {
  if (typeof value !== "string") return value;
  const status = value.trim();
  const lifecycleStatus = status.toLowerCase();
  return paymentRequestLifecycleStatuses.has(lifecycleStatus) ? lifecycleStatus : status;
}

export function paymentRequestUpdateAttempts(
  updatePayload: Record<string, unknown>,
  fallbackPayload?: Record<string, unknown>
) {
  return [updatePayload, fallbackPayload]
    .filter((payload): payload is Record<string, unknown> => Boolean(payload))
    .map((payload) => {
      const status = canonicalPaymentRequestStatus(payload.status);
      return status === payload.status ? payload : { ...payload, status };
    });
}
