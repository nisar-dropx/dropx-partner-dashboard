export const PAYMENT_CALCULATION_TYPES = [
  { value: "manual_input", label: "Use the configured value" },
  { value: "count_x_rate", label: "Production count x individual rate" }
] as const;

export const AMAZON_PAYMENT_CALCULATION_SOURCES = [
  { value: "amazon_delivery", label: "Amazon Delivery" },
  { value: "swa_delivery", label: "SWA Delivery" },
  { value: "total_delivery", label: "Total Delivery" },
  { value: "customer_return", label: "Customer Return" },
  { value: "seller_pickup", label: "Seller Pickup" },
  { value: "seller_return", label: "Seller Return" }
] as const;

// Flipkart count sources will be added when its normalized report columns are finalized.
export const FLIPKART_PAYMENT_CALCULATION_SOURCES = [] as const;

export const INTERNAL_PAYMENT_CALCULATION_SOURCES = [
  { value: "attendance_bonus", label: "Attendance Bonus" },
  { value: "performance_incentive", label: "Performance Incentive" },
  { value: "joining_bonus", label: "Joining Bonus" },
  { value: "referral_incentive", label: "Referral Incentive" },
  { value: "manual_adjustment", label: "Manual Adjustment" }
] as const;

export const PAYMENT_CALCULATION_SOURCES = AMAZON_PAYMENT_CALCULATION_SOURCES;

export type PaymentCalculationType = typeof PAYMENT_CALCULATION_TYPES[number]["value"];
export type PaymentCalculationSource = typeof PAYMENT_CALCULATION_SOURCES[number]["value"];
export type InternalPaymentCalculationSource = typeof INTERNAL_PAYMENT_CALCULATION_SOURCES[number]["value"];

export type ProviderCalculationSources = {
  amazon?: PaymentCalculationSource | null;
  flipkart?: string | null;
  internal?: InternalPaymentCalculationSource | null;
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

