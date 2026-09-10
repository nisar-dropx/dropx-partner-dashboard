/** Previous-day 14:00 IST deadline for Connect shift swaps and Ops roster edits. */
export const ROSTER_CHANGE_DEADLINE_HOUR_IST = 14;

export function addCalendarDaysIso(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 2:00 PM IST on the calendar day before the roster date. */
export function rosterChangeDeadlineMs(rosterDate: string) {
  const previousDay = addCalendarDaysIso(rosterDate, -1);
  const hour = String(ROSTER_CHANGE_DEADLINE_HOUR_IST).padStart(2, "0");
  return Date.parse(`${previousDay}T${hour}:00:00+05:30`);
}

export function isRosterChangePastDeadline(rosterDate: string, nowMs = Date.now()) {
  const deadline = rosterChangeDeadlineMs(rosterDate);
  return !Number.isFinite(deadline) || nowMs >= deadline;
}

export function rosterChangeDeadlineMessage() {
  return "Changes close at 2:00 PM on the day before the roster date.";
}

export function rosterChangeDeadlineShortLabel() {
  return "Closed after 2:00 PM day before";
}
