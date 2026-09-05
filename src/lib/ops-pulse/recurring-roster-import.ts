export const recurringRosterDays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;

export type RecurringRosterDay = (typeof recurringRosterDays)[number];

export function addIsoDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayFor(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (weekday - 1));
  return date.toISOString().slice(0, 10);
}

export function recurringRosterDate(monday: string, day: RecurringRosterDay) {
  return addIsoDays(monday, recurringRosterDays.indexOf(day));
}

export function monthBoundsFromYm(ym: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error("Choose a valid roster month.");
  const [year, month] = ym.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

export function rosterMondayForMonth(
  ym: string,
  today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
) {
  const { start, end } = monthBoundsFromYm(ym);
  const currentYm = today.slice(0, 7);
  if (ym === currentYm) {
    const monday = mondayFor(today);
    return monday > end ? mondayFor(end) : monday;
  }
  const mondayOfFirstWeek = mondayFor(start);
  if (mondayOfFirstWeek >= start) return mondayOfFirstWeek;
  return addIsoDays(mondayOfFirstWeek, 7);
}

export type RosterBulkPeriodMode = "month" | "week";

export type RosterBulkUploadWindow = {
  mode: RosterBulkPeriodMode;
  label: string;
  periodStart: string;
  periodEnd: string;
  writeStart: string;
  writeEnd: string;
};

function validIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * Resolve the bulk-upload target window (same rules as People).
 * - week: exact Monday–Sunday week
 * - month: weekly pattern applied inside the selected calendar month
 */
export function resolveRosterBulkUploadWindow(input: {
  mode?: string | null;
  rosterMonth?: string | null;
  weekStart?: string | null;
  today?: string;
}): RosterBulkUploadWindow {
  const today = input.today
    ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const mode: RosterBulkPeriodMode = input.mode === "week" ? "week" : "month";

  if (mode === "week") {
    const raw = String(input.weekStart ?? today).trim();
    if (!validIsoDate(raw)) throw new Error("Choose a valid week start date.");
    const periodStart = mondayFor(raw);
    const periodEnd = addIsoDays(periodStart, 6);
    return {
      mode,
      label: `week ${periodStart} → ${periodEnd}`,
      periodStart,
      periodEnd,
      writeStart: periodStart,
      writeEnd: periodEnd
    };
  }

  const rosterMonth = String(input.rosterMonth ?? today.slice(0, 7)).trim();
  const bounds = monthBoundsFromYm(rosterMonth);
  const periodStart = rosterMondayForMonth(rosterMonth, today);
  const periodEnd = addIsoDays(periodStart, 6);
  return {
    mode,
    label: rosterMonth,
    periodStart,
    periodEnd,
    writeStart: bounds.start,
    writeEnd: bounds.end
  };
}

export function normalizeRosterCell(value: unknown) {
  const text = String(value ?? "").trim();
  const normalized = text.toUpperCase().replace(/[\s-]+/g, "_");
  if (!normalized) return { kind: "clear" as const, shiftCode: null };
  if (["WO", "WEEK_OFF", "WEEKLY_OFF", "OFF"].includes(normalized)) return { kind: "weekly_off" as const, shiftCode: null };
  return { kind: "working" as const, shiftCode: text.toUpperCase() };
}

export function resolveActiveRosterShift<T>(activeShifts: ReadonlyMap<string, T>, value: string | null) {
  const exactCode = String(value ?? "").trim().toUpperCase();
  if (!exactCode) return null;
  if (activeShifts.has(exactCode)) return activeShifts.get(exactCode) ?? null;

  const legacyClockCode = exactCode.match(/^SHIFT_(\d{1,2}):(\d{2})$/);
  if (!legacyClockCode) return null;
  const canonicalCode = `SHIFT_${legacyClockCode[1].padStart(2, "0")}_${legacyClockCode[2]}`;
  return activeShifts.get(canonicalCode) ?? null;
}
