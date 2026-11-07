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
