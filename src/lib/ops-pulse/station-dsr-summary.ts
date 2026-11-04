import { BOARD_TID } from "./station-board-tids.ts";

export type StationDsrMetric =
  | "eddPending"
  | "physicalAtStation"
  | "assigned"
  | "delivered"
  | "failed"
  | "rejected"
  | "onRoad"
  | "other";

export type StationDsrTidRow = {
  stationCode: string;
  trackingId: string;
  sourceBucket: string;
  status: string;
  currentState?: string;
  edd: string;
  driverId: string;
  driverName: string;
};

export type StationDsrInventorySummary = {
  eddPending: number;
  physicalAtStation: number;
};

const OUTCOME_BUCKETS = new Set<string>([
  BOARD_TID.DELIVERED,
  BOARD_TID.FAILED,
  BOARD_TID.REJECTED,
  BOARD_TID.OOR,
  BOARD_TID.OTHER,
  "Failed",
  "Rejected",
]);

const METRIC_BUCKETS: Partial<Record<StationDsrMetric, Set<string>>> = {
  assigned: OUTCOME_BUCKETS,
  delivered: new Set([BOARD_TID.DELIVERED]),
  failed: new Set([BOARD_TID.FAILED, "Failed"]),
  rejected: new Set([BOARD_TID.REJECTED, "Rejected"]),
  onRoad: new Set([BOARD_TID.OOR]),
  other: new Set([BOARD_TID.OTHER]),
};

const PHYSICAL_AT_STATION_STATES = new Set(["AT_STATION", "INDUCTED", "RECEIVED"]);

function uniqueTrackingRows(rows: StationDsrTidRow[]) {
  const unique = new Map<string, StationDsrTidRow>();
  for (const row of rows) {
    const trackingId = row.trackingId.trim();
    if (trackingId && !unique.has(trackingId)) unique.set(trackingId, row);
  }
  return [...unique.values()];
}

function normalizedState(row: StationDsrTidRow) {
  return String(row.currentState || row.status || "").trim().toUpperCase();
}

/**
 * Dispatch-eligible physical stock comes from the current Ageing census, not
 * the day's assigned-DA report. Only station-receipt states qualify. Future
 * EDD stock, Ready-for-FC/return transit/customer-hold states and shipments
 * that already failed/rejected today are excluded. A prior-day attempt that
 * is back at station remains eligible because it is not in today's outcome
 * buckets.
 */
export function physicalAtStationRows(rows: StationDsrTidRow[], businessDate: string) {
  const sameDayOutcome = new Set(
    rows
      .filter((row) => [BOARD_TID.FAILED, BOARD_TID.REJECTED, "Failed", "Rejected"].includes(row.sourceBucket))
      .map((row) => row.trackingId),
  );
  return uniqueTrackingRows(rows.filter((row) => {
    if (row.sourceBucket !== BOARD_TID.AGEING || sameDayOutcome.has(row.trackingId)) return false;
    if (row.edd && row.edd > businessDate) return false;
    return PHYSICAL_AT_STATION_STATES.has(normalizedState(row));
  }));
}

export function stationDsrMetricRows(
  rows: StationDsrTidRow[],
  stationCode: string,
  businessDate: string,
  metric: StationDsrMetric,
) {
  const stationRows = rows.filter((row) => row.stationCode === stationCode);
  if (metric === "eddPending") {
    return uniqueTrackingRows(stationRows.filter((row) => row.sourceBucket === BOARD_TID.EDD));
  }
  if (metric === "physicalAtStation") return physicalAtStationRows(stationRows, businessDate);
  const buckets = METRIC_BUCKETS[metric];
  return uniqueTrackingRows(stationRows.filter((row) => buckets?.has(row.sourceBucket)));
}

export function summarizeStationDsrRows(rows: StationDsrTidRow[], businessDate: string) {
  const codes = new Set(rows.map((row) => row.stationCode).filter(Boolean));
  const summaries: Record<string, StationDsrInventorySummary> = {};
  for (const stationCode of codes) {
    summaries[stationCode] = {
      eddPending: stationDsrMetricRows(rows, stationCode, businessDate, "eddPending").length,
      physicalAtStation: stationDsrMetricRows(rows, stationCode, businessDate, "physicalAtStation").length,
    };
  }
  return summaries;
}
