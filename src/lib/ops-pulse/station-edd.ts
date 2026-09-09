import type { EddPackage, EddStationPayload } from "@/lib/ops-pulse/edd-worker";

export type StationEddFilter = "atStation" | "onRoad" | "other" | "all";
export type StationEddDay = "today" | "overdue" | "all";
export const STATION_EDD_RULE = "At station = INDUCTED or RECEIVED in the latest backlog snapshot. A retained driver ID does not override the current status. Reverse shipments are excluded. EDD uses the source's resolved EAD date; promised and internal dates remain visible for audit.";

export function stationEddToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function stationEddDate(pkg: EddPackage): string | null {
  for (const raw of [pkg.ead, pkg.internalEAD, pkg.promisedDeliveryDate]) {
    const value = raw?.trim();
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value) return value;
  }
  return null;
}

export function stationEddPosition(pkg: EddPackage): StationEddFilter {
  const state = (pkg.state ?? "").trim().toUpperCase();
  if (["INDUCTED", "RECEIVED"].includes(state)) return "atStation";
  if (["IN_TRANSIT_TO_CUSTOMER", "IN_TRANSIT", "OUT_FOR_DELIVERY"].includes(state)) return "onRoad";
  return "other";
}

export function isForwardEdd(pkg: EddPackage) {
  return !/return|reverse|pickup/i.test(pkg.packageType ?? "") && !/(?:^|[-_ ])rto(?:$|[-_ ])/i.test(pkg.shipOption ?? "");
}

export function stationEddPackageMatches(pkg: EddPackage, filter: StationEddFilter, day: StationEddDay, today: string) {
  if (!isForwardEdd(pkg)) return false;
  const date = stationEddDate(pkg);
  if (day === "today" && date !== today) return false;
  if (day === "overdue" && (!date || date >= today)) return false;
  return filter === "all" || stationEddPosition(pkg) === filter;
}

export type StationEddSummary = {
  stationCode: string;
  fetchedAt: string | null;
  today: string;
  hasSnapshot: boolean;
  todayTotal: number;
  todayAtStation: number;
  todayOnRoad: number;
  todayOther: number;
  overdueAtStation: number;
  atStationTotal: number;
  excludedReverse: number;
  missingDate: number;
  statuses: Array<{ state: string; today: number; overdue: number; total: number }>;
};

export function summarizeStationEdd(stationCode: string, packages: EddPackage[] | null, fetchedAt: string | null, today = stationEddToday()): StationEddSummary {
  const summary: StationEddSummary = { stationCode, fetchedAt, today, hasSnapshot: packages !== null, todayTotal: 0, todayAtStation: 0, todayOnRoad: 0, todayOther: 0, overdueAtStation: 0, atStationTotal: 0, excludedReverse: 0, missingDate: 0, statuses: [] };
  const statuses = new Map<string, StationEddSummary["statuses"][number]>();
  const unique = new Map((packages ?? []).filter(p => p.trackingId).map(p => [p.trackingId, p]));
  for (const pkg of unique.values()) {
    if (!isForwardEdd(pkg)) { summary.excludedReverse++; continue; }
    const date = stationEddDate(pkg);
    const state = pkg.state?.trim().toUpperCase() || "UNKNOWN";
    const status = statuses.get(state) ?? { state, today: 0, overdue: 0, total: 0 };
    status.total++;
    if (date === today) status.today++;
    if (date && date < today) status.overdue++;
    if (!date) summary.missingDate++;
    statuses.set(state, status);
    const position = stationEddPosition(pkg);
    if (position === "atStation") {
      summary.atStationTotal++;
      if (date && date < today) summary.overdueAtStation++;
    }
    if (date !== today) continue;
    summary.todayTotal++;
    if (position === "atStation") summary.todayAtStation++;
    else if (position === "onRoad") summary.todayOnRoad++;
    else summary.todayOther++;
  }
  summary.statuses = [...statuses.values()].sort((a, b) => b.today - a.today || b.total - a.total);
  return summary;
}

export function stationEddFreshness(fetchedAt: string | null, now = new Date()) {
  if (!fetchedAt || Number.isNaN(Date.parse(fetchedAt))) return "No snapshot";
  if (stationEddToday(new Date(fetchedAt)) !== stationEddToday(now)) return "Stale — previous day";
  return now.getTime() - Date.parse(fetchedAt) > 2 * 60 * 60 * 1000 ? "Snapshot over 2h old" : "Recent snapshot";
}

export function stationEddReportSheets(payload: EddStationPayload, stationName: string, today = stationEddToday()) {
  const packages = [...new Map(payload.packages.filter(p => p.trackingId).map(p => [p.trackingId, p])).values()];
  const summary = summarizeStationEdd(payload.stationCode, packages, payload.fetchedAt, today);
  const packageRow = (pkg: EddPackage) => ({
    "Station Code": payload.stationCode, "Station Name": stationName, "Tracking ID": pkg.trackingId,
    "EDD / EAD": stationEddDate(pkg) ?? "", "Promised Delivery Date": pkg.promisedDeliveryDate ?? "",
    "Internal EAD": pkg.internalEAD ?? "", "Estimated Arrival UTC": pkg.estimatedArrivalTimeUTC ?? "",
    "Raw Status": pkg.state ?? "", Position: stationEddPosition(pkg),
    "Forward Delivery": isForwardEdd(pkg) ? "Yes" : "No",
    "EDD Today": stationEddDate(pkg) === today ? "Yes" : "No",
    "Driver ID (source)": pkg.driverId ?? "", "Last Scan By": pkg.lastScanBy ?? "",
    "Package Type": pkg.packageType ?? "", "Ship Option": pkg.shipOption ?? "",
    "Store / Locker": pkg.lockerName ?? "", "Payment Method": pkg.paymentMethod ?? "",
    City: pkg.city ?? "", "Postal Code": pkg.postalCode ?? "", State: pkg.stateProvinceCode ?? "",
    "Order ID": pkg.orderingOrderId ?? "", "Minutes In State": pkg.minutesInState,
    "Snapshot Refreshed UTC": payload.fetchedAt, "Report EDD Day (IST)": today
  });
  return [
    { name: "Summary", rows: [{
      "Station Code": payload.stationCode, "Station Name": stationName, "EDD Day (IST)": today,
      "At Station EDD Today": summary.todayAtStation, "Overdue At Station": summary.overdueAtStation,
      "On Road EDD Today": summary.todayOnRoad, "Other Status EDD Today": summary.todayOther,
      "All Active EDD Today": summary.todayTotal, "Excluded Reverse Shipments": summary.excludedReverse,
      "Missing EDD": summary.missingDate, "Snapshot Refreshed UTC": payload.fetchedAt,
      Freshness: stationEddFreshness(payload.fetchedAt), Definition: STATION_EDD_RULE,
      "Delivered Counts": "Available in Performance; active backlog excludes completed deliveries."
    }] as Record<string, unknown>[] },
    { name: "Source Statuses", rows: summary.statuses.map(s => ({ "Raw Status": s.state, "EDD Today": s.today, Overdue: s.overdue, "All Dates": s.total })) },
    { name: "At Station EDD Today", rows: packages.filter(p => stationEddPackageMatches(p, "atStation", "today", today)).map(packageRow) },
    { name: "Overdue At Station", rows: packages.filter(p => stationEddPackageMatches(p, "atStation", "overdue", today)).map(packageRow) },
    { name: "All Snapshot TIDs", rows: packages.map(packageRow) }
  ];
}
