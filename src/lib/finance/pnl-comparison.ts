import { pnlTotal, type PnlDay, type PnlTotal, type PnlLocation } from "./pnl";

export type ComparisonLocation = PnlLocation & { pricing_model?: string };
export type ComparisonView = "stations" | "regions" | "months" | "daily";
export type ComparisonFocus = "all" | "loss" | "profit" | "unavailable" | "review";
export type ComparisonSort = "key" | "deliveries" | "revenue" | "cost" | "profit" | "cps" | "margin" | "dataThrough";
export type ComparisonOptions = { view: ComparisonView; focus: ComparisonFocus; search: string; sort: ComparisonSort; direction: "asc" | "desc" };
export type ComparisonRow = PnlTotal & { days: PnlDay[]; members: string[]; subtitle: string; searchText: string; earliestThrough: string | null; missingMembers: number };

export const comparisonViews = { stations: "By station", regions: "By region", months: "By month", daily: "By day" } as const;
export const comparisonFocuses = { all: "All results", loss: "Loss-making", profit: "Profitable", unavailable: "P&L unavailable", review: "Needs review" } as const;
export const comparisonColumns: { key: ComparisonSort; label: string }[] = [
  { key: "key", label: "Station group" }, { key: "deliveries", label: "Delivered" },
  { key: "revenue", label: "Revenue" }, { key: "cost", label: "Expenses" },
  { key: "profit", label: "Profit / loss" }, { key: "cps", label: "CPS" },
  { key: "margin", label: "Margin" }, { key: "dataThrough", label: "Data through" },
];
export const pnlResultClass = (profit: number | null) => profit === null || profit === 0 ? "pnl-neutral" : profit < 0 ? "pnl-negative" : "pnl-positive";
export const pnlResultLabel = (profit: number | null) => profit === null ? "P&L unavailable" : profit < 0 ? "Loss" : profit > 0 ? "Profit" : "Break-even";
export function comparisonTitle(key: string, view: ComparisonView) {
  if (view !== "months" && view !== "daily") return key;
  return new Date(`${key}${view === "months" ? "-01" : ""}T00:00:00Z`).toLocaleDateString("en-IN", {
    ...(view === "daily" ? { day: "numeric" } as const : {}), month: view === "months" ? "long" : "short", year: "numeric", timeZone: "UTC",
  });
}
// Relationships come from Station Master. Only already-authorized days are aggregated.
export function stationGroupKey(location: ComparisonLocation) {
  return location.pricing_model === "xpt" && location.parent_station_code ? location.parent_station_code : location.station_code;
}
// Split the fixed revenue for presentation without changing the earned total.
export function fixedRevenueBreakdown(days: PnlDay[], locations: ComparisonLocation[]) {
  const xpts = new Set(locations.filter(l => l.pricing_model === "xpt").map(l => l.station_code));
  const xptDays = days.filter(d => xpts.has(d.station));
  return {
    base: pnlTotal(days.filter(d => !xpts.has(d.station))).base,
    xpt: pnlTotal(xptDays).base,
    hasXpt: xptDays.length > 0,
  };
}
export function comparisonRows(days: PnlDay[], locations: ComparisonLocation[], view: ComparisonView): ComparisonRow[] {
  const metadata = new Map(locations.map(l => [l.station_code, l]));
  const groups = new Map<string, PnlDay[]>();
  for (const day of days) {
    const location = metadata.get(day.station);
    const parent = location ? stationGroupKey(location) : day.station;
    const key = view === "stations" ? parent : view === "regions" ? metadata.get(parent)?.region || day.region : view === "months" ? day.date.slice(0, 7) : day.date;
    const group = groups.get(key) ?? [];
    group.push(day);
    groups.set(key, group);
  }
  return [...groups].map(([key, rows]) => {
    const members = [...new Set(rows.map(d => d.station))].sort((a, b) => a === key ? -1 : b === key ? 1 : a.localeCompare(b));
    const cutoffs = members.map(station => rows.filter(d => d.station === station && d.deliveries !== null).map(d => d.date).sort().at(-1) ?? null);
    const xpts = members.filter(station => metadata.get(station)?.pricing_model === "xpt");
    const subtitle = view === "stations" ? xpts.length ? `${members.includes(key) ? "Includes XPT" : "XPT only in selected access / filters:"} ${xpts.join(", ")}` : metadata.get(key)?.station_name || "" : `${members.length} stations`;
    return { ...pnlTotal(rows, key), days: rows, members, subtitle, earliestThrough: cutoffs.filter((d): d is string => d !== null).sort()[0] ?? null, missingMembers: cutoffs.filter(d => d === null).length,
      searchText: [key, comparisonTitle(key, view), subtitle, ...members.flatMap(s => [s, metadata.get(s)?.station_name || ""])].join(" ").toLowerCase() };
  });
}
export function comparisonOptions(query: Record<string, string | string[] | undefined>): ComparisonOptions {
  const get = (key: string) => typeof query[key] === "string" ? String(query[key]) : "";
  const view = get("view"), focus = get("focus"), sort = get("sort");
  return { view: Object.hasOwn(comparisonViews, view) ? view as ComparisonView : "stations", focus: Object.hasOwn(comparisonFocuses, focus) ? focus as ComparisonFocus : "all", search: get("search").trim().slice(0, 200), sort: comparisonColumns.some(c => c.key === sort) ? sort as ComparisonSort : "key", direction: get("direction") === "desc" ? "desc" : "asc" };
}
export function matchesFocus(row: PnlTotal, focus: ComparisonFocus) {
  return focus === "loss" ? row.profit !== null && row.profit < 0 : focus === "profit" ? row.profit !== null && row.profit > 0 : focus === "unavailable" ? row.profit === null : focus === "review" ? row.issueDays > 0 || row.profit === null : true;
}
export function selectComparison(rows: ComparisonRow[], options: ComparisonOptions) {
  const search = options.search.trim().toLowerCase();
  return rows.filter(row => matchesFocus(row, options.focus) && row.searchText.includes(search)).sort((a, b) => {
    const left = a[options.sort], right = b[options.sort];
    // Unavailable always stays last, including descending sorts. Zero is a valid value.
    if (left === null || right === null) return left === right ? a.key.localeCompare(b.key) : left === null ? 1 : -1;
    const difference = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), "en", { numeric: true });
    return difference ? difference * (options.direction === "asc" ? 1 : -1) : a.key.localeCompare(b.key);
  });
}
export function comparisonSelection(report: { days: PnlDay[]; locations: ComparisonLocation[] }, options: ComparisonOptions) {
  const all = comparisonRows(report.days, report.locations, options.view);
  const entries = selectComparison(all, options);
  const days = entries.flatMap(row => row.days);
  return { all, entries, days, total: pnlTotal(days, "Shown results") };
}
