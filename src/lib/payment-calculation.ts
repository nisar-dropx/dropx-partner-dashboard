export const PAYMENT_CALCULATION_TYPES = [
  { value: "manual_input", label: "Use the configured value" },
  { value: "count_x_rate", label: "Production count x individual rate" }
] as const;

export type PaymentCalculationType = typeof PAYMENT_CALCULATION_TYPES[number]["value"];
export type PaymentCalculationSource = string;

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

