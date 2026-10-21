/**
 * Assigned / allocated shipment counts for cps_shipment_daily.
 * Only persist a value when the source file actually provides one.
 * Never invent assigned from deliveries, attendance, or other proxies.
 */

export function parseOptionalAssignedCount(rawValue: unknown, columnPresent: boolean): number | null {
  if (!columnPresent) return null;
  const text = String(rawValue ?? "").trim().replace(/,/g, "");
  if (!text || text === "-") return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** True when the source row/header clearly supplied assigned (including explicit zero). */
export function assignedCountProvided(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * On reimport: keep the stored assigned count when the incoming batch did not
 * provide one. An explicit incoming zero replaces a previous positive value.
 */
export function mergeAssignedOnReimport(incoming: number | null | undefined, existing: number | null | undefined): number {
  if (assignedCountProvided(incoming)) return incoming;
  const prior = Number(existing);
  if (Number.isFinite(prior) && prior > 0) return prior;
  return assignedCountProvided(existing) ? existing : 0;
}

/** Delivery success % only when the denominator is trustworthy (assigned > 0). */
export function deliverySuccessPercent(delivered: number, assigned: number): number | null {
  const d = Number(delivered) || 0;
  const a = Number(assigned) || 0;
  if (!(a > 0)) return null;
  return (d / a) * 100;
}
