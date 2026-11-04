import { BOARD_TID } from "./station-board-tids.ts";

export type StationDsrMetric = "eddPending" | "physicalAtStation" | "assigned" | "delivered" | "failed" | "rejected" | "onRoad" | "other";
export type StationDsrTidRow = {
  stationCode: string; trackingId: string; sourceBucket: string; status: string;
  currentState?: string; edd: string; driverId: string; driverName: string;
};
export type StationDsrInventorySummary = { eddPending: number; physicalAtStation: number };
export const STATION_DSR_PENDING_HEADER = "EDD pending today";
export const STATION_DSR_PHYSICAL_HEADER = "Physical at station";
export const STATION_DSR_INVENTORY_NOTE = "EDD pending: due on the selected date and not dispatched or attempted that day. Physical at station: all stock present, including future, overdue, held and returned parcels. Pending is included in physical; do not add the two counts.";

const OUTCOME_BUCKETS = new Set<string>([BOARD_TID.DELIVERED, BOARD_TID.FAILED, BOARD_TID.REJECTED, BOARD_TID.OOR, BOARD_TID.OTHER, "Failed", "Rejected"]);
const METRIC_BUCKETS: Record<StationDsrMetric, Set<string>> = {
  eddPending: new Set([BOARD_TID.PENDING_TODAY]),
  physicalAtStation: new Set([BOARD_TID.PHYSICAL]),
  assigned: OUTCOME_BUCKETS,
  delivered: new Set([BOARD_TID.DELIVERED]), failed: new Set([BOARD_TID.FAILED, "Failed"]),
  rejected: new Set([BOARD_TID.REJECTED, "Rejected"]), onRoad: new Set([BOARD_TID.OOR]), other: new Set([BOARD_TID.OTHER]),
};
const keyOf = (row: StationDsrTidRow) => `${row.stationCode}\t${row.trackingId.trim()}`;
function uniqueRows(rows: StationDsrTidRow[]) {
  const unique = new Map<string, StationDsrTidRow>();
  for (const row of rows) if (row.trackingId.trim() && !unique.has(keyOf(row))) unique.set(keyOf(row), { ...row, trackingId: row.trackingId.trim() });
  return [...unique.values()];
}

/** The worker verifies complete dated history before publishing these buckets.
 * Never infer physical location or first dispatch from a daily outcome bucket. */
export function stationDsrMetricRows(rows: StationDsrTidRow[], stationCode: string, businessDate: string, metric: StationDsrMetric) {
  return uniqueRows(rows.filter(row => row.stationCode === stationCode && METRIC_BUCKETS[metric].has(row.sourceBucket)
    && (metric !== "eddPending" || row.edd === businessDate)));
}

export function summarizeStationDsrRows(rows: StationDsrTidRow[], businessDate: string, completeStations: string[] = []) {
  const codes = new Set([...completeStations, ...rows.filter(row => row.sourceBucket === BOARD_TID.PHYSICAL || row.sourceBucket === BOARD_TID.PENDING_TODAY).map(row => row.stationCode)]);
  const summaries: Record<string, StationDsrInventorySummary> = {};
  for (const code of codes) summaries[code] = {
    eddPending: stationDsrMetricRows(rows, code, businessDate, "eddPending").length,
    physicalAtStation: stationDsrMetricRows(rows, code, businessDate, "physicalAtStation").length,
  };
  return summaries;
}

/** Overlapping stock/outcome groups become flags on one Excel row per TID. */
export function stationDsrReportRows(rows: StationDsrTidRow[], businessDate: string) {
  const physical = new Map(rows.filter(row => row.sourceBucket === BOARD_TID.PHYSICAL).map(row => [keyOf(row), row]));
  const pending = new Set(rows.filter(row => row.sourceBucket === BOARD_TID.PENDING_TODAY && row.edd === businessDate).map(keyOf));
  const assigned = new Map(rows.filter(row => OUTCOME_BUCKETS.has(row.sourceBucket)).map(row => [keyOf(row), row]));
  return uniqueRows([...physical.values(), ...assigned.values()]).map(row => ({
    ...row, currentState: physical.get(keyOf(row))?.currentState || row.currentState,
    eddPending: pending.has(keyOf(row)), physicalAtStation: physical.has(keyOf(row)),
    assigned: assigned.has(keyOf(row)), dsrOutcome: assigned.get(keyOf(row))?.status || "",
  }));
}
