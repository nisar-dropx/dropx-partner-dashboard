import { BOARD_TID } from "./station-board-tids.ts";

export type StationDsrMetric =
  | "eddPending"
  | "overduePending"
  | "dispatchUnconfirmed"
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
  overduePending: number;
  physicalAtStation: number;
  dispatchUnconfirmed: number;
};

export const STATION_DSR_INVENTORY_NOTE = "Pending today uses the selected EDD date; overdue stock is separate. Future EDD, return-to-FC stock and today's dispatched or attempted shipments are excluded.";
export const STATION_DSR_PENDING_HEADER = "EDD pending today";
export const STATION_DSR_OVERDUE_HEADER = "Overdue at station";

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

// Amazon uses both INDUCT and INDUCTED for the same receipt event.
const PHYSICAL_AT_STATION_STATES = new Set(["AT_STATION", "INDUCTED", "INDUCT", "RECEIVED"]);
const INVENTORY_BUCKETS = new Set<string>([BOARD_TID.EDD, BOARD_TID.AGEING]);

function uniqueTrackingRows(rows: StationDsrTidRow[]) {
  const unique = new Map<string, StationDsrTidRow>();
  for (const row of rows) {
    const trackingId = row.trackingId.trim();
    const key = `${row.stationCode}\t${trackingId}`;
    if (trackingId && !unique.has(key)) unique.set(key, { ...row, trackingId });
  }
  return [...unique.values()];
}

function normalizedState(row: StationDsrTidRow) {
  return String(row.currentState || row.status || "").trim().toUpperCase().replace(/\s+/g, "_");
}

function validDay(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

const inventoryKey = (row: StationDsrTidRow) => `${row.stationCode}\t${row.trackingId.trim()}`;

/** Both board feeds are needed: BoardEDD is the current inducted census across
 * all promised dates; BoardAgeing contains older stock only. Prefer the current
 * inducted record when an older ageing row repeats the same tracking ID. */
function dueStationStock(rows: StationDsrTidRow[], businessDate: string) {
  if (!validDay(businessDate)) return [];
  const stock = new Map<string, StationDsrTidRow>();
  for (const row of rows) {
    if (!INVENTORY_BUCKETS.has(row.sourceBucket)) continue;
    const key = inventoryKey(row);
    if (row.trackingId.trim() && (!stock.has(key) || row.sourceBucket === BOARD_TID.EDD)) stock.set(key, row);
  }
  return [...stock.values()].filter(row => validDay(row.edd) && row.edd <= businessDate
    && PHYSICAL_AT_STATION_STATES.has(normalizedState(row)));
}

/**
 * Confirmed pending stock is outside today's DSR cohort. A current receipt
 * must never erase today's dispatch/attempt. Other/pending is kept separate:
 * that bucket can represent either pre-dispatch assignment or a debrief after
 * going out, so it cannot prove that a parcel has never gone out today.
 */
export function physicalAtStationRows(rows: StationDsrTidRow[], businessDate: string) {
  const sameDayOutcome = new Set(rows.filter(row => OUTCOME_BUCKETS.has(row.sourceBucket)).map(inventoryKey));
  return uniqueTrackingRows(dueStationStock(rows, businessDate).filter(row => !sameDayOutcome.has(inventoryKey(row))));
}

export function stationDsrMetricRows(
  rows: StationDsrTidRow[],
  stationCode: string,
  businessDate: string,
  metric: StationDsrMetric,
) {
  const stationRows = rows.filter((row) => row.stationCode === stationCode);
  if (metric === "eddPending") {
    return physicalAtStationRows(stationRows, businessDate).filter(row => row.edd === businessDate).map(row => ({ ...row, status: STATION_DSR_PENDING_HEADER }));
  }
  if (metric === "overduePending") return physicalAtStationRows(stationRows, businessDate).filter(row => row.edd < businessDate).map(row => ({ ...row, status: STATION_DSR_OVERDUE_HEADER }));
  if (metric === "dispatchUnconfirmed") {
    const uncertain = new Set(stationRows.filter(row => row.sourceBucket === BOARD_TID.OTHER).map(inventoryKey));
    const confirmed = new Set(stationRows.filter(row => OUTCOME_BUCKETS.has(row.sourceBucket) && row.sourceBucket !== BOARD_TID.OTHER).map(inventoryKey));
    return uniqueTrackingRows(dueStationStock(stationRows, businessDate).filter(row => uncertain.has(inventoryKey(row)) && !confirmed.has(inventoryKey(row)))).map(row => ({ ...row, status: "Other / pending — dispatch needs verification" }));
  }
  if (metric === "physicalAtStation") return physicalAtStationRows(stationRows, businessDate);
  const buckets = METRIC_BUCKETS[metric];
  return uniqueTrackingRows(stationRows.filter((row) => buckets?.has(row.sourceBucket)));
}

export function summarizeStationDsrRows(rows: StationDsrTidRow[], businessDate: string, availableStations: string[] = []) {
  const codes = new Set([...availableStations, ...rows.map((row) => row.stationCode)].filter(Boolean));
  const summaries: Record<string, StationDsrInventorySummary> = {};
  for (const stationCode of codes) {
    summaries[stationCode] = {
      eddPending: stationDsrMetricRows(rows, stationCode, businessDate, "eddPending").length,
      overduePending: stationDsrMetricRows(rows, stationCode, businessDate, "overduePending").length,
      physicalAtStation: stationDsrMetricRows(rows, stationCode, businessDate, "physicalAtStation").length,
      dispatchUnconfirmed: stationDsrMetricRows(rows, stationCode, businessDate, "dispatchUnconfirmed").length,
    };
  }
  return summaries;
}

/** The station report's All TIDs sheet contains exactly the displayed pending
 * groups and assigned cohort. Never label the unfiltered future census as EDD pending. */
export function stationDsrReportRows(rows: StationDsrTidRow[], businessDate: string) {
  return [...new Set(rows.map(row => row.stationCode))].flatMap(code => [
    ...stationDsrMetricRows(rows, code, businessDate, "eddPending"),
    ...stationDsrMetricRows(rows, code, businessDate, "overduePending"),
    ...stationDsrMetricRows(rows, code, businessDate, "assigned"),
  ]);
}
