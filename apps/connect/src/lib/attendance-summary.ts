import { attendanceDayInsight, type AttendanceInsightRow } from "./attendance-insights.ts";

export type AttendanceFilter = "all" | "fullDay" | "halfDay" | "absent" | "needsReview" | "lateIn" | "earlyOut";
export const attendanceFilterLabels: Record<AttendanceFilter, string> = {
  all: "All dates", fullDay: "Full day", halfDay: "Half day", absent: "Absent",
  needsReview: "Needs review", lateIn: "Late in", earlyOut: "Early out"
};
export type AttendanceSummaryContext = { today: string; openShiftDate?: string | null };

/** Summarize evaluated rows only AFTER roster, leave, holiday and correction overlays.
 * The API, dashboard, calendar and drill-down share this classification.
 * Correctable absence is still absence, not a second Needs review category.
 * This is display logic only; it does not change attendance or payroll records. */
export function summarizeAttendance<T extends AttendanceInsightRow>(rows: T[], context: AttendanceSummaryContext) {
  const groups: Record<AttendanceFilter, T[]> = { all: [], fullDay: [], halfDay: [], absent: [], needsReview: [], lateIn: [], earlyOut: [] };
  let inProgress = 0;
  for (const row of new Map(rows.map(row => [row.date, row])).values()) {
    if (row.date > context.today) continue;
    groups.all.push(row);
    const insight = attendanceDayInsight(row, { today: row.date === context.today, shiftOpen: row.date === context.openShiftDate });
    if (insight.calendarClass === "on-shift") inProgress++;
    else if (insight.payDayType === "present" || insight.payDayType === "present_wfh") groups.fullDay.push(row);
    else if (insight.payDayType === "half_day") groups.halfDay.push(row);
    else if (insight.payDayType === "absent") groups.absent.push(row);
    else if (insight.payDayType === "needs_review") groups.needsReview.push(row);
    if (insight.issues.some(issue => issue.code === "late")) groups.lateIn.push(row);
    if (insight.issues.some(issue => issue.code === "early_out")) groups.earlyOut.push(row);
  }
  for (const group of Object.values(groups)) group.sort((a, b) => b.date.localeCompare(a.date));
  const fullDay = groups.fullDay.length, halfDay = groups.halfDay.length, absent = groups.absent.length, needsReview = groups.needsReview.length;
  return { groups, fullDay, halfDay, absent, needsReview, inProgress, present: fullDay,
    lateIn: groups.lateIn.length, earlyOut: groups.earlyOut.length,
    totalRows: groups.all.length, trackedDays: fullDay + halfDay + absent + needsReview,
    misPunch: groups.needsReview.filter(row => attendanceDayInsight(row).issues.some(issue => issue.code === "missing_punch")).length };
}

export function attendanceCorrectionHint(row: { regularization?: { status: string } | null; regularizationOpen?: boolean }) {
  if (row.regularization) return `Correction ${row.regularization.status.replaceAll("_", " ")}`;
  return row.regularizationOpen === false ? "Correction window closed · Contact HR" : "View day to review or request correction";
}
