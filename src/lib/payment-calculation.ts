export const PAYMENT_CALCULATION_TYPES = [
  { value: "manual_input", label: "Use the configured value" },
  { value: "count_x_rate", label: "Shipment count x rate" },
  { value: "fixed_daily", label: "Fixed amount per eligible day" },
  { value: "fixed_monthly", label: "Fixed amount per month" },
  { value: "percentage", label: "Percentage of a source value" },
  { value: "eligibility_bonus", label: "Pay only when eligible" }
] as const;

export const PAYMENT_CALCULATION_SOURCES = [
  { value: "amazon_delivery", label: "Amazon delivery count" },
  { value: "swa_delivery", label: "SWA delivery count" },
  { value: "total_delivery", label: "Total delivery (Amazon + SWA)" },
  { value: "customer_return", label: "Customer return count" },
  { value: "mfn_forward", label: "MFN forward count" },
  { value: "mfn_return", label: "MFN return count" },
  { value: "total_activity", label: "Total shipment activity" },
  { value: "attendance_eligibility", label: "Attendance eligibility" },
  { value: "performance_metric", label: "Performance metric" }
] as const;

export type PaymentCalculationType = typeof PAYMENT_CALCULATION_TYPES[number]["value"];
export type PaymentCalculationSource = typeof PAYMENT_CALCULATION_SOURCES[number]["value"];

export function calculationNeedsSource(type: PaymentCalculationType) {
  return type === "count_x_rate" || type === "percentage" || type === "eligibility_bonus";
}

export function calculatePaymentField({
  calculationType,
  configuredValue,
  sourceValue = 0,
  eligibleDays = 0
}: {
  calculationType: PaymentCalculationType;
  configuredValue: number;
  sourceValue?: number;
  eligibleDays?: number;
}) {
  const value = Number.isFinite(configuredValue) ? configuredValue : 0;
  const source = Number.isFinite(sourceValue) ? sourceValue : 0;

  switch (calculationType) {
    case "count_x_rate":
      return source * value;
    case "fixed_daily":
      return Math.max(0, eligibleDays) * value;
    case "fixed_monthly":
      return value;
    case "percentage":
      return source * value / 100;
    case "eligibility_bonus":
      return source > 0 ? value : 0;
    case "manual_input":
    default:
      return value;
  }
}

