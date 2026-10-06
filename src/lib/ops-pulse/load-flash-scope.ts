import type { LoadFlashHourlyPoint, LoadFlashStation, LoadFlashTrackingRow } from "./edd-worker";

/**
 * Shared arithmetic for Ops Live: the same totals, driver roll-ups and
 * tracking-ID grouping feed the page and the Excel exports, so a number on
 * screen always matches the sheet a manager downloads.
 */

/** Bucket labels exactly as the worker writes them. */
const INDUCTED = "Inducted", RETAINED = "Retained", ON_ROAD = "Out on road", EDD_TODAY = "EDD today",
  DELIVERED = "Delivered", RETURN = "Customer return", PICKUP = "Pickup";
/** Same list the worker uses to count a first-day pickup as done. */
const PICKUP_DONE = new Set(["PICKED_UP", "PICKUP_DONE", "READY_FOR_FC_RETURN", "DELIVERED", "COMPLETE", "COMPLETED", "FC_RECEIVED", "RETURNED_TO_FC", "DELIVERED_TO_FC"]);

export type FlashKind = "load" | "edd" | "road" | "delivered" | "returns" | "pickups";
export const FLASH_KIND_LABELS: Record<FlashKind, string> = { load: "At station", edd: "EDD today", road: "Out on road", delivered: "Delivered", returns: "Returns", pickups: "Pickups" };

export type FlashTotals = {
  /** What the delivered percentage is measured against. */
  loadBase: number;
  /** "morning" = the morning list; "live" = no morning list yet; "dispatched" = a driver's delivered + on-road parcels. */
  baseKind: "morning" | "live" | "dispatched";
  delivered: number;
  deliveredPct: number;
  atStation: number;
  inducted: number;
  retained: number;
  eddToday: number;
  eddPast: number;
  eddFuture: number;
  onRoad: number;
  deliveredLive: number;
  returns: number;
  pickupsAssigned: number;
  pickupsDone: number;
};

/** One tracking ID with every list it currently sits in. */
export type FlashParcel = {
  stationCode: string;
  trackingId: string;
  buckets: string[];
  state: string;
  edd: string;
  morning: boolean;
  delivered: boolean;
  driverId: string;
  driverName: string;
  isAccessPoint: boolean;
};

export type FlashDriver = {
  stationCode: string;
  /** Empty for parcels Amazon has not attached to a driver or access point. */
  driverId: string;
  driverName: string;
  isAccessPoint: boolean;
  parcels: number;
  delivered: number;
  onRoad: number;
  atStation: number;
  returns: number;
  pickups: number;
  /** Delivered as a share of delivered + still on road. */
  deliveredPct: number;
};

export function flashPercent(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

export function flashStationBase(row: LoadFlashStation) {
  return row.morningLoad ?? row.totalLoad;
}

function add(rows: LoadFlashStation[], key: keyof LoadFlashStation) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

/** Totals for a set of stations. Stations that have never been fetched add nothing. */
export function flashTotalsFromStations(stations: LoadFlashStation[]): FlashTotals {
  const rows = stations.filter((row) => row.hasSnapshot);
  const morning = add(rows, "morningLoad");
  const atStation = add(rows, "totalLoad");
  const delivered = add(rows, "cohortDelivered");
  const loadBase = morning || atStation;
  return {
    loadBase, baseKind: morning ? "morning" : "live", delivered, deliveredPct: flashPercent(delivered, loadBase),
    atStation, inducted: add(rows, "inducted"), retained: add(rows, "retained"),
    eddToday: add(rows, "eddToday"), eddPast: add(rows, "eddPast"), eddFuture: add(rows, "eddFuture"),
    onRoad: add(rows, "outOnRoad"), deliveredLive: add(rows, "deliveredLive"), returns: add(rows, "returnsToday"),
    pickupsAssigned: add(rows, "pickupsAssigned"), pickupsDone: add(rows, "pickupsSuccess")
  };
}

/** Hour-by-hour totals for just these stations (the worker's own series is network-wide). */
export function sumFlashHourly(stations: LoadFlashStation[]): LoadFlashHourlyPoint[] {
  const byHour = new Map<number, LoadFlashHourlyPoint>();
  for (const station of stations) {
    for (const point of station.hourly ?? []) {
      const current = byHour.get(point.hour) ?? { hour: point.hour, at: point.at, totalLoad: 0, eddToday: 0, outOnRoad: 0, delivered: 0, returnsToday: 0, pickupsAssigned: 0, pickupsSuccess: 0 };
      current.totalLoad += point.totalLoad;
      current.eddToday += point.eddToday;
      current.outOnRoad += point.outOnRoad;
      current.delivered += point.delivered;
      current.returnsToday += point.returnsToday;
      current.pickupsAssigned += point.pickupsAssigned;
      current.pickupsSuccess += point.pickupsSuccess;
      if (point.at > current.at) current.at = point.at;
      byHour.set(point.hour, current);
    }
  }
  return [...byHour.values()].sort((a, b) => a.hour - b.hour);
}

/** The worker lists a tracking ID once per list it is in; fold those into one parcel. */
export function collapseFlashParcels(rows: LoadFlashTrackingRow[]): FlashParcel[] {
  const parcels = new Map<string, FlashParcel>();
  for (const row of rows) {
    const key = `${row.stationCode}|${row.trackingId}`;
    const parcel = parcels.get(key);
    if (!parcel) {
      parcels.set(key, { stationCode: row.stationCode, trackingId: row.trackingId, buckets: row.bucket ? [row.bucket] : [], state: row.state, edd: row.edd, morning: row.morning, delivered: row.delivered, driverId: row.driverId, driverName: row.driverName, isAccessPoint: row.isAccessPoint });
      continue;
    }
    if (row.bucket && !parcel.buckets.includes(row.bucket)) parcel.buckets.push(row.bucket);
    parcel.state ||= row.state;
    parcel.edd ||= row.edd;
    parcel.morning ||= row.morning;
    parcel.delivered ||= row.delivered;
    if (!parcel.driverId && row.driverId) { parcel.driverId = row.driverId; parcel.driverName = row.driverName; parcel.isAccessPoint = row.isAccessPoint; }
    parcel.driverName ||= row.driverName;
  }
  return [...parcels.values()];
}

export function flashParcelMatches(parcel: FlashParcel, kind: FlashKind) {
  switch (kind) {
    case "load": return parcel.buckets.includes(INDUCTED) || parcel.buckets.includes(RETAINED);
    case "edd": return parcel.buckets.includes(EDD_TODAY);
    case "road": return parcel.buckets.includes(ON_ROAD);
    case "delivered": return parcel.delivered || parcel.buckets.includes(DELIVERED);
    case "returns": return parcel.buckets.includes(RETURN);
    default: return parcel.buckets.includes(PICKUP);
  }
}

/** One plain-language position for a parcel, most final first. */
export function flashParcelPosition(parcel: FlashParcel) {
  if (flashParcelMatches(parcel, "delivered")) return "Delivered";
  if (flashParcelMatches(parcel, "road")) return "Out on road";
  if (flashParcelMatches(parcel, "returns")) return "Customer return";
  if (flashParcelMatches(parcel, "pickups")) return "Pickup";
  if (parcel.buckets.includes(RETAINED)) return "At station · retained";
  if (parcel.buckets.includes(INDUCTED)) return "At station · inducted";
  return parcel.buckets[0] || "Morning list";
}

export function flashDriverLabel(driver: { driverId: string; driverName: string }) {
  return driver.driverName || driver.driverId || "No driver recorded";
}

/** Per-driver roll-up, biggest workload first; parcels with no driver come last. */
export function summarizeFlashDrivers(parcels: FlashParcel[]): FlashDriver[] {
  const drivers = new Map<string, FlashDriver>();
  for (const parcel of parcels) {
    const key = `${parcel.stationCode}|${parcel.driverId}`;
    const driver = drivers.get(key) ?? { stationCode: parcel.stationCode, driverId: parcel.driverId, driverName: parcel.driverName, isAccessPoint: parcel.isAccessPoint, parcels: 0, delivered: 0, onRoad: 0, atStation: 0, returns: 0, pickups: 0, deliveredPct: 0 };
    driver.driverName ||= parcel.driverName;
    driver.parcels++;
    if (flashParcelMatches(parcel, "delivered")) driver.delivered++;
    else if (flashParcelMatches(parcel, "road")) driver.onRoad++;
    else if (flashParcelMatches(parcel, "load")) driver.atStation++;
    if (flashParcelMatches(parcel, "returns")) driver.returns++;
    if (flashParcelMatches(parcel, "pickups")) driver.pickups++;
    drivers.set(key, driver);
  }
  return [...drivers.values()]
    .map((driver) => ({ ...driver, deliveredPct: flashPercent(driver.delivered, driver.delivered + driver.onRoad) }))
    .sort((a, b) => Number(!a.driverId) - Number(!b.driverId) || b.parcels - a.parcels || flashDriverLabel(a).localeCompare(flashDriverLabel(b)));
}

/** Totals for one driver's parcels. Delivery is measured against what was actually dispatched. */
export function flashTotalsFromParcels(parcels: FlashParcel[], businessDate: string): FlashTotals {
  const count = (test: (parcel: FlashParcel) => boolean) => parcels.reduce((total, parcel) => total + Number(test(parcel)), 0);
  const delivered = count((parcel) => flashParcelMatches(parcel, "delivered"));
  const onRoad = count((parcel) => flashParcelMatches(parcel, "road") && !flashParcelMatches(parcel, "delivered"));
  const atStation = (parcel: FlashParcel) => flashParcelMatches(parcel, "load");
  const pickup = (parcel: FlashParcel) => flashParcelMatches(parcel, "pickups");
  return {
    loadBase: delivered + onRoad, baseKind: "dispatched", delivered, deliveredPct: flashPercent(delivered, delivered + onRoad),
    atStation: count(atStation), inducted: count((parcel) => parcel.buckets.includes(INDUCTED)), retained: count((parcel) => parcel.buckets.includes(RETAINED)),
    eddToday: count((parcel) => flashParcelMatches(parcel, "edd")),
    eddPast: count((parcel) => atStation(parcel) && Boolean(parcel.edd) && parcel.edd < businessDate),
    eddFuture: count((parcel) => atStation(parcel) && parcel.edd > businessDate),
    onRoad, deliveredLive: count((parcel) => parcel.buckets.includes(DELIVERED)), returns: count((parcel) => flashParcelMatches(parcel, "returns")),
    pickupsAssigned: count(pickup), pickupsDone: count((parcel) => pickup(parcel) && PICKUP_DONE.has(parcel.state.toUpperCase()))
  };
}
