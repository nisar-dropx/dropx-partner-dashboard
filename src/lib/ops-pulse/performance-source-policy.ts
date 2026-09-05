export const ACTIVE_DAILY_PERFORMANCE_SOURCE = "amazon_hawkeye_daily" as const;
export const ACTIVE_DAILY_PERFORMANCE_SOURCE_LABEL = "Hawkeye D-1";

type DailySourceFact = {
  batch_id: string;
  created_at: string;
  report_date: string | null;
  source_type: string;
  station_code?: string | null;
};

export function selectActiveDailyBatchRows<T extends DailySourceFact>(rows: T[], reportDate: string) {
  const candidates = rows
    .filter((row) => row.source_type === ACTIVE_DAILY_PERFORMANCE_SOURCE && row.report_date === reportDate)
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
  normalize: (value: string | null | undefined) => string
) {
  const stationKey = normalize(stationCode);
  const forStation = rows
    .filter((row) => row.source_type === ACTIVE_DAILY_PERFORMANCE_SOURCE && row.report_date === reportDate && normalize(row.station_code) === stationKey)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  if (!forStation.length) return null;
  const active = selectActiveDailyBatchRows(forStation, reportDate);
  return active.rows[0] ?? forStation[0] ?? null;
}
