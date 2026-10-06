import type { LoadFlashNetworkPayload, LoadFlashStation, LoadFlashTrackingRow } from "@/lib/ops-pulse/edd-worker";
import { collapseFlashParcels, flashDriverLabel, flashParcelMatches, flashParcelPosition, sumFlashHourly, summarizeFlashDrivers, type FlashKind, type FlashParcel } from "@/lib/ops-pulse/load-flash-scope";

export const LOAD_FLASH_REPORTS = {
  load: "Total load",
  edd: "EDD today",
  road: "Out on road",
  delivered: "Delivered",
  returns: "Customer returns",
  pickups: "Pickup success"
} as const;

export type LoadFlashReportKind = keyof typeof LOAD_FLASH_REPORTS | "full";
/** `driverId` narrows every tracking-ID sheet to one driver; an empty string means "no driver recorded". */
export type LoadFlashReportScope = { stationNames?: Record<string, string>; driverId?: string };
type Sheet = { name: string; rows: Record<string, unknown>[] };

function stationsOf(payload: LoadFlashNetworkPayload): LoadFlashStation[] {
  return [...payload.stations].sort((a, b) => a.stationCode.localeCompare(b.stationCode));
}

function fetched(row: LoadFlashStation) {
  return row.fetchedAt ?? "";
}

function fullRows(payload: LoadFlashNetworkPayload, names: Record<string, string>): Record<string, unknown>[] {
  return stationsOf(payload).map((row) => ({
    Date: payload.businessDate,
    Station: row.stationCode,
    "Station name": names[row.stationCode] ?? "",
    "Has snapshot": row.hasSnapshot ? "Yes" : "No",
    "Fetched at": fetched(row),
    Inducted: row.inducted,
    Retained: row.retained,
    "Total load": row.totalLoad,
    "EDD past": row.eddPast,
    "EDD today": row.eddToday,
    "EDD future": row.eddFuture,
    "Out on road": row.outOnRoad,
    "Morning census": row.morningLoad ?? "",
    "Delivered (census)": row.cohortDelivered,
    "Delivered %": row.deliveredPct,
    "Delivered live": row.deliveredLive,
    "Customer returns": row.returnsToday,
    "Pickups assigned": row.pickupsAssigned,
    "Pickups success": row.pickupsSuccess,
    "Pickup %": row.pickupPct,
    "History done": row.historyDone ? "Yes" : "No"
  }));
}

function reportRows(payload: LoadFlashNetworkPayload, kind: keyof typeof LOAD_FLASH_REPORTS): Record<string, unknown>[] {
  return stationsOf(payload).map((row) => {
    const station = { Date: payload.businessDate, Station: row.stationCode, "Fetched at": fetched(row) };
    if (kind === "load") return { ...station, Inducted: row.inducted, Retained: row.retained, "Total load": row.totalLoad };
    if (kind === "edd") return { ...station, "EDD today": row.eddToday, "EDD past": row.eddPast, "EDD future": row.eddFuture, "Total load": row.totalLoad };
    if (kind === "road") return { ...station, "Out on road": row.outOnRoad, "Total load": row.totalLoad };
    if (kind === "delivered") {
      return {
        ...station,
        "Morning census": row.morningLoad ?? "",
        "Delivered (census)": row.cohortDelivered,
        "Delivered %": row.deliveredPct,
        "Delivered live": row.deliveredLive
      };
    }
    if (kind === "returns") return { ...station, "Customer returns": row.returnsToday };
    return {
      ...station,
      "Pickups assigned": row.pickupsAssigned,
      "Pickups success": row.pickupsSuccess,
      "Pickup %": row.pickupPct
    };
  });
}

function hourlyRows(payload: LoadFlashNetworkPayload): Record<string, unknown>[] {
  // Summed from the stations in this export, so a cluster or station export is not network-wide.
  return sumFlashHourly(payload.stations).map((point) => ({
    Date: payload.businessDate,
    Hour: point.hour,
    At: point.at,
    "Total load": point.totalLoad,
    "EDD today": point.eddToday,
    "Out on road": point.outOnRoad,
    Delivered: point.delivered,
    "Customer returns": point.returnsToday,
    "Pickups assigned": point.pickupsAssigned,
    "Pickups success": point.pickupsSuccess
  }));
}

/** One row per tracking ID: where it is now, who has it, and every list it is in. */
function parcelRows(parcels: FlashParcel[], date: string, names: Record<string, string>): Record<string, unknown>[] {
  return [...parcels]
    .sort((a, b) => a.stationCode.localeCompare(b.stationCode) || flashDriverLabel(a).localeCompare(flashDriverLabel(b)) || a.trackingId.localeCompare(b.trackingId))
    .map((parcel) => ({
      Date: date,
      Station: parcel.stationCode,
      "Station name": names[parcel.stationCode] ?? "",
      "Tracking ID": parcel.trackingId,
      Position: flashParcelPosition(parcel),
      "Amazon status": parcel.state,
      EDD: parcel.edd,
      "Driver ID": parcel.driverId,
      "Driver name": parcel.driverName,
      "Delivered via": parcel.driverId ? (parcel.isAccessPoint ? "Store / locker" : "Driver") : "",
      "Morning census": parcel.morning ? "Yes" : "No",
      Delivered: flashParcelMatches(parcel, "delivered") ? "Yes" : "No",
      Lists: parcel.buckets.join(", ")
    }));
}

function driverRows(parcels: FlashParcel[], date: string, names: Record<string, string>): Record<string, unknown>[] {
  return summarizeFlashDrivers(parcels)
    .sort((a, b) => a.stationCode.localeCompare(b.stationCode) || Number(!a.driverId) - Number(!b.driverId) || b.parcels - a.parcels)
    .map((driver) => ({
      Date: date,
      Station: driver.stationCode,
      "Station name": names[driver.stationCode] ?? "",
      "Driver ID": driver.driverId,
      "Driver name": flashDriverLabel(driver),
      Type: !driver.driverId ? "No driver recorded" : driver.isAccessPoint ? "Store / locker" : "Driver",
      "Tracking IDs": driver.parcels,
      Delivered: driver.delivered,
      "Out on road": driver.onRoad,
      "Delivered % of dispatched": driver.deliveredPct,
      "At station": driver.atStation,
      "Customer returns": driver.returns,
      Pickups: driver.pickups
    }));
}

export function loadFlashReportSheets(
  payload: LoadFlashNetworkPayload,
  kind: LoadFlashReportKind,
  tracking: LoadFlashTrackingRow[] = [],
  scope: LoadFlashReportScope = {}
): Sheet[] {
  const names = scope.stationNames ?? {};
  const everyParcel = collapseFlashParcels(tracking);
  const byDriver = scope.driverId !== undefined;
  const parcels = byDriver ? everyParcel.filter((parcel) => parcel.driverId === scope.driverId) : everyParcel;
  const date = payload.businessDate;
  // Station counts describe whole stations, so a single-driver export leads with that driver's own numbers instead.
  const counts = (key: keyof typeof LOAD_FLASH_REPORTS): Sheet => ({ name: LOAD_FLASH_REPORTS[key], rows: reportRows(payload, key) });
  const ids = (key: FlashKind) => parcelRows(parcels.filter((parcel) => flashParcelMatches(parcel, key)), date, names);
  if (kind !== "full") {
    return [
      byDriver ? { name: "Driver", rows: driverRows(parcels, date, names) } : counts(kind),
      { name: "Tracking IDs", rows: ids(kind) }
    ];
  }
  return [
    ...(byDriver ? [] : [{ name: "Full data", rows: fullRows(payload, names) }, { name: "Hourly", rows: hourlyRows(payload) }]),
    { name: "Drivers", rows: driverRows(parcels, date, names) },
    ...(byDriver ? [] : (Object.keys(LOAD_FLASH_REPORTS) as Array<keyof typeof LOAD_FLASH_REPORTS>).map(counts)),
    { name: "Tracking IDs", rows: parcelRows(parcels, date, names) }
  ];
}

export function loadFlashReportFilename(date: string, kind: LoadFlashReportKind, scope = "") {
  const slug = kind === "full" ? "full" : LOAD_FLASH_REPORTS[kind].toLowerCase().replace(/\s+/g, "-");
  const suffix = scope.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `ops-live-${date}-${slug}${suffix ? `-${suffix}` : ""}.xlsx`;
}
