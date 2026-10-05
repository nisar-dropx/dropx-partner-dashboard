import type { ProductionThresholdSnapshot } from "./production-threshold-snapshot.ts";

export type PaymentAllocationHistoryRate = {
  code: string;
  label: string;
  value: number;
};

export type PaymentAllocationHistoryEntry = {
  id: string;
  paymentMethodId: string;
  paymentMethodName: string;
  effectiveFrom: string;
  effectiveTo: string;
  storedStatus: string;
  sourceLabel?: string;
  subjectLabel?: string;
  locationLabel?: string;
  reason?: string;
  productionThreshold?: ProductionThresholdSnapshot | null;
  rates: PaymentAllocationHistoryRate[];
};

export type PaymentAllocationHistoryComponent = {
  code: string;
  label: string;
  sortOrder?: number;
};

export function paymentAllocationDisplayStatus(
  entry: Pick<PaymentAllocationHistoryEntry, "effectiveFrom" | "effectiveTo"> & Partial<Pick<PaymentAllocationHistoryEntry, "storedStatus">>,
  asOf: string
) {
  if (entry.storedStatus === "cancelled") return "Cancelled";
  if (entry.effectiveFrom > asOf) return "Scheduled";
  if (!entry.effectiveTo || entry.effectiveTo >= asOf) return "Current";
  return "Ended";
}

export function paymentAllocationHistoryRates(
  paymentValues: Record<string, unknown> | null | undefined,
  components: PaymentAllocationHistoryComponent[]
) {
  const values = paymentValues ?? {};
  const componentByCode = new Map(components.map((component) => [component.code.trim().toUpperCase(), component]));
  const orderedCodes = [
    ...components
      .slice()
      .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
      .map((component) => component.code),
    ...Object.keys(values).filter((code) => !componentByCode.has(code.trim().toUpperCase())).sort()
  ];
  const seen = new Set<string>();

  return orderedCodes.flatMap((code) => {
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode || seen.has(normalizedCode)) return [];
    seen.add(normalizedCode);
    const source = Object.entries(values).find(([key]) => key.trim().toUpperCase() === normalizedCode)?.[1];
    const value = Number(source);
    if (!Number.isFinite(value)) return [];
    const component = componentByCode.get(normalizedCode);
    return [{ code: normalizedCode, label: component?.label || code, value }];
  });
}

export function sortPaymentAllocationHistory(entries: PaymentAllocationHistoryEntry[]) {
  return entries.slice().sort((left, right) =>
    right.effectiveFrom.localeCompare(left.effectiveFrom)
    || right.effectiveTo.localeCompare(left.effectiveTo)
    || right.id.localeCompare(left.id)
  );
}

export function uniquePaymentAllocationHistory(entries: PaymentAllocationHistoryEntry[]) {
  return sortPaymentAllocationHistory([...new Map(entries.map((entry) => [entry.id, entry])).values()]);
}
