import type { LoadFlashNetworkPayload, LoadFlashStation } from "@/lib/ops-pulse/edd-worker";

export const LOAD_FLASH_REPORTS = {
  load: "Total load",
  edd: "EDD today",
  road: "Out on road",
  delivered: "Delivered",
  returns: "Customer returns",
  pickups: "Pickup success"
} as const;

export type LoadFlashReportKind = keyof typeof LOAD_FLASH_REPORTS | "full";

function stationsOf(payload: LoadFlashNetworkPayload): LoadFlashStation[] {
  return [...payload.stations].sort((a, b) => a.stationCode.localeCompare(b.stationCode));
}

function fetched(row: LoadFlashStation) {
  return row.fetchedAt ?? "";
}

function fullRows(payload: LoadFlashNetworkPayload): Record<string, unknown>[] {
  return stationsOf(payload).map((row) => ({
    Date: payload.businessDate,
    Station: row.stationCode,
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
  return payload.hourly.map((point) => ({
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

export function loadFlashReportSheets(payload: LoadFlashNetworkPayload, kind: LoadFlashReportKind): Array<{ name: string; rows: Record<string, unknown>[] }> {
  if (kind !== "full") return [{ name: LOAD_FLASH_REPORTS[kind], rows: reportRows(payload, kind) }];
  return [
    { name: "Full data", rows: fullRows(payload) },
    { name: "Hourly", rows: hourlyRows(payload) },
    ...Object.entries(LOAD_FLASH_REPORTS).map(([key, name]) => ({
      name,
      rows: reportRows(payload, key as keyof typeof LOAD_FLASH_REPORTS)
    }))
  ];
}

export function loadFlashReportFilename(date: string, kind: LoadFlashReportKind) {
  const slug = kind === "full" ? "full" : LOAD_FLASH_REPORTS[kind].toLowerCase().replace(/\s+/g, "-");
  return `ops-live-${date}-${slug}.xlsx`;
}
