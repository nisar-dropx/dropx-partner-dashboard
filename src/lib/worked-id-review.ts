export const workedIdMetrics = [
  "total_delivery",
  "amazon_delivery",
  "swa_delivery",
  "c_return",
  "mfn",
  "mfn_return",
  "assigned_count",
  "delivery_assigned_count",
  "pickup_assigned_count",
] as const;
// Match ID Mapping's payable production categories. Amazon/SWA are parts of
// Delivery, never additional work to enter or add to the payable total.
export const workedIdPaymentMetrics = [
  "total_delivery", "c_return", "mfn", "mfn_return",
] as const;
export const workedIdPaymentLabels = {
  total_delivery: "Delivery (including SWA)",
  c_return: "C-return",
  mfn: "MFN",
  mfn_return: "MFN return",
} as const;
export const workedIdDeliveryRoles = ["DA", "DCD", "ODCD", "WM"];
export const workedIdSalaryCodes = [
  "MG_PER_DAY",
  "MG_PER_MONTH",
  "FIXED_PAY_PER_DAY",
  "FIXED_PAY_PER_MONTH",
];
export function hasWorkedIdFixedSalary(
  components: any[],
  values: Record<string, unknown>,
) {
  return components.some(
    (c) =>
      c.is_active !== false &&
      c.active !== false &&
      (c.component_type || c.type) === "amount" &&
      workedIdSalaryCodes.includes(c.component_code || c.code) &&
      Number(values[c.component_code || c.code]) > 0,
  );
}
export type WorkedMetric = (typeof workedIdMetrics)[number];
export function workedIdCounts(row: Record<string, unknown>) {
  return Object.fromEntries(
    workedIdMetrics.map((k) => [k, Number(row[k] ?? 0)]),
  ) as Record<WorkedMetric, number>;
}
/** Allocate internal source counters proportionally when the combined work
 * changes. These are accounting shares, not shipment-level attribution. Work
 * already allocated to another review is excluded from `available` by callers.
 * Preserve existing breakdowns when their corresponding work count is unchanged.
 */
export function updateWorkedIdPaymentShare(
  available: Record<WorkedMetric, number>,
  previous: Record<WorkedMetric, number>,
  metric: (typeof workedIdPaymentMetrics)[number],
  value: number,
) {
  const share = { ...previous, [metric]: value };
  if (previous[metric] === value) return share;
  // Keep invalid input visible for validation; do not conceal an over-allocation.
  if (!Number.isInteger(value) || value < 0 || value > available[metric]) return share;
  const portion = (count: number, selected: number, total: number) =>
    total > 0 ? Math.min(count, Math.round(count * selected / total)) : 0;
  if (metric === "total_delivery") {
    share.amazon_delivery = portion(available.amazon_delivery, value, available.total_delivery);
    share.swa_delivery = available.amazon_delivery + available.swa_delivery === available.total_delivery
      ? value - share.amazon_delivery
      : portion(available.swa_delivery, value, available.total_delivery);
    share.delivery_assigned_count = portion(available.delivery_assigned_count, value, available.total_delivery);
  }
  const pickups = (counts: Record<WorkedMetric, number>) => counts.c_return + counts.mfn + counts.mfn_return;
  if (metric !== "total_delivery") {
    share.pickup_assigned_count = portion(available.pickup_assigned_count, pickups(share), pickups(available));
  }
  share.assigned_count = portion(available.assigned_count,
    share.total_delivery + pickups(share), available.total_delivery + pickups(available));
  return share;
}
export function workedIdShareError(
  available: Record<WorkedMetric, number>,
  share: Record<WorkedMetric, number>,
  ownerWorked: boolean | null,
) {
  if (ownerWorked === null)
    return "Confirm whether the mapped associate also worked.";
  for (const k of workedIdMetrics) {
    if (!Number.isInteger(share[k]) || share[k] < 0 || share[k] > available[k])
      return `Enter a whole ${k.replaceAll("_", " ")} count between 0 and ${available[k]}.`;
    if (!ownerWorked && share[k] !== available[k])
      return "Assign all remaining work when the mapped associate did not work.";
  }
  if (share.total_delivery <= 0)
    return "Enter this associate’s delivery count.";
  if (
    available.amazon_delivery + available.swa_delivery ===
      available.total_delivery &&
    share.amazon_delivery + share.swa_delivery !== share.total_delivery
  )
    return "Amazon plus SWA must equal the delivery share.";
  return null;
}
export const workedIdKey = (worker: string, date: string) =>
  `${worker}|${date}`;
export function workedIdErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (/<(?:!doctype|html|head|body)\b/i.test(message) || /SSL handshake|fetch failed/i.test(message))
    return "The database connection is temporarily unavailable. Refresh and try again.";
  return message;
}
export function workedIdMonth(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw Error("Select a valid month.");
  let [y, m] = month.split("-").map(Number);
  return {
    from: month + "-01",
    to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
  };
}
