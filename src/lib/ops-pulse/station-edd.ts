import type { EddPackage, EddStationPayload } from "@/lib/ops-pulse/edd-worker";
import { eddAttemptLifecycle, eddCurrentState, eddDeliveredState, eddIstDate, eddPendingEvidenceAt, eddPendingEvidenceFresh } from "./edd-verification";

export type StationEddFilter = "atStation" | "onRoad" | "delivered" | "hfr" | "hcr" | "rejected" | "returningToFc" | "attempted" | "unverified" | "other" | "all";
export type StationEddDay = "today" | "overdue" | "pending" | "all";
export const STATION_EDD_RULE = "Confirmed pending first dispatch = due shipment currently INDUCTED or RECEIVED, with complete, current history and no dispatch or attempt. Fresh summaries can reuse history only when their per-package event clock is unchanged. Observed at-station status includes returns and unchecked parcels; it is not confirmed first-dispatch pending. HFR is one distinct unsuccessful delivery attempt; HCR is two or more. Rejections are separate. Same-day attempts, on-road, cash collection and delivered packages are never pending. Duplicate scans are not extra attempts. Driver IDs alone do not prove dispatch. Dates use IST; reverse shipments are excluded. Incomplete coverage never certifies zero pendency or clearance.";

const todayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
export function stationEddToday(now = new Date()) { return todayFormatter.format(now); }

export function stationEddDate(pkg: EddPackage): string | null {
  for (const raw of [pkg.ead, pkg.verification?.edd, pkg.internalEAD, pkg.promisedDeliveryDate]) {
    const value = raw?.trim();
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value) return value;
  }
  return null;
}

export function stationEddPosition(pkg: EddPackage, today = stationEddToday(), now = Date.now()): StationEddFilter {
  const state = eddCurrentState(pkg);
  const history = pkg.verification;
  const attemptDay = eddIstDate(history?.firstAttemptAt);
  const lifecycle = eddAttemptLifecycle(pkg);
  if (eddDeliveredState(state)) return "delivered";
  if (pkg.observedStationCode && history?.routeStationCode && pkg.observedStationCode !== history.routeStationCode) return "unverified";
  if (lifecycle.category === "rejected" || lifecycle.category === "returningToFc") return lifecycle.category;
  if (attemptDay && attemptDay < today) return lifecycle.category === "hcr" ? "hcr" : lifecycle.category === "hfr" ? "hfr" : "unverified";
  if (["INDUCTED","RECEIVED"].includes(state) && history?.firstDispatchAt && (history.rulesVersion ?? 0) < 2 && !history.firstAttemptAt) return "unverified";
  if (["IN_TRANSIT_TO_CUSTOMER", "OUT_FOR_DELIVERY"].includes(state) || (state === "IN_TRANSIT" && history?.firstDispatchAt)) return "onRoad";
  if (state === "IN_TRANSIT" && !history?.historyComplete) return "unverified";
  if (["DELIVERY_ATTEMPTED", "DELIVERY_FAILED", "DELIVERY_REJECTED", "REJECTED"].includes(state) || history?.firstAttemptAt || history?.firstDispatchAt) return "attempted";
  if (["INDUCTED", "RECEIVED"].includes(state)) {
    const evidenceAt = eddPendingEvidenceAt(pkg, now);
    if (!history?.historyComplete || !eddPendingEvidenceFresh(pkg, now) || eddIstDate(evidenceAt) !== today ||
      (pkg.sourceAt && Date.parse(evidenceAt || "") < Date.parse(pkg.sourceAt) && evidenceAt !== pkg.summaryCheckedAt)) return "unverified";
    return "atStation";
  }
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
  if (day === "pending" && (!date || date > today)) return false;
  return filter === "all" || stationEddPosition(pkg, today) === filter;
}

export function stationEddSearchMatches(pkg: EddPackage, state = "", query = "") {
  if (state && eddCurrentState(pkg) !== state) return false;
  const term = query.toLowerCase().trim();
  return !term || [pkg.trackingId, eddCurrentState(pkg), pkg.driverId, pkg.driverName, pkg.verification?.driverName, pkg.lastScanBy, pkg.city, pkg.postalCode, pkg.orderingOrderId, pkg.lockerName].some(v => v?.toLowerCase().includes(term));
}

export function stationEddSelection(day: unknown, position: unknown) {
  return {
    day: (typeof day === "string" && ["today", "overdue", "pending", "all"].includes(day) ? day : "today") as StationEddDay,
    position: (typeof position === "string" && ["atStation", "onRoad", "delivered", "hfr", "hcr", "rejected", "returningToFc", "attempted", "unverified", "other", "all"].includes(position) ? position : "atStation") as StationEddFilter
  };
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
  todayDelivered: number;
  todayHfr: number;
  todayHcr: number;
  todayObservedAtStation: number;
  todayAttempted: number;
  todayUnverified: number;
  historyVerified: number;
  overdueAtStation: number;
  atStationTotal: number;
  excludedReverse: number;
  missingDate: number;
  statuses: Array<{ state: string; today: number; overdue: number; total: number }>;
};

export function summarizeStationEdd(stationCode: string, packages: EddPackage[] | null, fetchedAt: string | null, today = stationEddToday(), now = Date.now()): StationEddSummary {
  const summary: StationEddSummary = { stationCode, fetchedAt, today, hasSnapshot: packages !== null, todayTotal: 0, todayAtStation: 0, todayOnRoad: 0, todayOther: 0, todayDelivered: 0, todayHfr: 0, todayHcr: 0, todayObservedAtStation: 0, todayAttempted: 0, todayUnverified: 0, historyVerified: 0, overdueAtStation: 0, atStationTotal: 0, excludedReverse: 0, missingDate: 0, statuses: [] };
  const statuses = new Map<string, StationEddSummary["statuses"][number]>();
  const unique = new Map((packages ?? []).filter(p => p.trackingId).map(p => [p.trackingId, p]));
  for (const pkg of unique.values()) {
    if (!isForwardEdd(pkg)) { summary.excludedReverse++; continue; }
    const date = stationEddDate(pkg);
    const state = eddCurrentState(pkg);
    const status = statuses.get(state) ?? { state, today: 0, overdue: 0, total: 0 };
    status.total++;
    if (date === today) status.today++;
    if (date && date < today) status.overdue++;
    if (!date) summary.missingDate++;
    statuses.set(state, status);
    const position = stationEddPosition(pkg, today, now);
    if (position === "atStation") {
      summary.atStationTotal++;
      if (date && date < today) summary.overdueAtStation++;
    }
    if (date !== today) continue;
    summary.todayTotal++;
    if (["INDUCTED", "RECEIVED"].includes(state)) summary.todayObservedAtStation++;
    if (pkg.verification?.historyComplete) summary.historyVerified++;
    if (position === "atStation") summary.todayAtStation++;
    else if (position === "onRoad") summary.todayOnRoad++;
    else if (position === "delivered") summary.todayDelivered++;
    else if (position === "hfr") summary.todayHfr++;
    else if (position === "hcr") summary.todayHcr++;
    else if (position === "attempted") summary.todayAttempted++;
    else if (position === "unverified") summary.todayUnverified++;
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

export function stationEddPackageRow(pkg: EddPackage, stationCode: string, stationName: string, fetchedAt: string, today: string) {
  const lifecycle = eddAttemptLifecycle(pkg);
  return {
    "Station Code": stationCode, "Station Name": stationName, "Tracking ID": pkg.trackingId,
    "EDD / EAD": stationEddDate(pkg) ?? "", "Promised Delivery Date": pkg.promisedDeliveryDate ?? "",
    "Internal EAD": pkg.internalEAD ?? "", "Estimated Arrival UTC": pkg.estimatedArrivalTimeUTC ?? "",
    "Raw Status": eddCurrentState(pkg), Position: stationEddPosition(pkg, today),
    ...(lifecycle.category === "none" ? {} : { "Attempt Classification": lifecycle.category, "Distinct Attempts Observed": lifecycle.observedAttempts,
    "Attempt Count Complete": lifecycle.complete ? "Yes" : "No — lower bound only",
    "Second Attempt UTC": lifecycle.secondAttemptAt || "", "Returned After Attempt UTC": lifecycle.returnedAt || "",
    "Source Route Station": pkg.verification?.routeStationCode || "", "FC Readiness": lifecycle.category === "returningToFc" ? "In transit to FC" : "Not confirmed by source" }),
    "Forward Delivery": isForwardEdd(pkg) ? "Yes" : "No",
    "EDD Today": stationEddDate(pkg) === today ? "Yes" : "No",
    "Driver ID (source)": pkg.driverId ?? "", "Last Scan By": pkg.lastScanBy ?? "",
    "Associate Name": pkg.driverName || pkg.verification?.driverName || "",
    "First Dispatch UTC": pkg.verification?.firstDispatchAt || "", "First Attempt UTC": pkg.verification?.firstAttemptAt || "",
    "History Verified UTC": pkg.verifiedAt || "", "History Complete": pkg.verification?.historyComplete ? "Yes" : "No",
    "Package Type": pkg.packageType ?? "", "Ship Option": pkg.shipOption ?? "",
    "Store / Locker": pkg.lockerName ?? "", "Payment Method": pkg.paymentMethod ?? "",
    City: pkg.city ?? "", "Postal Code": pkg.postalCode ?? "", State: pkg.stateProvinceCode ?? "",
    "Order ID": pkg.orderingOrderId ?? "", "Minutes In State": pkg.minutesInState,
    "Snapshot Refreshed UTC": fetchedAt, "Report EDD Day (IST)": today,
    "EDD Period": !stationEddDate(pkg) ? "Missing" : stationEddDate(pkg)! < today ? "Overdue" : stationEddDate(pkg) === today ? "Today" : "Future"
  };
}

export function stationEddReportSheets(payload: EddStationPayload, stationName: string, today = stationEddToday()) {
  const packages = [...new Map(payload.packages.filter(p => p.trackingId).map(p => [p.trackingId, p])).values()];
  const summary = summarizeStationEdd(payload.stationCode, packages, payload.fetchedAt, today);
  const packageRow = (pkg: EddPackage) => stationEddPackageRow(pkg, payload.stationCode, stationName, payload.fetchedAt, today);
  return [
    { name: "Summary", rows: [{
      "Station Code": payload.stationCode, "Station Name": stationName, "EDD Day (IST)": today,
      "At Station EDD Today": summary.todayAtStation, "Overdue At Station": summary.overdueAtStation,
      "On Road EDD Today": summary.todayOnRoad, "Other Status EDD Today": summary.todayOther,
      "Known EDD Today": summary.todayTotal, "Delivered EDD Today": summary.todayDelivered, HFR: summary.todayHfr, HCR: summary.todayHcr, "Observed INDUCTED / RECEIVED": summary.todayObservedAtStation, "Needs History Verification": summary.todayUnverified, "Excluded Reverse Shipments": summary.excludedReverse,
      "Missing EDD": summary.missingDate, "Snapshot Refreshed UTC": payload.fetchedAt,
      Freshness: stationEddFreshness(payload.fetchedAt), Definition: STATION_EDD_RULE,
      Coverage: "Known EDD cohort from retained backlog, performance outcomes and verified tracking history. Missing-date packages are not assumed to be due today."
    }] as Record<string, unknown>[] },
    { name: "Source Statuses", rows: summary.statuses.map(s => ({ "Raw Status": s.state, "EDD Today": s.today, Overdue: s.overdue, "All Dates": s.total })) },
    { name: "At Station EDD Today", rows: packages.filter(p => stationEddPackageMatches(p, "atStation", "today", today)).map(packageRow) },
    { name: "Overdue At Station", rows: packages.filter(p => stationEddPackageMatches(p, "atStation", "overdue", today)).map(packageRow) },
    { name: "Associates EDD Today", rows: stationEddAssociates(packages, today).map(a => ({ Associate: a.name, "Driver ID": a.id, Sent: a.sent, Delivered: a.delivered, "On Road": a.onRoad, "Attempted or Returned": a.attempted, Other: a.other })) },
    { name: "HFR", rows: packages.filter(p => stationEddPackageMatches(p, "hfr", "pending", today)).map(packageRow) },
    { name: "Attempt lifecycle", rows: packages.filter(p => isForwardEdd(p) && eddAttemptLifecycle(p).category !== "none").map(packageRow) },
    { name: "All Snapshot TIDs", rows: packages.map(packageRow) }
  ];
}

export function stationEddAssociateKey(pkg: EddPackage) {
  return pkg.isAccessPoint ? "access-point" : pkg.driverId || pkg.driverName || pkg.verification?.driverName || "unattributed";
}
export function stationEddAssociates(packages: EddPackage[], today = stationEddToday(), day: StationEddDay = "today") {
  const rows = new Map<string, { id: string; name: string; sent: number; delivered: number; onRoad: number; attempted: number; other: number }>();
  for (const pkg of new Map(packages.map(p => [p.trackingId,p])).values()) {
    if (!stationEddDate(pkg) || !stationEddPackageMatches(pkg, "all", day, today)) continue;
    const position = stationEddPosition(pkg, today);
    if (!["onRoad","delivered","attempted"].includes(position)) continue;
    const id = stationEddAssociateKey(pkg);
    const row = rows.get(id) ?? { id, name: pkg.isAccessPoint ? "Access point / locker" : pkg.driverName || pkg.verification?.driverName || (id === "unattributed" ? "Associate not identified" : id), sent: 0, delivered: 0, onRoad: 0, attempted: 0, other: 0 };
    row.sent++;
    if (position === "delivered") row.delivered++;
    else if (position === "onRoad") row.onRoad++;
    else if (position === "attempted") row.attempted++;
    else row.other++;
    rows.set(id,row);
  }
  return [...rows.values()].sort((a,b) => b.sent-a.sent || a.name.localeCompare(b.name));
}
