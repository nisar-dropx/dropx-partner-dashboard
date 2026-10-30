import type {BillingPeriod} from './billing-periods';
import { monthEnd, todayIndia } from "./pricing";
import {
  isoDate,
  cpsMonthSlices,
  cpsReviewItems,
  type CpsSnapshot,
} from "./cost-types";
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
export function shipmentReportingLimit(to: string, today = todayIndia()) {
  const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  return to < yesterday ? to : yesterday;
}
export type ShipmentCoveragePolicy = {
  billingPeriods?: Record<string, BillingPeriod>;
  limit: string;
  shipments: { station_code: string; work_date: string; deliveries: string | number | null }[];
  availability?: Record<string, { to: string | null }>;
};
export function reportedShipmentDays(policy: ShipmentCoveragePolicy, from: string, to: string, codes: Set<string>) {
  const raw=new Set(policy.shipments.filter(d=>d.work_date>=from&&d.work_date<=to&&d.work_date<=policy.limit&&
    d.deliveries!==null&&String(d.deliveries).trim()!==''&&Number.isFinite(Number(d.deliveries))&&Number(d.deliveries)>=0)
    .map(d=>`${d.station_code}/${d.work_date}`));
  const covered=new Set([...raw].filter(key=>codes.has(key.split('/')[0])));
  for(const [code,period] of Object.entries(policy.billingPeriods??{})){
    if(!codes.has(code))continue;
    for(let d=Date.parse(from);d<=Date.parse(to)&&d<=Date.parse(policy.limit);d+=86400000){
      const date=new Date(d).toISOString().slice(0,10),key=`${code}/${date}`;
      if(date>=period.reporting_from)continue;
      covered.delete(key);
      if(date>=period.fixed_payout_from&&period.prior_reporting_station&&raw.has(`${period.prior_reporting_station}/${date}`))covered.add(key);
    }
  }
  return covered;
}
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
  policy?: ShipmentCoveragePolicy,
) {
  // A caller may share a company-scoped snapshot with several reports. Apply
  // this report's authorized station scope before deriving coverage or details.
  const stationCodes = new Set(locations.map(l => l.station_code));
  cps = {
    ...cps,
    daily: cps.daily.filter(d => stationCodes.has(d.station_code)),
    breakup: cps.breakup.filter(d => stationCodes.has(d.station_code)),
    staff: cps.staff?.filter(d => stationCodes.has(d.station_code)),
    gaps: cps.gaps?.filter(d => stationCodes.has(d.station_code)),
    associates: cps.associates?.filter(d => stationCodes.has(d.station_code)),
    people: cps.people?.filter(d => stationCodes.has(d.station_code)),
    da_details: cps.da_details?.filter(d => stationCodes.has(d.station_code)),
    expense_periods: cps.expense_periods?.filter(d => stationCodes.has(d.station_code)),
    vehicles: cps.vehicles?.filter(d => stationCodes.has(d.station_code)),
    advertising: cps.advertising?.filter(d => stationCodes.has(d.station_code)),
  };
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
  const reported = policy ? reportedShipmentDays(policy, from, to, stationCodes) : new Set<string>();
  const available = new Map<string, string>();
  if (policy) for (const day of policy.shipments) {
    if (!stationCodes.has(day.station_code) || day.work_date > policy.limit ||
      day.deliveries === null || String(day.deliveries).trim() === '' ||
      !Number.isFinite(Number(day.deliveries)) || Number(day.deliveries) < 0) continue;
    available.set(day.station_code, [available.get(day.station_code) || '', day.work_date].sort().at(-1)!);
  }
  if (policy) for (const key of reported) { const [station,date]=key.split('/');cutoffs.set(station,[cutoffs.get(station)||'',date].sort().at(-1)!); }
  if (!policy) for (const row of revenue)
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
  if (!policy) for (const day of cps.daily)
    if (day.shipment_present && day.work_date >= from && day.work_date <= to)
      cutoffs.set(
        day.station_code,
        [cutoffs.get(day.station_code) || "", day.work_date].sort().at(-1)!,
      );
  const inCoverage = (station: string, date: string) =>
    policy ? reported.has(`${station}/${date}`) : date >= from && date <= (cutoffs.get(station) || "");
  const review = cpsReviewItems(cps);
  const days: PnlDay[] = [];
  for (const location of locations)
    for (let d = Date.parse(from); d <= Date.parse(to); d += 86400000) {
      const date = new Date(d).toISOString().slice(0, 10),
        key = `${location.station_code}/${date}`;
      const period=policy?.billingPeriods?.[location.station_code];
      const starts=period?(period.fixed_payout_from<period.reporting_from?period.fixed_payout_from:period.reporting_from):null;
      if(starts&&date<starts)continue;
      const inherited=!!(period&&date<period.reporting_from&&period.prior_reporting_station);
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
      const delivery = covered&&inherited ? 0 : revenue.some((r) => r.shipmentReported)
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
    coverage: locations.map((l) => {
      const dates: string[] = [];
      for (let d = Date.parse(from); d <= Date.parse(to); d += 86400000) dates.push(new Date(d).toISOString().slice(0, 10));
      const excluded = dates.filter(d => !inCoverage(l.station_code, d));
      const period=policy?.billingPeriods?.[l.station_code];
      const starts=period?[period.fixed_payout_from,period.reporting_from].sort()[0]:null;
      const beforeOpening=excluded.filter(d=>starts&&d<starts);
      const missing = excluded.filter(d => d <= (policy?.limit ?? to)&&(!starts||d>=starts));
      const parentCoveredDays=period?dates.filter(d=>d<period.reporting_from&&inCoverage(l.station_code,d)).length:0;
      const lastAvailable = policy?.availability?.[l.station_code]?.to;
      return {
        station: l.station_code, from, requestedTo: to, limit: policy?.limit ?? to,
        through: cutoffs.get(l.station_code) ?? null,
        availableThrough: available.get(l.station_code) ?? (lastAvailable && lastAvailable <= (policy?.limit ?? to) ? lastAvailable : null) ?? cutoffs.get(l.station_code) ?? null,
        reportedDays: dates.length - excluded.length,
        excludedDays: excluded.length, missingDates: missing,
        reportingFrom:period?.reporting_from??null,fixedPayoutFrom:period?.fixed_payout_from??null,
        priorReportingStation:period?.prior_reporting_station??null,parentCoveredDays,beforeOpeningDays:beforeOpening.length,
        currentDaysExcluded: excluded.filter(d=>d>(policy?.limit??to)&&(!starts||d>=starts)).length,
        excludedSourceCost: cps.daily.filter(d => d.station_code === l.station_code && excluded.includes(d.work_date)).reduce((s,d) => s + d.total, 0),
      };
    }),
    advertising: (cps.advertising ?? []).filter(c => inCoverage(c.station_code, c.spend_date)),
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
