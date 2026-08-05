export const PAYMENT_MODES = [
  { value: "account_transfer", label: "Account Transfer" },
  { value: "online_payment", label: "Online Payment" },
  { value: "upi_payment", label: "UPI Payment" }
] as const;

export type PaymentMode = (typeof PAYMENT_MODES)[number]["value"];

export const ALL_PAYMENT_MODES: PaymentMode[] = PAYMENT_MODES.map((mode) => mode.value);

export function normalizePaymentModes(value: unknown): PaymentMode[] {
  if (!Array.isArray(value)) return [...ALL_PAYMENT_MODES];
  const allowed = new Set<PaymentMode>(ALL_PAYMENT_MODES);
  return Array.from(new Set(value.filter((mode): mode is PaymentMode => allowed.has(mode as PaymentMode))));
}

export function paymentModeLabel(value: PaymentMode) {
  return PAYMENT_MODES.find((mode) => mode.value === value)?.label ?? value;
}
