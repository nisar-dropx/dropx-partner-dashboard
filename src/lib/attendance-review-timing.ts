export const MISSING_PUNCH_REVIEW_DELAY_MINUTES = 4 * 60;

function clockParts(value: string | null | undefined) {
  const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

function istClockTime(punchDate: string, clock: { hours: number; minutes: number }) {
  const hours = String(clock.hours).padStart(2, "0");
  const minutes = String(clock.minutes).padStart(2, "0");
  const value = new Date(`${punchDate}T${hours}:${minutes}:00+05:30`);
  return Number.isNaN(value.getTime()) ? null : value;
}

export function attendanceReviewDueAt({
  delayMinutes = MISSING_PUNCH_REVIEW_DELAY_MINUTES,
  punchDate,
  scheduledEnd,
  scheduledStart
}: {
  delayMinutes?: number;
  punchDate: string;
  scheduledEnd: string | null | undefined;
  scheduledStart: string | null | undefined;
}) {
  const startClock = clockParts(scheduledStart);
  const endClock = clockParts(scheduledEnd);
  if (!startClock || !endClock) return null;

  const start = istClockTime(punchDate, startClock);
  const end = istClockTime(punchDate, endClock);
  if (!start || !end) return null;
  if (end <= start) end.setDate(end.getDate() + 1);
  return new Date(end.getTime() + Math.max(0, delayMinutes) * 60_000);
}

export function isAttendanceReviewDue(input: Parameters<typeof attendanceReviewDueAt>[0], now = new Date()) {
  const dueAt = attendanceReviewDueAt(input);
  return Boolean(dueAt && now >= dueAt);
}
