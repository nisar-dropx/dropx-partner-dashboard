export const cpsViews = {
  overview: { label: "Overview", permission: "cps_overview" },
  daily: { label: "Daily CPS", permission: "cps_daily" },
  monthly: { label: "Monthly CPS", permission: "cps_monthly" },
  mtd: { label: "MTD CPS", permission: "cps_monthly" },
  stations: { label: "Stations", permission: "cps_stations" },
  breakup: { label: "Cost breakup", permission: "cps_cost_breakup" },
  shipments: { label: "Shipments", permission: "cps_shipments" },
  associates: { label: "DA productivity", permission: "cps_associates" },
  unmapped: { label: "Needs attention", permission: "cps_unmapped" },
  reports: { label: "Reports", permission: "cps_reports" },
  inputs: { label: "Cost setup", permission: "cps_inputs" },
} as const;
export type CpsView = keyof typeof cpsViews;
export type CpsParams = {
  view?: string;
  period?: string;
  date?: string;
  month?: string;
  station?: string;
  cluster?: string;
  region?: string;
  page?: string;
};
export const cpsHeads = ["DA", "UTR", "Van", "Rent", "Overhead", "Other"] as const;
export type CpsHead = (typeof cpsHeads)[number];
export function cpsView(value?: string): CpsView {
  return value && Object.hasOwn(cpsViews, value)
    ? (value as CpsView)
    : "overview";
}
export function isoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^20\d\d-\d\d-\d\d$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export function cpsPeriod(params: CpsParams, today: string) {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  const date =
    isoDate(params.date) && params.date <= today ? params.date : yesterday;
  const view = cpsView(params.view);
  const mode =
    view === "daily"
      ? "daily"
      : view === "monthly"
        ? "monthly"
        : view === "mtd"
          ? "mtd"
          : ["daily", "monthly", "mtd"].includes(params.period ?? "")
            ? params.period!
            : "mtd";
  const month =
    /^20\d\d-(0[1-9]|1[0-2])$/.test(params.month ?? "") &&
    params.month! <= today.slice(0, 7)
      ? params.month!
      : date.slice(0, 7);
  const end = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10);
  const from =
    mode === "daily"
      ? date
      : mode === "monthly"
        ? `${month}-01`
        : `${date.slice(0, 7)}-01`;
  const to = mode === "monthly" ? (end > today ? today : end) : date;
  return {
    mode,
    date,
    month,
    from,
    to,
    days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1,
  };
}
export type CpsDay = {
  station_code: string;
  work_date: string;
  deliveries: number;
  activity: number;
  amazon_delivery: number;
  swa_delivery: number;
  c_return: number;
  mfn: number;
  mfn_return: number;
  associate_rows: number;
  unmapped: number;
  unpaid: number;
  da: number;
  utr: number;
  van: number;
  other: number;
  rent: number;
  overhead?: number;
  da_salary?: number;
  da_variable?: number;
  da_fuel?: number;
  exposed_deliveries?: number;
  cost_gaps?: number;
  total: number;
  target: number | null;
  shipment_present: boolean;
  utr_configured: boolean;
  updated_at: string | null;
};
export type CpsLine = {
  station_code: string;
  work_date: string;
  head: CpsHead;
  sub_head: string;
  source: string;
  amount: number;
};
export type CpsSnapshot = {
  daily: CpsDay[];
  breakup: CpsLine[];
  generated_at: string;
  associates?: import("./cps-engine").LiveAssociate[];
  gaps?: import("./cps-engine").CpsGap[];
  people?: import("./cps-engine").CpsPersonCost[];
};
export function ratio(cost: number, deliveries: number) {
  return deliveries > 0 ? cost / deliveries : null;
}
export function summarizeCps(rows: CpsDay[]) {
  const totals = rows.reduce(
    (a, r) => ({
      deliveries: a.deliveries + Number(r.deliveries),
      activity: a.activity + Number(r.activity),
      amazon: a.amazon + Number(r.amazon_delivery ?? 0),
      swa: a.swa + Number(r.swa_delivery ?? 0),
      returns: a.returns + Number(r.c_return ?? 0),
      mfn: a.mfn + Number(r.mfn ?? 0),
      mfnReturn: a.mfnReturn + Number(r.mfn_return ?? 0),
      associateDays: a.associateDays + Number(r.associate_rows),
      da: a.da + Number(r.da),
      utr: a.utr + Number(r.utr),
      van: a.van + Number(r.van),
      other: a.other + Number(r.other),
      rent: a.rent + Number(r.rent),
      overhead: a.overhead + Number(r.overhead ?? 0),
      salary: a.salary + Number(r.da_salary ?? 0),
      variable: a.variable + Number(r.da_variable ?? 0),
      fuel: a.fuel + Number(r.da_fuel ?? 0),
      exposedDeliveries: a.exposedDeliveries + Number(r.exposed_deliveries ?? 0),
      costGaps: a.costGaps + Number(r.cost_gaps ?? 0),
      total: a.total + Number(r.total),
      unmapped: a.unmapped + Number(r.unmapped),
      unpaid: a.unpaid + Number(r.unpaid),
      missingDays: a.missingDays + (r.shipment_present ? 0 : 1),
      missingUtr: a.missingUtr + (r.utr_configured ? 0 : 1),
      targetedVolume:
        a.targetedVolume + (r.target == null ? 0 : Number(r.deliveries)),
      targetCost:
        a.targetCost +
        (r.target == null ? 0 : Number(r.target) * Number(r.deliveries)),
    }),
    {
      deliveries: 0,
      activity: 0,
      amazon: 0,
      swa: 0,
      returns: 0,
      mfn: 0,
      mfnReturn: 0,
      associateDays: 0,
      da: 0,
      utr: 0,
      van: 0,
      other: 0,
      rent: 0,
      overhead: 0, salary: 0, variable: 0, fuel: 0, exposedDeliveries: 0, costGaps: 0,
      total: 0,
      unmapped: 0,
      unpaid: 0,
      missingDays: 0,
      missingUtr: 0,
      targetedVolume: 0,
      targetCost: 0,
    },
  );
  const cps = ratio(totals.total, totals.deliveries);
  const target =
    totals.targetedVolume === totals.deliveries
      ? ratio(totals.targetCost, totals.deliveries)
      : null;
  const provisional = Boolean(
    totals.missingDays || totals.unmapped || totals.unpaid || totals.missingUtr || totals.costGaps,
  );
  return {
    ...totals,
    cps,
    target,
    provisional,
    gap: target == null || cps == null ? null : cps - target,
    impact:
      target == null || cps == null ? null : totals.total - totals.targetCost,
  };
}
export function groupCps(rows: CpsDay[], key: (row: CpsDay) => string) {
  const groups = new Map<string, CpsDay[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k) ?? [];
    group.push(row);
    groups.set(k, group);
  }
  return [...groups].map(([key, days]) => ({
    key,
    days,
    ...summarizeCps(days),
  }));
}
export function cpsIssues(row: ReturnType<typeof summarizeCps>) {
  return [
    row.missingDays ? `${row.missingDays} station-days missing shipments` : "",
    row.unmapped ? `${row.unmapped} associate-days missing payment setup` : "",
    row.unpaid ? `${row.unpaid} configured associate-days with no payout` : "",
    row.missingUtr ? "People CTC / station staff coverage needs review" : "",
    row.costGaps ? "Workforce or cost allocation issues need attention" : "",
    row.target == null ? "Target not configured for all deliveries" : "",
  ].filter(Boolean);
}
export type CpsCostInput = {
  id: string;
  label: string;
  sub_head?: string | null;
  employee_id?: string | null;
  head: CpsHead;
  station_codes: string[];
  amount: number;
  frequency: "monthly" | "once";
  allocation: "equal" | "delivery_share";
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  updated_at: string;
  notes: string | null;
};
export function validateCostInput(
  raw: Record<string, unknown>,
  permitted: string[],
) {
  const label = String(raw.label ?? "").trim();
  const stations = [
    ...new Set(
      String(raw.station_codes ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const amountText = String(raw.amount ?? "").trim();
  if (!label || label.length > 120)
    throw Error("Enter a cost name (up to 120 characters).");
  if (
    !stations.length ||
    stations.length > 150 ||
    stations.some((s) => !permitted.includes(s))
  )
    throw Error("Choose locations within your access.");
  if (!cpsHeads.includes(raw.head as CpsHead))
    throw Error("Choose a valid cost head.");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(amountText))
    throw Error("Enter a non-negative amount with up to 2 decimals.");
  if (
    !["monthly", "once"].includes(String(raw.frequency)) ||
    !["equal", "delivery_share"].includes(String(raw.allocation))
  )
    throw Error("Choose a valid frequency and allocation.");
  if (
    !isoDate(raw.effective_from) ||
    (raw.effective_to &&
      (!isoDate(raw.effective_to) || raw.effective_to < raw.effective_from))
  )
    throw Error("Choose a valid effective period.");
  if (
    raw.frequency === "once" &&
    raw.effective_to &&
    raw.effective_to !== raw.effective_from
  )
    throw Error("One-off costs use the effective-from date only.");
  const notes = String(raw.notes ?? "").trim();
  if (notes.length > 500) throw Error("Notes must be 500 characters or fewer.");
  const employee = String(raw.employee_id ?? "").trim();
  if (employee && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employee)) throw Error("Choose a valid People employee.");
  if (employee && raw.frequency !== "monthly") throw Error("People CTC accrues monthly.");
  const sub = String(raw.sub_head ?? "").trim();
  if (sub.length > 120) throw Error("Cost breakup name must be 120 characters or fewer.");
  return {
    label,
    sub_head: sub || label,
    employee_id: employee || null,
    head: raw.head as CpsHead,
    station_codes: stations,
    amount: Number(amountText),
    frequency: raw.frequency as CpsCostInput["frequency"],
    allocation: raw.allocation as CpsCostInput["allocation"],
    effective_from: raw.effective_from,
    effective_to: raw.effective_to || null,
    notes: notes || null,
    is_active: raw.is_active !== false,
  };
}
