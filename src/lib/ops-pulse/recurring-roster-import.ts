export const recurringRosterDays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;

export type RecurringRosterDay = (typeof recurringRosterDays)[number];

export function addIsoDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function recurringRosterDate(monday: string, day: RecurringRosterDay) {
  return addIsoDays(monday, recurringRosterDays.indexOf(day));
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
