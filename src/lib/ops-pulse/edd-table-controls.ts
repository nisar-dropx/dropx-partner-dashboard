import type { EddPackage } from "./edd-worker";
import { eddCurrentState } from "./edd-verification";
import { stationEddAssociateKey, stationEddAssociates, stationEddDate, stationEddFreshness, stationEddPackageMatches, stationEddPosition, stationEddSearchMatches, stationEddSelection, type StationEddSummary } from "./station-edd";

export const EDD_PERIODS = [["today", "EDD today"], ["overdue", "Overdue EDD"], ["pending", "Today + overdue"], ["all", "All observed dates"]] as const;
export const EDD_POSITIONS = [["atStation", "Pending first dispatch"], ["onRoad", "On road"], ["delivered", "Delivered"], ["hfr", "HFR · previous-day attempt"], ["attempted", "Attempted / returned"], ["unverified", "Needs history check"], ["other", "Other statuses"], ["all", "All positions"]] as const;
export const TID_SORTS = [["trackingId", "Tracking ID"], ["edd", "EDD date"], ["position", "Delivery position"], ["state", "Latest status"], ["associate", "Associate"], ["attempt", "First attempt"], ["city", "City / PIN"], ["checked", "History checked"]] as const;
export const ASSOCIATE_SORTS = [["name", "Associate"], ["sent", "Sent"], ["delivered", "Delivered"], ["onRoad", "Still on road"], ["attempted", "Attempted / returned"], ["rate", "Delivery rate"]] as const;
export const ASSOCIATE_FOCUS = [["all", "All associates"], ["outstanding", "Has outstanding deliveries"], ["onRoad", "Has TIDs on road"], ["attempted", "Has attempts / returns"], ["complete", "All sent TIDs delivered"]] as const;
export const NETWORK_FOCUS = [["all", "All stations"], ["pending", "Has pending first dispatch"], ["onRoad", "Has TIDs on road"], ["hfr", "Has HFR"], ["unverified", "Needs history checks"], ["overdue", "Has overdue pending"], ["missingDate", "Has unconfirmed EDD dates"]] as const;
export const NETWORK_SORTS = [["stationCode", "Station"], ["todayAtStation", "Pending"], ["todayOnRoad", "On road"], ["todayDelivered", "Delivered"], ["todayHfr", "HFR"], ["todayUnverified", "Needs checks"], ["overdueAtStation", "Overdue pending"], ["fetchedAt", "Latest observation"]] as const;
export const STATUS_SORTS = [["state", "Source status"], ["count", "Selected period"], ["total", "All observed dates"]] as const;
export type EddQuery = Record<string, string>;
type Choice = readonly (readonly [string, string])[];
function choice<T extends Choice>(value: string | null, values: T, fallback: T[number][0]): T[number][0] {
  return values.some(([key]) => key === value) ? value! : fallback;
}
export function eddQueryFromRecord(values: Record<string, string | string[] | undefined>): EddQuery {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
export function readEddControls(params: URLSearchParams) {
  return {
    ...stationEddSelection(params.get("day"), params.get("position")),
    view: choice(params.get("view"), [["tids", ""], ["associates", ""], ["statuses", ""]] as const, "tids"),
    query: params.get("query") || "", state: params.get("state") || "", associate: params.get("associate") || "",
    sentOnly: params.get("sentOnly") === "true",
    history: choice(params.get("history"), [["all", ""], ["complete", ""], ["incomplete", ""]] as const, "all"),
    sort: choice(params.get("sort"), TID_SORTS, "trackingId"), direction: params.get("direction") === "desc" ? "desc" as const : "asc" as const,
    associateQuery: params.get("associateQuery") || "", focus: choice(params.get("focus"), ASSOCIATE_FOCUS, "all"),
    associateSort: choice(params.get("associateSort"), ASSOCIATE_SORTS, "sent"), associateDirection: params.get("associateDirection") === "asc" ? "asc" as const : "desc" as const,
    statusQuery: params.get("statusQuery") || "", statusSort: choice(params.get("statusSort"), STATUS_SORTS, "count"), statusDirection: params.get("statusDirection") === "asc" ? "asc" as const : "desc" as const,
    size: choice(params.get("size"), [["25", ""], ["50", ""], ["100", ""]] as const, "50")
  };
}
export type EddControls = ReturnType<typeof readEddControls>;
export type SortDirection = "asc" | "desc";

/** Missing values sort last in either direction; exact tie-breakers make exports deterministic. */
export function sortEddRows<T>(rows: T[], value: (row: T) => string | number | null | undefined, direction: SortDirection, identity: (row: T) => string) {
  return [...rows].sort((a, b) => {
    const av = value(a), bv = value(b);
    const am = av == null || av === "", bm = bv == null || bv === "";
    if (am !== bm) return am ? 1 : -1;
    const compared = am ? 0 : typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "en", { numeric: true, sensitivity: "base" });
    return compared * (direction === "asc" ? 1 : -1) || identity(a).localeCompare(identity(b), "en", { numeric: true });
  });
}
export function selectEddTids(packages: EddPackage[], controls: EddControls, today: string) {
  const unique = [...new Map(packages.filter(p => p.trackingId).map(p => [p.trackingId, p])).values()];
  const rows = unique.filter(p => stationEddPackageMatches(p, controls.position, controls.day, today) && stationEddSearchMatches(p, controls.state, controls.query)
    && (!controls.associate || stationEddAssociateKey(p) === controls.associate)
    && (!controls.sentOnly || ["onRoad", "delivered", "attempted"].includes(stationEddPosition(p, today)))
    && (controls.history === "all" || Boolean(p.verification?.historyComplete) === (controls.history === "complete")));
  return sortEddRows(rows, p => {
    switch (controls.sort) {
      case "edd": return stationEddDate(p);
      case "position": return stationEddPosition(p, today);
      case "state": return eddCurrentState(p);
      case "associate": return p.driverName || p.verification?.driverName || p.driverId;
      case "attempt": return p.verification?.firstAttemptAt ? Date.parse(p.verification.firstAttemptAt) : null;
      case "city": return p.city || p.postalCode;
      case "checked": return p.verifiedAt ? Date.parse(p.verifiedAt) : null;
      default: return p.trackingId;
    }
  }, controls.direction, p => p.trackingId);
}
export function selectEddAssociates(packages: EddPackage[], controls: EddControls, today: string) {
  const query = controls.associateQuery.trim().toLowerCase();
  const rows = stationEddAssociates(packages, today, controls.day).filter(a => (!query || `${a.name} ${a.id}`.toLowerCase().includes(query)) && (
    controls.focus === "all" || controls.focus === "outstanding" && a.sent > a.delivered || controls.focus === "onRoad" && a.onRoad > 0 || controls.focus === "attempted" && a.attempted > 0 || controls.focus === "complete" && a.sent === a.delivered));
  return sortEddRows(rows, a => controls.associateSort === "rate" ? a.delivered / a.sent : a[controls.associateSort], controls.associateDirection, a => a.id);
}
export function selectEddStatuses(statuses: StationEddSummary["statuses"], controls: EddControls) {
  const query = controls.statusQuery.trim().toLowerCase();
  const rows = statuses.filter(row => row.state.toLowerCase().includes(query)).map(row => ({ ...row, count: controls.day === "today" ? row.today : controls.day === "overdue" ? row.overdue : controls.day === "pending" ? row.today + row.overdue : row.total }));
  return sortEddRows(rows, row => row[controls.statusSort], controls.statusDirection, row => row.state);
}
export function readNetworkControls(params: URLSearchParams) {
  return {
    query: params.get("query") || "", focus: choice(params.get("focus"), NETWORK_FOCUS, "all"),
    freshness: choice(params.get("freshness"), [["all", ""], ["recent", ""], ["older", ""], ["missing", ""]] as const, "all"),
    sort: choice(params.get("sort"), NETWORK_SORTS, "todayAtStation"), direction: params.get("direction") === "asc" ? "asc" as const : "desc" as const
  };
}
export function selectEddStations(rows: StationEddSummary[], names: Map<string, string>, controls: ReturnType<typeof readNetworkControls>, now = new Date()) {
  const term = controls.query.toLowerCase().trim();
  const focusKeys = { pending: "todayAtStation", onRoad: "todayOnRoad", hfr: "todayHfr", unverified: "todayUnverified", overdue: "overdueAtStation", missingDate: "missingDate" } as const;
  const filtered = rows.filter(row => {
    const recent = stationEddFreshness(row.fetchedAt, now) === "Recent snapshot";
    return (!term || `${row.stationCode} ${names.get(row.stationCode) || ""}`.toLowerCase().includes(term)) &&
      (controls.focus === "all" || row[focusKeys[controls.focus]] > 0) &&
      (controls.freshness === "all" || controls.freshness === "recent" && row.hasSnapshot && recent || controls.freshness === "older" && row.hasSnapshot && !recent || controls.freshness === "missing" && !row.hasSnapshot);
  });
  return sortEddRows(filtered, row => row[controls.sort], controls.direction, row => row.stationCode);
}
