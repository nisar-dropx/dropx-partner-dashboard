/**
 * Which dates a person may request for each kind of leave (YYYY-MM-DD, IST).
 * The server computes this once and sends it to DropX One, so the date pickers
 * and the submit check always agree. Rules agreed with HR on 2026-09-25:
 *
 * - Casual / Sick leave: any date in the current month or the next month. On
 *   the 1st and 2nd of a month, dates in the previous month are allowed too
 *   (a short window to record leave already taken).
 * - Comp-off (earned by working a week off or holiday): from the leave type's
 *   apply-earliest setting (day after worked, earning-month start, or N days
 *   before the worked day in the same month) until the credit lapses - week-off
 *   covers dates up to month end and can be applied until the attendance close
 *   day of the next month; holiday on/before the 25th stays usable through the
 *   2nd of the next month, later holidays use the configured day count. A
 *   restored credit may carry usableFrom / applyUntil overrides.
 * - Every other leave type: today onwards (unchanged).
 */
export type LeaveDateWindow = { earliest: string; latest: string | null };

export type CompOffApplyEarliestMode = "day_after" | "month_start" | "days_before";

export type CompOffApplyEarliestSettings = {
  earliestMode: CompOffApplyEarliestMode;
  daysBefore: number | null;
};

/**
 * validUntil: the last leave date this credit can cover.
 * applyUntil: the last day a request using it can be submitted (defaults to validUntil).
 * usableFrom: optional override for the earliest leave date this credit may cover.
 */
export type CompOffCredit = {
  referenceDate: string;
  validUntil: string;
  applyUntil?: string;
  usableFrom?: string | null;
};

const BACKDATE_GRACE_DAY = 2;

function parts(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function iso(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function firstOfMonth(date: string, monthOffset = 0) {
  const { year, month } = parts(date);
  return iso(year, month + monthOffset, 1);
}

export function lastOfMonth(date: string, monthOffset = 0) {
  const { year, month } = parts(date);
  return iso(year, month + monthOffset + 1, 0);
}

export function isMonthlyCapLeaveCode(code: string) {
  return ["CASUAL", "SICK"].includes(code.trim().toUpperCase());
}

/**
 * Validity end for one comp-off credit, per the leave type's lapse settings.
 * Ledger sources: 'comp_off_earned_week_off' for a worked week off, and
 * 'comp_off_earned' for a worked holiday. Matches HRMS
 * hr_lapse_comp_off_by_source: mid-month holidays stay open through the 2nd of
 * the next month; late-month holidays use the configured day count. A credit
 * that never lapses is usable until `noLapseLatest`.
 */
export function compOffValidUntil(
  referenceDate: string,
  source: string,
  settings: { weekOffLapsesMonthly: boolean; holidayLapseDays: number | null },
  noLapseLatest: string
) {
  if (/week_off/.test(source)) return settings.weekOffLapsesMonthly ? lastOfMonth(referenceDate) : noLapseLatest;
  if (parts(referenceDate).day > 25) {
    return settings.holidayLapseDays != null ? addDays(referenceDate, settings.holidayLapseDays) : noLapseLatest;
  }
  const { year, month } = parts(referenceDate);
  return iso(year, month + 1, 2);
}

/**
 * Last day a request using this credit can still be submitted. A monthly-lapsing week-off
 * credit follows the attendance month close (hr_company_settings.regularization_close_day):
 * with close day 2, September credits can be applied for (September dates only) until
 * 2 October, and hr_lapse_week_off_comp_off lapses them on 3 October.
 */
export function compOffApplyUntil(
  source: string,
  validUntil: string,
  settings: { weekOffLapsesMonthly: boolean },
  closeDay: number | null
) {
  if (/week_off/.test(source) && settings.weekOffLapsesMonthly && closeDay != null && closeDay > 0) {
    const { year, month } = parts(validUntil);
    return iso(year, month + 1, closeDay);
  }
  return validUntil;
}

/**
 * Earliest leave date one credit may cover. Ledger usableFrom wins when set
 * (HR restore). Otherwise the leave type's apply-earliest mode applies; prior
 * dates never cross out of the earning calendar month.
 */
export function compOffUsableFrom(
  referenceDate: string,
  settings: CompOffApplyEarliestSettings = { earliestMode: "day_after", daysBefore: null },
  override?: string | null
) {
  if (override) return override;
  const monthStart = firstOfMonth(referenceDate);
  if (settings.earliestMode === "month_start") return monthStart;
  if (settings.earliestMode === "days_before") {
    const days = Math.max(0, Number(settings.daysBefore) || 0);
    const candidate = addDays(referenceDate, -days);
    return candidate < monthStart ? monthStart : candidate;
  }
  return addDays(referenceDate, 1);
}

export function leaveDateWindow(input: {
  code: string;
  balanceMode: string;
  today: string;
  credits?: CompOffCredit[];
  applyEarliest?: CompOffApplyEarliestSettings;
}): LeaveDateWindow | null {
  const { code, balanceMode, today } = input;
  if (balanceMode === "earned_balance") {
    const settings = input.applyEarliest ?? { earliestMode: "day_after" as const, daysBefore: null };
    const live = (input.credits ?? []).filter((credit) => (credit.applyUntil ?? credit.validUntil) >= today);
    if (!live.length) return null;
    const earliest = live.reduce((min, credit) => {
      const from = compOffUsableFrom(credit.referenceDate, settings, credit.usableFrom);
      return from < min ? from : min;
    }, compOffUsableFrom(live[0].referenceDate, settings, live[0].usableFrom));
    const latest = live.reduce((max, credit) => (credit.validUntil > max ? credit.validUntil : max), live[0].validUntil);
    return earliest <= latest ? { earliest, latest } : null;
  }
  if (balanceMode === "annual_balance" && isMonthlyCapLeaveCode(code)) {
    const earliest = parts(today).day <= BACKDATE_GRACE_DAY ? firstOfMonth(today, -1) : firstOfMonth(today);
    return { earliest, latest: lastOfMonth(today, 1) };
  }
  return { earliest: today, latest: null };
}

/**
 * Ledger remaining can still count an earned credit after its apply-by date.
 * The date picker only opens when `dateWindow` is non-null, so the dropdown
 * "N available" must use the same gate — otherwise DropX One shows "1 available"
 * with every date disabled (Holiday Comp Off after its lapse days).
 */
export function earnedLeaveAvailable(remaining: number | null | undefined, dateWindow: LeaveDateWindow | null) {
  if (dateWindow == null) return 0;
  const value = Number(remaining);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Days posted as lapse debits on the leave ledger (comp_off_lapsed / holiday lapsed). */
export function earnedLeaveLapsedDays(entries: Array<{ source?: string | null; days?: number | null }>) {
  return entries.reduce((total, entry) => {
    if (!/lapsed/i.test(String(entry.source ?? ""))) return total;
    const value = Number(entry.days);
    if (!Number.isFinite(value)) return total;
    return total + Math.abs(value);
  }, 0);
}

/** null when allowed, otherwise the reason. */
export function leaveDatesOutsideWindow(window: LeaveDateWindow | null, fromDate: string, toDate: string, leaveName: string) {
  if (!window) return `No ${leaveName} is available to use right now.`;
  if (fromDate < window.earliest) {
    return `${leaveName} can start on ${displayDate(window.earliest)} at the earliest.`;
  }
  if (window.latest && toDate > window.latest) {
    return `${leaveName} must end by ${displayDate(window.latest)}.`;
  }
  return null;
}

/** YYYY-MM-DD -> DD/MM/YYYY, as shown in the app. */
function displayDate(date: string) {
  return date.split("-").reverse().join("/");
}
