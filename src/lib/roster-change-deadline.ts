/** Default when hr_company_settings.roster_change_deadline_hour is missing. */
export const DEFAULT_ROSTER_CHANGE_DEADLINE_HOUR_IST = 16;

export function normalizeRosterChangeDeadlineHour(value: unknown, fallback = DEFAULT_ROSTER_CHANGE_DEADLINE_HOUR_IST) {
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : fallback;
}

export function formatRosterChangeDeadlineClock(hour: number) {
  const safe = normalizeRosterChangeDeadlineHour(hour);
  const suffix = safe >= 12 ? "PM" : "AM";
  const twelve = safe % 12 === 0 ? 12 : safe % 12;
  return `${twelve}:00 ${suffix}`;
}

export function addCalendarDaysIso(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Configured hour IST on the calendar day before the roster date. */
export function rosterChangeDeadlineMs(rosterDate: string, hour = DEFAULT_ROSTER_CHANGE_DEADLINE_HOUR_IST) {
  const previousDay = addCalendarDaysIso(rosterDate, -1);
  const safeHour = String(normalizeRosterChangeDeadlineHour(hour)).padStart(2, "0");
  return Date.parse(`${previousDay}T${safeHour}:00:00+05:30`);
}

export function isRosterChangePastDeadline(
  rosterDate: string,
  hour = DEFAULT_ROSTER_CHANGE_DEADLINE_HOUR_IST,
  nowMs = Date.now()
) {
  const deadline = rosterChangeDeadlineMs(rosterDate, hour);
  return !Number.isFinite(deadline) || nowMs >= deadline;
}

export function rosterChangeDeadlineMessage(hour = DEFAULT_ROSTER_CHANGE_DEADLINE_HOUR_IST) {
  return `Changes close at ${formatRosterChangeDeadlineClock(hour)} on the day before the roster date.`;
}

export function rosterChangeDeadlineShortLabel(hour = DEFAULT_ROSTER_CHANGE_DEADLINE_HOUR_IST) {
  return `Closed after ${formatRosterChangeDeadlineClock(hour)} day before`;
}

export function rosterChangeDeadlineTimeValue(hour = DEFAULT_ROSTER_CHANGE_DEADLINE_HOUR_IST) {
  return `${String(normalizeRosterChangeDeadlineHour(hour)).padStart(2, "0")}:00`;
}
