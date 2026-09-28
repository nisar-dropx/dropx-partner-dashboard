export const PAYMENT_CALCULATION_TYPES = [
  { value: "manual_input", label: "Use the configured value" },
  { value: "count_x_rate", label: "Production count x individual rate" },
  { value: "fixed_daily", label: "Attendance units x daily or hourly rate" },
  { value: "fixed_monthly", label: "Monthly amount prorated by attendance" }
] as const;

export type PaymentCalculationType = typeof PAYMENT_CALCULATION_TYPES[number]["value"];
export type PaymentCalculationSource = string;

export const PAYMENT_CALCULATION_BASES = [
  { value: "attendance", label: "Attendance / worked time" },
  { value: "legacy", label: "Schedule default" },
  { value: "production", label: "Production count" }
] as const;

export type PaymentCalculationBasis = typeof PAYMENT_CALCULATION_BASES[number]["value"];

export function paymentCalculationBasis(input: {
  fieldType?: string | null;
  calculationType?: string | null;
  calculationSource?: string | null;
}): PaymentCalculationBasis {
  if (input.fieldType === "production" || input.calculationType === "count_x_rate") return "production";
  if (input.calculationSource === "attendance_eligibility") return "attendance";
  return "legacy";
}

export function attendanceCalculationType(schedule: string | null | undefined): PaymentCalculationType {
  return schedule === "per_month" ? "fixed_monthly" : "fixed_daily";
}

export type ProviderCalculationSources = {
  amazon?: string | null;
  flipkart?: string | null;
  internal?: string | null;
};

export function calculationNeedsSource(type: PaymentCalculationType) {
  return type === "count_x_rate";
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
    case "manual_input":
    default:
      return value;
  }
}
