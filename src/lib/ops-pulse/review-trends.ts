import {
  hawkeyeMetricDefinitions,
  hawkeyeTargetKey,
  hawkeyeValue,
} from "./hawkeye";
import { ACTIVE_DAILY_PERFORMANCE_SOURCE } from "./performance-source-policy";

export type TrendGroup = "performance" | "cost" | "station" | "opening";
export type TrendPoint = { date: string; value: number | null; note?: string };
export type TrendSeries = {
  key: string;
  label: string;
  unit: "percent" | "money" | "number" | "time";
  points: TrendPoint[];
  target?: number | null;
  direction?: "higher" | "lower";
  note: string;
};
export type TrendResponse = {
  station: string;
  endDate: string;
  series: TrendSeries[];
};
export type TrendRow = Record<string, unknown>;
export const trendNumber = (value: unknown) =>
  value == null || value === "" || !Number.isFinite(Number(value))
    ? null
    : Number(value);
export function trendDates(endDate: string, days = 14) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
    !Number.isFinite(Date.parse(endDate)) ||
    new Date(endDate).toISOString().slice(0, 10) !== endDate
  )
    throw Error("Choose a valid review date.");
  return Array.from({ length: days }, (_, index) =>
    new Date(Date.parse(endDate) + (index - days + 1) * 86400000)
      .toISOString()
      .slice(0, 10),
  );
}
export function readTrendQuery(params: URLSearchParams) {
  for (const key of ["station", "date", "group"])
    if (params.getAll(key).length !== 1)
      throw Error("Choose one station, date and trend.");
  const station = params.get("station")!,
    date = params.get("date")!,
    group = params.get("group")!;
  if (
    !/^[A-Z0-9_ -]{2,24}$/.test(station) ||
    !(["performance", "cost", "station", "opening"] as string[]).includes(group)
  )
    throw Error("Choose a valid station and trend.");
  trendDates(date);
  return { station, date, group: group as TrendGroup };
}
export function performanceTrendSeries(
  dates: string[],
  facts: TrendRow[],
  targets: {
    metricKey: string;
    target: number | null;
    direction: "higher" | "lower";
  }[],
): TrendSeries[] {
  const latest = new Map<string, TrendRow>();
  // Date-keyed, latest uploaded station row. Never fill Hawkeye gaps with EDSP.
  for (const fact of [...facts].sort(
    (a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)) ||
      String(b.id).localeCompare(String(a.id)),
  )) {
    if (
      fact.source_type === ACTIVE_DAILY_PERFORMANCE_SOURCE &&
      !latest.has(String(fact.report_date))
    )
      latest.set(String(fact.report_date), fact);
  }
  const result: TrendSeries[] = hawkeyeMetricDefinitions.map((definition) => {
    const key = hawkeyeTargetKey(definition),
      target = targets.find((row) => row.metricKey === key);
    return {
      key,
      label: definition.short,
      unit: "percent",
      target: target?.target == null ? null : target.target * 100,
      direction: target?.direction,
      note: "Hawkeye D-1 · latest uploaded report for each date. Target line uses the current master setting.",
      points: dates.map((date) => {
        const row = latest.get(date),
          value = hawkeyeValue(row?.values_json, definition.label);
        return {
          date,
          value: value == null ? null : value * 100,
          note: row
            ? value == null
              ? "Metric not supplied"
              : "Hawkeye D-1"
            : "No Hawkeye report",
        };
      }),
    };
  });
  result.push({
    key: "metric_health",
    label: "Metric health",
    unit: "number",
    note: "Matches the scorecard: total metrics minus off-target metrics. Reference-only metrics are included in the total; missing reports remain gaps.",
    points: dates.map((date) => {
      if (!latest.has(date))
        return { date, value: null, note: "No Hawkeye report" };
      const configured = result.filter(
        (series) =>
          series.target != null &&
          series.points.find((p) => p.date === date)?.value != null,
      );
      return {
        date,
        value:
          result.length -
          configured.filter((s) =>
            s.direction === "lower"
              ? s.points.find((p) => p.date === date)!.value! > s.target!
              : s.points.find((p) => p.date === date)!.value! < s.target!,
          ).length,
        note: `${configured.length} available target metrics`,
      };
    }),
  });
  return result;
}
const sum = (rows: TrendRow[], key: string) =>
  rows.reduce((total, row) => total + (trendNumber(row[key]) ?? 0), 0);
export function costTrendSeries(
  dates: string[],
  costs: TrendRow[],
  capacity: TrendRow[],
  shipments: TrendRow[],
  payments: TrendRow[],
  details: TrendRow[] = [],
): TrendSeries[] {
  const series: TrendSeries[] = [];
  const specs: [string, string, TrendSeries["unit"]][] = [
    ["delivered", "Delivered", "number"],
    ["allocation", "Average allocation", "number"],
    ["salary_da_cps", "Salary DA CPS", "money"],
    ["salary_da_cost", "Salary DA cost", "money"],
    ["ad_hoc_van", "Ad-hoc van amount", "money"],
    ["ad_hoc_van_cps", "Ad-hoc van CPS", "money"],
    ["ad_hoc_van_mtd", "MTD ad-hoc van amount", "money"],
    ["ad_hoc_da", "Ad-hoc DA amount", "money"],
    ["ad_hoc_da_cps", "Ad-hoc DA CPS", "money"],
    ["ad_hoc_da_mtd", "MTD ad-hoc DA amount", "money"],
    ["daily_cps", "Daily CPS", "money"],
    ["day_cost", "Daily total cost", "money"],
    ["mtd_cps", "MTD CPS", "money"],
  ];
  for (const [key, label, unit] of specs)
    series.push({
      key,
      label,
      unit,
      points: [],
      note: key.startsWith("ad_hoc")
        ? "Approved requests by work date. Zero means no approved request recorded. CPS = amount ÷ delivered shipments."
        : key === "mtd_cps"
          ? "Cumulative loaded cost ÷ cumulative delivered shipments, resetting each calendar month. Missing cost days are flagged; this is not a payroll-completeness certification."
          : "Recorded operational data only. Missing inputs remain gaps; cost mappings may be incomplete.",
    });
  for (const date of dates) {
    const cost = costs.find((row) => row.work_date === date),
      cap = capacity.find((row) => row.work_date === date),
      shipment = shipments.filter((row) => row.work_date === date);
    const detail = details.filter((row) => row.work_date === date),
      detailDelivered = detail.reduce(
        (n, row) => n + (trendNumber(row.package_count) ?? 1),
        0,
      );
    const delivered =
      trendNumber(cap?.delivered) ||
      detailDelivered ||
      (shipment.length
        ? sum(shipment, "total_delivery")
        : trendNumber(cap?.delivered));
    const active =
      trendNumber(cap?.active_ids) ||
      new Set(
        detail.map((row) => row.driver_id || row.driver_name).filter(Boolean),
      ).size ||
      new Set(shipment.map((row) => row.provider_employee_id).filter(Boolean))
        .size;
    const shipmentPay = shipment.length ? sum(shipment, "da_total_pay") : null;
    // Match the review card: positive shipment pay overrides the loaded daily salary cost.
    const salary =
      shipmentPay != null && shipmentPay > 0
        ? shipmentPay
        : (trendNumber(cost?.da_pay_cost) ?? shipmentPay);
    const unmapped = shipment.filter(
      (row) => String(row.mapping_status).toUpperCase() !== "MAPPED",
    ).length;
    const requests = payments.filter((row) => row.work_date === date),
      month = date.slice(0, 7);
    const monthCosts = costs.filter(
      (row) =>
        String(row.work_date).startsWith(month) &&
        String(row.work_date) <= date,
    );
    const monthCapacity = capacity.filter(
      (row) =>
        String(row.work_date).startsWith(month) &&
        String(row.work_date) <= date,
    );
    const monthPayments = payments.filter(
      (row) =>
        String(row.work_date).startsWith(month) &&
        String(row.work_date) <= date,
    );
    const monthDelivered =
      sum(monthCapacity, "delivered") || sum(monthCosts, "total_delivery");
    const missingCostDays = monthCapacity.filter(
      (row) => !monthCosts.some((c) => c.work_date === row.work_date),
    ).length;
    const van = requests.filter((row) => row.category === "Van"),
      da = requests.filter((row) => row.category !== "Van");
    const vanAmount = sum(van, "approved_amount"),
      daAmount = sum(da, "approved_amount");
    const values: Record<string, number | null> = {
      delivered,
      allocation: delivered != null && active > 0 ? delivered / active : null,
      salary_da_cost: salary,
      salary_da_cps: salary != null && delivered ? salary / delivered : null,
      ad_hoc_van: vanAmount,
      ad_hoc_da: daAmount,
      ad_hoc_van_cps: delivered ? vanAmount / delivered : null,
      ad_hoc_da_cps: delivered ? daAmount / delivered : null,
      ad_hoc_van_mtd: sum(
        monthPayments.filter((row) => row.category === "Van"),
        "approved_amount",
      ),
      ad_hoc_da_mtd: sum(
        monthPayments.filter((row) => row.category !== "Van"),
        "approved_amount",
      ),
      daily_cps: trendNumber(cost?.overall_cps),
      day_cost: trendNumber(cost?.total_cost),
      mtd_cps:
        monthCosts.length && monthDelivered
          ? sum(monthCosts, "total_cost") / monthDelivered
          : null,
    };
    for (const s of series) {
      let note = values[s.key] == null ? "Data not available" : "";
      if (s.key.startsWith("ad_hoc_van"))
        note = `${s.key.endsWith("mtd") ? monthPayments.filter((r) => r.category === "Van").length : van.length} approved requests${s.key.endsWith("cps") && !delivered ? " · Delivery missing" : ""}`;
      if (s.key.startsWith("ad_hoc_da"))
        note = `${s.key.endsWith("mtd") ? monthPayments.filter((r) => r.category !== "Van").length : da.length} approved requests${s.key.endsWith("cps") && !delivered ? " · Delivery missing" : ""}`;
      if (s.key.startsWith("salary") && unmapped)
        note = `${unmapped} payment mapping gaps · recorded cost only`;
      if (s.key === "mtd_cps")
        note = `${monthCosts.length} cost days loaded${missingCostDays ? ` · ${missingCostDays} delivery days missing costs` : ""} · ${monthDelivered} delivered`;
      s.points.push({ date, value: values[s.key], note });
    }
  }
  return series;
}
export function clockMinutes(value: unknown, date?: string) {
  if (!value || !Number.isFinite(Date.parse(String(value)))) return null;
  const instant = Date.parse(String(value));
  return date
    ? (instant - Date.parse(`${date}T00:00:00+05:30`)) / 60000
    : (((instant / 60000 + 330) % 1440) + 1440) % 1440;
}
export function formatTrendValue(
  value: number | null,
  unit: TrendSeries["unit"],
) {
  if (value == null) return "No data";
  if (unit === "time") {
    const day = Math.floor(value / 1440),
      minutes = Math.round(value) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}${day > 0 ? ` (+${day}d)` : ""}`;
  }
  return `${unit === "money" ? "₹" : ""}${value.toLocaleString("en-IN", { maximumFractionDigits: unit === "percent" ? 1 : 2 })}${unit === "percent" ? "%" : ""}`;
}
export function trendGeometry(points: TrendPoint[], target?: number | null) {
  const values = points.flatMap((p) => (p.value == null ? [] : [p.value]));
  if (target != null) values.push(target);
  const min = values.length ? Math.min(...values) : 0,
    max = values.length ? Math.max(...values) : 1,
    pad = Math.max((max - min) * 0.15, Math.abs(max) * 0.02, 1);
  const low = min - pad,
    high = max + pad,
    y = (value: number) => 142 - ((value - low) / (high - low)) * 124;
  const dots = points.map((p, i) => ({
    x: 34 + (i * 336) / Math.max(points.length - 1, 1),
    y: p.value == null ? null : y(p.value),
    ...p,
  }));
  const segments: string[] = [];
  let segment: string[] = [];
  for (const dot of dots) {
    if (dot.y == null) {
      if (segment.length) segments.push(segment.join(" "));
      segment = [];
    } else segment.push(`${dot.x.toFixed(1)},${dot.y.toFixed(1)}`);
  }
  if (segment.length) segments.push(segment.join(" "));
  return {
    dots,
    segments,
    min,
    max,
    targetY: target == null ? null : y(target),
  };
}
