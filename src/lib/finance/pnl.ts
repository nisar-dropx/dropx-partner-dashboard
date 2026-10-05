import { monthEnd, todayIndia } from "./pricing";
import {
  isoDate,
  cpsMonthSlices,
  cpsReviewItems,
  type CpsSnapshot,
} from "../ops-pulse/cps";
import type { BusinessRow } from "./performance";

export type PnlQuery = Record<string, string | string[] | undefined>;
export function pnlFilters(query: PnlQuery, today = todayIndia()) {
  const value = (k: string) =>
    typeof query[k] === "string" ? String(query[k]).trim().slice(0, 200) : "";
  const period = value("period") || (value("month") ? "month" : "mtd");
  const yesterday = new Date(Date.parse(today) - 86400000)
    .toISOString()
    .slice(0, 10);
  const previous = new Date(Date.parse(`${today.slice(0, 7)}-01`) - 86400000)
    .toISOString()
    .slice(0, 7);
  const month =
    period === "last-month" ? previous : value("month") || today.slice(0, 7);
  if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month) || month > today.slice(0, 7))
    throw Error("Choose a month no later than this month.");
  let from = `${month}-01`,
    to = monthEnd(month) < today ? monthEnd(month) : today;
  if (period === "mtd") {
    from = `${today.slice(0, 7)}-01`;
    to = today;
  }
  if (period === "today" || period === "yesterday")
    from = to = period === "today" ? today : yesterday;
  if (period === "custom") {
    from = value("from");
    to = value("to");
  }
  if (!isoDate(from) || !isoDate(to) || from > to || to > today)
    throw Error("Choose valid dates ending on or before today.");
  if (Date.parse(to) - Date.parse(from) > 365 * 86400000)
    throw Error("Choose up to one year at a time.");
  if (
    !["mtd", "month", "last-month", "today", "yesterday", "custom"].includes(
      period,
    )
  )
    throw Error("Choose a valid reporting period.");
  const provider = value("provider");
  if (provider && !["Amazon", "Flipkart"].includes(provider))
    throw Error("Choose a supported client.");
  return {
    period,
    from,
    to,
    month,
    provider,
    region: value("region"),
    cluster: value("cluster"),
    location: value("location"),
    includeXpts: value("includeXpts") !== "0",
  };
}
export { cpsMonthSlices };
export type PnlLocation = {
  station_code: string;
  station_name: string | null;
  region?: string | null;
  cluster?: string | null;
  parent_station_code?: string | null;
};
export type PnlDay = {
  station: string;
  name: string;
  region: string;
  date: string;
  revenue: number | null;
  cost: number | null;
  deliveries: number | null;
  base: number | null;
  variable: number | null;
  swa: number | null;
  mfn: number | null;
  da: number;
  utr: number;
  van: number;
  rent: number;
  other: number;
  issues: string[];
};
export type PnlTotal = {
  key: string;
  revenue: number | null;
  cost: number | null;
  profit: number | null;
  margin: number | null;
  deliveries: number | null;
  cps: number | null;
  rps: number | null;
  base: number | null;
  variable: number | null;
  swa: number | null;
  mfn: number | null;
  da: number;
  utr: number;
  van: number;
  rent: number;
  other: number;
  stations: number;
  stationDays: number;
  shipmentDays: number;
  revenueDays: number;
  costDays: number;
  issueDays: number;
  dataThrough: string | null;
};
const sumKnown = (values: (number | null)[]) =>
  values.every((v) => v === null)
    ? null
    : values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
const n = (v: string | null | undefined) => (v == null ? null : Number(v));
export function pnlTotal(rows: PnlDay[], key = "Business total"): PnlTotal {
  const sum = (
    field:
      | "revenue"
      | "cost"
      | "deliveries"
      | "base"
      | "variable"
      | "swa"
      | "mfn",
  ) => sumKnown(rows.map((r) => r[field]));
  const revenue = sum("revenue"),
    cost = sum("cost"),
    deliveries = sum("deliveries");
  const profit = revenue === null || cost === null ? null : revenue - cost;
  return {
    key,
    revenue,
    cost,
    profit,
    deliveries,
    margin: profit !== null && revenue ? (profit / revenue) * 100 : null,
    cps: cost !== null && deliveries ? cost / deliveries : null,
    rps: revenue !== null && deliveries ? revenue / deliveries : null,
    base: sum("base"),
    variable: sum("variable"),
    swa: sum("swa"),
    mfn: sum("mfn"),
    da: rows.reduce((s, r) => s + r.da, 0),
    utr: rows.reduce((s, r) => s + r.utr, 0),
    van: rows.reduce((s, r) => s + r.van, 0),
    rent: rows.reduce((s, r) => s + r.rent, 0),
    other: rows.reduce((s, r) => s + r.other, 0),
    stations: new Set(rows.map((r) => r.station)).size,
    stationDays: rows.length,
    shipmentDays: rows.filter((r) => r.deliveries !== null).length,
    revenueDays: rows.filter((r) => r.revenue !== null).length,
    costDays: rows.filter((r) => r.cost !== null).length,
    issueDays: rows.filter((r) => r.issues.length).length,
    dataThrough:
      rows
        .filter((r) => r.deliveries !== null)
        .map((r) => r.date)
        .sort()
        .at(-1) ?? null,
  };
}
export function pnlGroup(
  rows: PnlDay[],
  by: "station" | "region" | "date" | "month",
) {
  const groups = new Map<string, PnlDay[]>();
  for (const row of rows) {
    const key = by === "month" ? row.date.slice(0, 7) : row[by];
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, days]) => pnlTotal(days, key));
}
/** One cost record per station/day, even when multiple client revenue streams exist. */
export function buildPnl(
  revenue: BusinessRow[],
  cps: CpsSnapshot,
  locations: PnlLocation[],
  from: string,
  to: string,
) {
  const revenueDays = new Map<string, BusinessRow["daily"]>();
  for (const row of revenue)
    for (const day of row.daily) {
      if (day.date < from || day.date > to) continue;
      const key = `${row.station}/${day.date}`;
      revenueDays.set(key, [...(revenueDays.get(key) ?? []), day]);
    }
  const costs = new Map(
    cps.daily.map((d) => [`${d.station_code}/${d.work_date}`, d]),
  );
  // Revenue and cost must stop together at each station's latest delivery report.
  // Zero-delivery reports are valid evidence; absence of a report is not zero.
  const cutoffs = new Map<string, string>();
  for (const row of revenue)
    for (const day of row.daily)
      if (
        day.shipmentReported &&
        day.deliveries !== null &&
        day.date >= from &&
        day.date <= to
      )
        cutoffs.set(
          row.station,
          [cutoffs.get(row.station) || "", day.date].sort().at(-1)!,
        );
  for (const day of cps.daily)
    if (day.shipment_present && day.work_date >= from && day.work_date <= to)
      cutoffs.set(
        day.station_code,
        [cutoffs.get(day.station_code) || "", day.work_date].sort().at(-1)!,
      );
  const inCoverage = (station: string, date: string) =>
    date >= from && date <= (cutoffs.get(station) || "");
  const review = cpsReviewItems(cps);
  const days: PnlDay[] = [];
  for (const location of locations)
    for (let d = Date.parse(from); d <= Date.parse(to); d += 86400000) {
      const date = new Date(d).toISOString().slice(0, 10),
        key = `${location.station_code}/${date}`;
      const covered = inCoverage(location.station_code, date);
      if (!covered && (cutoffs.has(location.station_code) || date !== from))
        continue;
      const revenue = covered ? (revenueDays.get(key) ?? []) : [],
        cost = covered ? costs.get(key) : undefined;
      const issues = new Set(
        revenue
          .flatMap((r) => r.issues)
          .filter(
            (i) =>
              !/Cost report pending|Operating cost report pending|Shared station cost requires/.test(
                i,
              ),
          ),
      );
      if (!revenue.length)
        issues.add("Revenue pricing or shipment data missing");
      if (!cost) issues.add("Live cost inputs unavailable");
      if (cost?.cost_gaps)
        issues.add(`${cost.cost_gaps} cost inputs need review`);
      if (cost?.unmapped)
        issues.add(`${cost.unmapped} provider IDs need mapping`);
      const delivery = revenue.some((r) => r.shipmentReported)
        ? sumKnown(revenue.map((r) => n(r.deliveries)))
        : cost?.shipment_present
          ? cost.deliveries
          : null;
      if (delivery === null)
        issues.add("Shipment report pending; CPS is provisional");
      const sum = (
        field: "revenue" | "base" | "variable" | "swaRevenue" | "mfnRevenue",
      ) => sumKnown(revenue.map((r) => n(r[field])));
      days.push({
        station: location.station_code,
        name: location.station_name ?? location.station_code,
        region: location.region || "Unassigned",
        date,
        revenue: sum("revenue"),
        cost: cost ? cost.total : null,
        deliveries: delivery,
        base: sum("base"),
        variable: sum("variable"),
        swa: sum("swaRevenue"),
        mfn: sum("mfnRevenue"),
        da: cost?.da ?? 0,
        utr: cost?.utr ?? 0,
        van: cost?.van ?? 0,
        rent: cost?.rent ?? 0,
        other: (cost?.other ?? 0) + (cost?.overhead ?? 0),
        issues: [...issues],
      });
    }
  // Explicit public projection: never return People profiles, identities or individual CTC.
  return {
    days,
    coverage: locations.map((l) => ({
      station: l.station_code,
      from,
      requestedTo: to,
      through: cutoffs.get(l.station_code) ?? null,
      reportedDays: days.filter(
        (d) => d.station === l.station_code && d.deliveries !== null,
      ).length,
      excludedDays:
        Math.round(
          (Date.parse(to) - Date.parse(cutoffs.get(l.station_code) || from)) /
            86400000,
        ) + (cutoffs.has(l.station_code) ? 0 : 1),
    })),
    staffGroups: (cps.staff ?? []).map((s) => ({
      station: s.station_code,
      group: s.group,
      roles: s.roles ?? [],
    })),
    total: pnlTotal(days),
    stations: pnlGroup(days, "station"),
    regions: pnlGroup(days, "region"),
    months: pnlGroup(days, "month"),
    daily: pnlGroup(days, "date"),
    costs: cps.breakup
      .filter((c) => inCoverage(c.station_code, c.work_date))
      .map(({ station_code, work_date, head, sub_head, source, amount }) => ({
        station_code,
        work_date,
        head,
        sub_head,
        source,
        amount,
      })),
    reviews: [
      ...review.gaps
        .filter(
          (g) =>
            cutoffs.has(g.station_code) &&
            g.first_date <= cutoffs.get(g.station_code)!,
        )
        .map((g) => ({
          station: g.station_code,
          kind: g.kind,
          reference: g.provider_id || g.dropx_id || "Setup",
          from: g.first_date,
          to:
            g.last_date < cutoffs.get(g.station_code)!
              ? g.last_date
              : cutoffs.get(g.station_code)!,
          deliveries: g.deliveries,
          href: g.href,
        })),
      ...review.bills
        .filter(
          (b) =>
            cutoffs.has(b.station_code) &&
            b.period_from <= cutoffs.get(b.station_code)!,
        )
        .map((b) => ({
          station: b.station_code,
          kind: "Confirm bill period",
          reference: b.reference,
          from: b.period_from,
          to: b.period_to,
          deliveries: 0,
          href: "/cps?view=inputs",
        })),
    ],
  };
}
export type PnlReport = ReturnType<typeof buildPnl>;
