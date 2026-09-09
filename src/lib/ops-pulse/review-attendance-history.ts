export type AttendancePeriod = "7d" | "mtd";
export type HistoryStatus = "late" | "on_time" | "unplanned_absence" | "absence_unconfirmed" | "week_off_worked" | "week_off" | "leave" | "leave_pending" | "not_reported" | "upcoming" | "no_shift" | "outside_station" | "attendance_conflict";
export type AttendanceHistoryDay = {
  date: string; shift: string | null; inTime: string | null; outTime: string | null;
  workMinutes: number | null; lateMinutes: number | null; status: HistoryStatus; note: string;
};
export type AttendanceHistoryPerson = { id: string; name: string; code: string; role: string; days: AttendanceHistoryDay[] };
export type ReviewAttendanceHistory = { station: string; date: string; people: AttendanceHistoryPerson[] };
export const historyStatusLabels: Record<HistoryStatus, string> = {
  late: "Late", on_time: "On time", unplanned_absence: "Unplanned absence", absence_unconfirmed: "No punches · check",
  week_off_worked: "Worked on week-off", week_off: "Roster off", leave: "Approved leave", leave_pending: "Leave requested",
  not_reported: "Not reported yet", upcoming: "Shift not started", no_shift: "Shift not linked",
  outside_station: "Outside station / service dates", attendance_conflict: "Punch needs checking"
};
export function attendanceHistoryDates(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw Error("Choose a valid review date.");
  const end = Date.parse(date), from = Math.min(Date.parse(`${date.slice(0,7)}-01`), end - 6 * 86400000);
  return Array.from({length: Math.round((end-from)/86400000)+1}, (_,i) => new Date(from+i*86400000).toISOString().slice(0,10));
}
export function historyPeriodDays(person: AttendanceHistoryPerson, date: string, period: AttendancePeriod) {
  const from = period === "mtd" ? `${date.slice(0,7)}-01` : new Date(Date.parse(date)-6*86400000).toISOString().slice(0,10);
  return person.days.filter(day => day.date >= from && day.date <= date);
}
export function summarizeAttendance(days: AttendanceHistoryDay[]) {
  const late = days.filter(d => d.status === "late").length;
  const reported = days.filter(d => d.status === "late" || d.status === "on_time").length;
  return { late, reported, onTime: reported-late, repeated: late >= 2, allReportedLate: late >= 2 && late === reported,
    unplanned: days.filter(d => d.status === "unplanned_absence").length,
    unchecked: days.filter(d => d.status === "absence_unconfirmed" || d.status === "attendance_conflict").length,
    weekOffWorked: days.filter(d => d.status === "week_off_worked").length };
}
export type HistoryDayInput = {
  date: string; inScope: boolean; dayType: string | null; shift: string | null; start: string | null; end: string | null;
  grace: number; inTime: string | null; outTime: string | null; workMinutes: number | null; punchCount: number;
  attendanceStatus: string | null; approvedLeave: boolean; requestedLeave: boolean; ambiguousPunch?: boolean; rawActivityOnly?: boolean;
};
export function classifyAttendanceDay(input: HistoryDayInput, now = new Date()): AttendanceHistoryDay {
  const row: AttendanceHistoryDay = { date: input.date, shift: input.shift, inTime: input.inTime, outTime: input.outTime,
    workMinutes: input.inTime && input.outTime && input.workMinutes != null && input.workMinutes >= 0 ? input.workMinutes : null, lateMinutes: null, status: "no_shift", note: "" };
  if (!input.inScope) return { ...row, shift: null, inTime: null, outTime: null, workMinutes: null, status: "outside_station", note: "Only this station’s service dates are shown." };
  const punched = Boolean(input.inTime || input.outTime || input.punchCount);
  if (input.ambiguousPunch) return { ...row, status: "attendance_conflict", note: "Punch identifier matches multiple staff profiles; confirm ownership before classifying attendance." };
  if (input.rawActivityOnly && !input.inTime && !input.outTime) return { ...row, status: "attendance_conflict", note: "Raw punches are present but not reconciled to this person’s daily attendance; not classified absent or as confirmed week-off work." };
  if (input.dayType === "weekly_off") return { ...row, status: punched ? "week_off_worked" : "week_off", note: punched ? "Punch recorded on an approved weekly off; not an overtime or pay approval." : "Approved weekly off." };
  if (input.approvedLeave) return { ...row, status: "leave", note: punched ? "Punch recorded during approved leave; check attendance." : "Approved leave application." };
  if (input.dayType && input.dayType !== "working") return { ...row, status: "week_off", note: `Approved roster: ${input.dayType.replaceAll("_", " ")}.` };
  if (input.dayType !== "working" || !input.start || !input.end) return { ...row, note: "No approved working shift; lateness / absence is not assumed." };
  const start = Date.parse(`${input.date}T${input.start}+05:30`);
  let end = Date.parse(`${input.date}T${input.end}+05:30`);
  if (end <= start) end += 86400000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { ...row, note: "Invalid shift times; check the roster." };
  if (input.inTime && Number.isFinite(Date.parse(input.inTime))) {
    const lateMinutes = Math.max(0, Math.floor((Date.parse(input.inTime)-start)/60000) - Math.max(0,input.grace));
    return { ...row, lateMinutes, status: lateMinutes > 0 ? "late" : "on_time", note: `${input.grace} min approved reporting grace${!input.outTime ? " · missing out punch" : ""}.` };
  }
  if (punched) return { ...row, status: "attendance_conflict", note: "Punch activity exists without a valid in-time; not classified absent." };
  if (input.requestedLeave) return { ...row, status: "leave_pending", note: "Leave application exists; approval pending." };
  if (now.getTime() < start) return { ...row, status: "upcoming", note: "The scheduled shift has not started." };
  if (now.getTime() < end) return { ...row, status: "not_reported", note: "Shift still open; absence is not final." };
  const absent = ["A", "ABSENT"].includes(String(input.attendanceStatus ?? "").toUpperCase());
  return { ...row, status: absent ? "unplanned_absence" : "absence_unconfirmed",
    note: absent ? "Recorded absent on a working day, with no active leave application." : "Shift ended with no in/out evidence and no active leave application. Confirm absence or a missing sync; not confirmed leave." };
}
