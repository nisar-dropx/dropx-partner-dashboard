function normalizedIds(values: readonly unknown[]) {
  return values.map((value) => String(value ?? "").trim()).filter(Boolean);
}

export function paymentMethodComponentOrderChanged(
  existingPaymentFieldIds: readonly unknown[],
  nextPaymentFieldIds: readonly unknown[]
) {
  const existing = normalizedIds(existingPaymentFieldIds);
  const next = normalizedIds(nextPaymentFieldIds);
  return existing.length !== next.length
    || existing.some((id, index) => id !== next[index]);
}

export function assertMappedPaymentMethodComponentsUnchanged(input: {
  mappingCount: number;
  existingPaymentFieldIds: readonly unknown[];
  nextPaymentFieldIds: readonly unknown[];
}) {
  if (input.mappingCount <= 0) return;
  if (!paymentMethodComponentOrderChanged(input.existingPaymentFieldIds, input.nextPaymentFieldIds)) return;
  throw new Error(
    "Payment fields and their order cannot be changed after this method is assigned. Create a new payment method so earlier payouts stay unchanged."
  );
}

export function assertPaymentCalculationMetadataEditable(input: {
  mappingCount: number;
  subject: "payment field" | "provider production count";
}) {
  if (input.mappingCount <= 0) return;
  const label = input.subject === "payment field" ? "payment field" : "provider production count";
  throw new Error(
    `This ${label} is used by an assigned payment method. Create a new ${label} so earlier payouts stay unchanged.`
  );
}
