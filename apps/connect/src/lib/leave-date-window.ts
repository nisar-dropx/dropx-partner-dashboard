/**
 * Which dates a person may request for each kind of leave (YYYY-MM-DD, IST).
 * The server computes this once and sends it to DropX One, so the date pickers
 * and the submit check always agree. Rules agreed with HR on 2026-09-25:
 *
 * - Casual / Sick leave: any date in the current month or the next month. On
 *   the 1st and 2nd of a month, dates in the previous month are allowed too
 *   (a short window to record leave already taken).
 * - Comp-off (earned by working a week off or holiday): from the day after
 *   the day worked, until the credit lapses - week-off comp-off covers dates
 *   up to the end of the calendar month it was earned in, and can be applied
 *   for until the attendance month close day of the next month; holiday
 *   comp-off after the configured number of days.
 * - Every other leave type: today onwards (unchanged).
 */
export type LeaveDateWindow = { earliest: string; latest: string | null };

/**
 * validUntil: the last leave date this credit can cover.
 * applyUntil: the last day a request using it can be submitted (defaults to validUntil).
 */
export type CompOffCredit = { referenceDate: string; validUntil: string; applyUntil?: string };

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
 * 'comp_off_earned' for a worked holiday. A credit that never lapses is
 * usable until `noLapseLatest`.
 */
export function compOffValidUntil(
  referenceDate: string,
  source: string,
  settings: { weekOffLapsesMonthly: boolean; holidayLapseDays: number | null },
  noLapseLatest: string
) {
  if (/week_off/.test(source)) return settings.weekOffLapsesMonthly ? lastOfMonth(referenceDate) : noLapseLatest;
  return settings.holidayLapseDays != null ? addDays(referenceDate, settings.holidayLapseDays) : noLapseLatest;
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

export function leaveDateWindow(input: {
  code: string;
  balanceMode: string;
  today: string;
  credits?: CompOffCredit[];
}): LeaveDateWindow | null {
  const { code, balanceMode, today } = input;
  if (balanceMode === "earned_balance") {
    const live = (input.credits ?? []).filter((credit) => (credit.applyUntil ?? credit.validUntil) >= today);
    if (!live.length) return null;
    const earliest = addDays(live.reduce((min, credit) => (credit.referenceDate < min ? credit.referenceDate : min), live[0].referenceDate), 1);
    const latest = live.reduce((max, credit) => (credit.validUntil > max ? credit.validUntil : max), live[0].validUntil);
    return earliest <= latest ? { earliest, latest } : null;
  }
  if (balanceMode === "annual_balance" && isMonthlyCapLeaveCode(code)) {
    const earliest = parts(today).day <= BACKDATE_GRACE_DAY ? firstOfMonth(today, -1) : firstOfMonth(today);
    return { earliest, latest: lastOfMonth(today, 1) };
  }
  return { earliest: today, latest: null };
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
