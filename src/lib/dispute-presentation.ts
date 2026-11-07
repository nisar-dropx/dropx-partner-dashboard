type Day = { date?: string; attendanceKnown?: boolean; units?: unknown };

export function attendanceLabel(day?: Omit<Day, "date">) {
  if (!day?.attendanceKnown || day.units == null || !Number.isFinite(Number(day.units))) return "Not available";
  const units = Number(day.units);
  if (units === 0) return "Not counted";
  if (units === 0.5) return "Half day";
  if (units === 1) return "Present";
  return `${units} recorded days · check source`;
}

export function attendanceDateChoices<T extends Day>(days: T[], issue?: string, concern?: string): T[] {
  if (issue !== "attendance") return days;
  if (!concern) return [];
  if (concern === "I worked but the day is missing") return days.filter(d => d.attendanceKnown && d.units != null && Number(d.units) === 0);
  if (concern === "Full day shown as half day") return days.filter(d => d.attendanceKnown && Number(d.units) === 0.5);
  return days;
}
