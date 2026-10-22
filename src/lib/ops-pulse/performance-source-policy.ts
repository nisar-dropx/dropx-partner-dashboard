export const ACTIVE_DAILY_PERFORMANCE_SOURCE = "amazon_hawkeye_daily" as const;
export const ACTIVE_DAILY_PERFORMANCE_SOURCE_LABEL = "Hawkeye D-1";

/** Dark Store daily scorecard source (Quick Commerce Store Health PDF). */
export const STORE_HEALTH_DAILY_SOURCE = "qc_store_health_daily" as const;
export const STORE_HEALTH_DAILY_SOURCE_LABEL = "Store Health D-2";

export type DailyPerformanceSource =
  | typeof ACTIVE_DAILY_PERFORMANCE_SOURCE
  | typeof STORE_HEALTH_DAILY_SOURCE;

export function dailyPerformanceSourceForMode(mode: string | null | undefined): DailyPerformanceSource {
  return mode === "amazon_now" ? STORE_HEALTH_DAILY_SOURCE : ACTIVE_DAILY_PERFORMANCE_SOURCE;
}

export function dailyPerformanceSourceLabel(source: string | null | undefined) {
  if (source === STORE_HEALTH_DAILY_SOURCE) return STORE_HEALTH_DAILY_SOURCE_LABEL;
  if (source === ACTIVE_DAILY_PERFORMANCE_SOURCE) return ACTIVE_DAILY_PERFORMANCE_SOURCE_LABEL;
  if (source === "daily_edsp_metrics") return "Daily EDSP";
  return "Operational data";
}

type DailySourceFact = {
  batch_id: string;
  created_at: string;
  report_date: string | null;
  source_type: string;
  station_code?: string | null;
};

export function selectActiveDailyBatchRows<T extends DailySourceFact>(
  rows: T[],
  reportDate: string,
  sourceType: string = ACTIVE_DAILY_PERFORMANCE_SOURCE
) {
  const candidates = rows
    .filter((row) => row.source_type === sourceType && row.report_date === reportDate)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const batchId = candidates[0]?.batch_id ?? null;
  return {
    batchId,
    rows: batchId ? candidates.filter((row) => row.batch_id === batchId) : [] as T[],
  };
}

/** Prefer the active day batch; if this station was omitted from a later upload, keep its latest row for that date. */
export function selectStationDailyRow<T extends DailySourceFact>(
  rows: T[],
  reportDate: string,
  stationCode: string,
  normalize: (value: string | null | undefined) => string,
  sourceType: string = ACTIVE_DAILY_PERFORMANCE_SOURCE
) {
  const stationKey = normalize(stationCode);
  const forStation = rows
    .filter((row) => row.source_type === sourceType && row.report_date === reportDate && normalize(row.station_code) === stationKey)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  if (!forStation.length) return null;
  const active = selectActiveDailyBatchRows(forStation, reportDate, sourceType);
  return active.rows[0] ?? forStation[0] ?? null;
}
