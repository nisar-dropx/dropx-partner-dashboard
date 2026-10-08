const WORKFORCE_PAYOUT_PUBLISHABLE_CALCULATION_STATUSES = new Set([
  "Ready for review",
  "No eligible accrual",
  "No eligible attendance",
  "Awaiting production"
]);

export function isWorkforcePayoutCalculationPublishable(status: unknown) {
  return WORKFORCE_PAYOUT_PUBLISHABLE_CALCULATION_STATUSES.has(String(status ?? "").trim());
}

export function isWorkforcePayoutDisplayPublishable(status: unknown) {
  const normalized = String(status ?? "").trim();
  return normalized === "Returned" || isWorkforcePayoutCalculationPublishable(normalized);
}
