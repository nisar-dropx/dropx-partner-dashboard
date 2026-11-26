/**
 * Dark Store PPI hourly table for WhatsApp cards and Site PPI.
 *
 * "As of HH:00 hrs" is the wall-clock IST hour of the report. The table lists
 * operating-day hours from 06:00 up through that wall hour that actually have
 * completions — empty hours (including the current as-of hour with no data yet)
 * are omitted.
 *
 * Midnight EOD cards use 06:00–24:00. Source hour 0 is shown as display hour 24
 * when it has data.
 */

export type PpiHourlySource = {
  hour: number;
  order_count: number;
  unit_count: number;
  avg_ppt_seconds: number | null;
};

export type PpiHourlyDisplayRow = {
  /** Display hour 6–23, or 24 on the midnight EOD card (maps from source hour 0). */
  hour: number;
  order_count: number;
  unit_count: number;
  avg_ppt_seconds: number | null;
  /** order_count × avg_ppt_seconds for SUM of PPT columns. */
  sum_ppt_seconds: number;
};

export const PPI_OPERATING_HOUR_START = 6;
export const PPI_OPERATING_HOUR_END = 23;
/** Midnight EOD closes with a 24:00 row (source bucket hour 0). */
export const PPI_EOD_DISPLAY_HOUR_END = 24;

/** IST wall clock from an absolute instant (default: now). */
export function istParts(atMs: number = Date.now()) {
  const ist = new Date(atMs + 5.5 * 3600 * 1000);
  return {
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
    date: ist.toISOString().slice(0, 10)
  };
}

function toDisplayRow(sourceHour: number, displayHour: number, byHour: Map<number, PpiHourlySource>): PpiHourlyDisplayRow | null {
  const row = byHour.get(sourceHour);
  const order_count = Number(row?.order_count ?? 0);
  if (!row || !Number.isFinite(order_count) || order_count <= 0) return null;
  const unit_count = Number(row?.unit_count ?? 0);
  const avg = row.avg_ppt_seconds == null || !Number.isFinite(Number(row.avg_ppt_seconds))
    ? null
    : Number(row.avg_ppt_seconds);
  return {
    hour: displayHour,
    order_count,
    unit_count,
    avg_ppt_seconds: avg,
    sum_ppt_seconds: avg != null ? avg * order_count : 0
  };
}

/**
 * Build the hourly rows shown under PPI.
 *
 * - Daytime (wallHour 6–23): hours 06:00 … wallHour that have orders.
 * - Midnight EOD card (wallHour 0): hours 06:00 … 23:00 with data, then 24:00 if hour 0 has data.
 * - Before 06:00 (except midnight EOD): empty — never a lone 00:00 orphan.
 * - Hours with no completions are never shown.
 */
export function buildPpiHourlyDisplay(
  rows: PpiHourlySource[],
  wallHour: number,
  options?: { midnightEod?: boolean }
): PpiHourlyDisplayRow[] {
  const hour = Number.isFinite(wallHour) ? Math.trunc(wallHour) : 0;
  const midnightEod = options?.midnightEod === true || hour === 0;
  if (!midnightEod && (hour < PPI_OPERATING_HOUR_START || hour > PPI_OPERATING_HOUR_END)) {
    return [];
  }

  const byHour = new Map<number, PpiHourlySource>();
  for (const row of rows ?? []) {
    const h = Number(row?.hour);
    if (!Number.isFinite(h) || h < 0 || h > 23) continue;
    byHour.set(h, row);
  }

  const from = PPI_OPERATING_HOUR_START;
  const to = midnightEod ? PPI_OPERATING_HOUR_END : Math.min(PPI_OPERATING_HOUR_END, hour);

  const out: PpiHourlyDisplayRow[] = [];
  for (let h = from; h <= to; h += 1) {
    const display = toDisplayRow(h, h, byHour);
    if (display) out.push(display);
  }
  if (midnightEod) {
    const eod = toDisplayRow(0, PPI_EOD_DISPLAY_HOUR_END, byHour);
    if (eod) out.push(eod);
  }
  return out;
}
