const IST_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * ISO week string like `2026-W33` for an IST calendar instant.
 * Matches Amazon Performance weekly picker.
 */
export function isoWeekIdFromMs(nowMs = Date.now()): string {
  const ist = new Date(nowMs + IST_OFFSET_MINUTES * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const date = new Date(Date.UTC(y, m, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const isoYear = date.getUTCFullYear();
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Current IST ISO week. Daily files (EDSP Daily Shipment count, Daily_EDSP_Metrics, …)
 * land in the week Amazon's picker is on today — last week keeps Saturday's drop.
 */
export function defaultSuppIsoWeek(nowMs = Date.now()): string {
  return isoWeekIdFromMs(nowMs);
}

export function isValidIsoWeekId(value: string): boolean {
  return /^\d{4}-W\d{2}$/.test(value);
}

/** ISO week of an IST calendar YYYY-MM-DD (noon IST to avoid midnight edges). */
export function isoWeekIdFromYmd(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) throw new Error(`Invalid date "${ymd}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const noonIstAsUtc = Date.UTC(year, month - 1, day, 6, 30, 0);
  return isoWeekIdFromMs(noonIstAsUtc);
}

/** isoWeek shifted by N weeks (negative = earlier). */
export function shiftIsoWeek(isoWeek: string, deltaWeeks: number): string {
  const mondayYmd = mondayYmdFromIsoWeek(isoWeek);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(mondayYmd);
  if (!match) throw new Error(`Invalid Monday date "${mondayYmd}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaWeeks * 7));
  const ymd = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  return isoWeekIdFromYmd(ymd);
}

/** Monday (UTC civil) of an ISO week — safe for Postgres `date` columns. */
export function mondayYmdFromIsoWeek(isoWeek: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) throw new Error(`Invalid ISO week "${isoWeek}"`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - day + 1);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const y = monday.getUTCFullYear();
  const mo = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const d = String(monday.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}
