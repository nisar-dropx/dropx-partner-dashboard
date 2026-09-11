import type { AttendanceCalendarClass, AttendancePayDayType } from "@/lib/attendance-pay-day";
import { calendarClassForPayDayType, resolveAttendancePayDayType } from "@/lib/attendance-pay-day";

export type AttendanceInsightTone = "green" | "amber" | "red" | "blue" | "neutral";

export type AttendanceInsightRow = {
  date: string;
  status: string;
  statusLabel?: string | null;
  statusKind?: "attendance" | "leave" | "paid_leave";
  isPaidLeave?: boolean | null;
  payDayType?: AttendancePayDayType | null;
  attendanceStatus?: string | null;
  inTime: string;
  outTime: string;
  workHours: string;
  punchCount: number;
  remark: string;
  workMode?: "onsite" | "wfh" | string | null;
  lateMinutes?: number;
  earlyOutMinutes?: number;
  scheduledStart?: string;
  scheduledEnd?: string;
  shiftName?: string;
  shiftSource?: string;
};

export type AttendanceIssueCode =
  | "late"
  | "early_out"
  | "half_day"
  | "absent"
  | "missing_punch"
  | "policy_review";

export type AttendanceIssue = {
  code: AttendanceIssueCode;
  label: string;
  message: string;
  tone: Exclude<AttendanceInsightTone, "blue" | "neutral">;
};

export type AttendanceDayInsight = {
  calendarClass: AttendanceCalendarClass;
  detail: string;
  headline: string;
  issues: AttendanceIssue[];
  label: string;
  needsRegularization: boolean;
  payDayType: AttendancePayDayType;
  tone: AttendanceInsightTone;
};

export type AttendanceCompactNudge = {
  detail: string;
  headline: string;
  tone: AttendanceInsightTone;
};

function normalized(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replaceAll("_", " ");
}

function pluralMinutes(value: number) {
  const minutes = Math.max(1, Math.round(value));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function rosterExpectation(row: AttendanceInsightRow) {
  return row.scheduledStart && row.scheduledStart !== "--:--" && row.inTime
    ? `Expected ${row.scheduledStart} · reported ${row.inTime}. `
    : "";
}

function workedDuration(value: string) {
  const [hours, minutes] = String(value ?? "").split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return value || "0 min";
  return pluralMinutes(hours * 60 + minutes);
}

function durationOutcomeDetail(row: AttendanceInsightRow, outcome: "Half Day" | "Absent") {
  const worked = workedDuration(row.workHours);
  const reason = outcome === "Half Day"
    ? `You worked ${worked}, below the full-day requirement. This day is marked Half Day and the applicable deduction will be made under company HR policy.`
    : `You worked ${worked}, below the half-day requirement. This day is marked Absent and the applicable deduction will be made under company HR policy.`;
  return `${reason} If the attendance record is wrong, request regularization.`;
}

function minutesFromRemark(remark: string, kind: "late" | "early") {
  const pattern = kind === "late"
    ? /(\d+)\s*min(?:ute)?s?\s+late/i
    : /(\d+)\s*min(?:ute)?s?\s+early(?:\s+departure|\s+out)?/i;
  const match = remark.match(pattern);
  return match ? Math.max(0, Number(match[1])) : 0;
}

/** Prefer API minutes; fall back to People-style remark notes when variance is missing. */
export function resolveLateMinutes(row: AttendanceInsightRow) {
  const reported = Math.max(0, Number(row.lateMinutes ?? 0));
  if (reported > 0) return reported;
  return minutesFromRemark(row.remark ?? "", "late");
}

export function resolveEarlyOutMinutes(row: AttendanceInsightRow) {
  const reported = Math.max(0, Number(row.earlyOutMinutes ?? 0));
  if (reported > 0) return reported;
  return minutesFromRemark(row.remark ?? "", "early");
}

function previousIsoDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function isCurrentAttendanceAttentionDate(recordDate: string, todayDate: string) {
  return recordDate === todayDate || recordDate === previousIsoDate(todayDate);
}

function fallbackLabel(row: AttendanceInsightRow) {
  const status = row.status.toUpperCase();
  if (status === "P") return "Present";
  if (status === "A") return "Absent";
  if (status === "HD") return "Half day";
  if (status === "WO") return "Weekly off";
  if (status === "H") return "Holiday";
  return row.status || "No record";
}

function outcomeLabel(row: AttendanceInsightRow) {
  return row.statusLabel || row.attendanceStatus || fallbackLabel(row);
}

function resolvePayDayType(row: AttendanceInsightRow): AttendancePayDayType {
  return row.payDayType
    ?? resolveAttendancePayDayType({
      status: row.status,
      statusLabel: row.statusLabel,
      attendanceStatus: row.attendanceStatus,
      workMode: row.workMode,
      isPaidLeave: row.isPaidLeave
    });
}

export function attendanceDayInsight(
  row: AttendanceInsightRow | undefined,
  options: { shiftOpen?: boolean; today?: boolean } = {}
): AttendanceDayInsight {
  if (!row) {
    return {
      calendarClass: "off",
      detail: "No attendance record is available for this day.",
      headline: "No record",
      issues: [],
      label: "No record",
      needsRegularization: false,
      payDayType: "no_record",
      tone: "neutral"
    };
  }

  const label = outcomeLabel(row);
  const state = normalized(label);
  const remark = normalized(row.remark);
  const lateMinutes = resolveLateMinutes(row);
  const earlyOutMinutes = resolveEarlyOutMinutes(row);
  const missingPunch = row.status.toUpperCase() !== "A"
    && row.punchCount > 0
    && (row.punchCount < 2 || !row.outTime || /single|missing/.test(remark));
  const needsPolicyReview = state.includes("needs review");
  const payDayType = resolvePayDayType(row);

  const issues: AttendanceIssue[] = [];
  if (lateMinutes > 0) {
    issues.push({
      code: "late",
      label: `Reported ${pluralMinutes(lateMinutes)} late`,
      message: `${rosterExpectation(row)}Late penalty applies under company HR policy. Any applicable deduction will appear in an upcoming payment.`,
      tone: "amber"
    });
  }
  if (earlyOutMinutes > 0) {
    issues.push({
      code: "early_out",
      label: `Early out ${pluralMinutes(earlyOutMinutes)}`,
      message: `${row.scheduledEnd && row.scheduledEnd !== "--:--" ? `Expected shift end ${row.scheduledEnd}. ` : ""}Early-out penalty applies under company HR policy. Any applicable deduction will appear in an upcoming payment.`,
      tone: "amber"
    });
  }

  if (payDayType === "unpaid_leave" || row.statusKind === "leave") {
    return {
      calendarClass: "leave",
      detail: "Unpaid leave / LOP is recorded for this day (used by HRMS payroll).",
      headline: label,
      issues: [],
      label,
      needsRegularization: false,
      payDayType: "unpaid_leave",
      tone: "red"
    };
  }

  if (payDayType === "paid_leave" || row.statusKind === "paid_leave" || row.isPaidLeave === true) {
    return {
      calendarClass: "paid-leave",
      detail: "Paid leave is applied for this day (counts as paid time in HRMS payroll).",
      headline: label,
      issues: [],
      label,
      needsRegularization: false,
      payDayType: "paid_leave",
      tone: "blue"
    };
  }

  if (payDayType === "present_wfh" || row.workMode === "wfh" || /work from home|\bwfh\b/.test(state) || /work from home|\bwfh\b/.test(remark)) {
    return {
      calendarClass: "paid-leave",
      detail: "Approved work from home. Present · WFH is recorded as paid working time.",
      headline: "Present · WFH",
      issues: [],
      label: "Present · WFH",
      needsRegularization: false,
      payDayType: "present_wfh",
      tone: "blue"
    };
  }

  if (row.workMode === "business_trip" || /business trip/.test(state) || /business trip/.test(remark)) {
    return {
      calendarClass: "paid-leave",
      detail: "Approved business trip. Present · Business trip is recorded as paid working time.",
      headline: "Present · Business trip",
      issues: [],
      label: "Present · Business trip",
      needsRegularization: false,
      payDayType: "present_wfh",
      tone: "blue"
    };
  }

  if (payDayType === "week_off" || statusIsWeekOff(row, state)) {
    return {
      calendarClass: "week-off",
      detail: "Weekly off is recorded for this day.",
      headline: /present/.test(state) ? label : "Weekly off",
      issues: [],
      label: /present/.test(state) ? label : "Weekly off",
      needsRegularization: false,
      payDayType: "week_off",
      tone: "neutral"
    };
  }

  if (payDayType === "paid_holiday" || statusIsHoliday(row, state)) {
    return {
      calendarClass: "week-off",
      detail: "Paid holiday is recorded for this day.",
      headline: /present/.test(state) ? label : "Holiday",
      issues: [],
      label: /present/.test(state) ? label : "Holiday",
      needsRegularization: false,
      payDayType: "paid_holiday",
      tone: "amber"
    };
  }

  if (options.today && options.shiftOpen) {
    const late = issues.find((issue) => issue.code === "late");
    return {
      calendarClass: "on-shift",
      detail: late?.message ?? "Your workday is open. Remember to punch out at the end of the shift.",
      headline: late ? `You checked in ${pluralMinutes(lateMinutes)} late` : "You are on shift",
      issues,
      label: late ? "On shift · Late" : "On shift",
      needsRegularization: false,
      payDayType: "present",
      tone: late ? "amber" : "green"
    };
  }

  if (missingPunch) {
    issues.push({
      code: "missing_punch",
      label: "Punch missing",
      message: "Regularize this day to avoid an attendance deduction.",
      tone: "red"
    });
    return {
      calendarClass: "review",
      detail: "A punch is missing. Submit regularization for review.",
      headline: "Attendance needs review",
      issues,
      label: "Needs review",
      needsRegularization: true,
      payDayType: "needs_review",
      tone: "red"
    };
  }

  if (needsPolicyReview || payDayType === "needs_review") {
    issues.push({
      code: "policy_review",
      label: "Needs review",
      message: "Open this day and regularize it if the attendance outcome is incorrect.",
      tone: "red"
    });
    return {
      calendarClass: "review",
      detail: "Company HR policy marked this day for review.",
      headline: "Attendance needs review",
      issues,
      label: "Needs review",
      needsRegularization: true,
      payDayType: "needs_review",
      tone: "red"
    };
  }

  if (payDayType === "absent" || state.includes("absent") || row.status.toUpperCase() === "A") {
    issues.push({
      code: "absent",
      label: "Absent",
      message: "Absence deduction applies. Regularize only if the recorded attendance is incorrect.",
      tone: "red"
    });
    return {
      calendarClass: "absent",
      detail: durationOutcomeDetail(row, "Absent"),
      headline: "Absent recorded",
      issues,
      label: "Absent",
      needsRegularization: false,
      payDayType: "absent",
      tone: "red"
    };
  }

  if (payDayType === "half_day" || state.includes("half day") || row.status.toUpperCase() === "HD") {
    issues.push({
      code: "half_day",
      label: "Half day",
      message: "Half-day deduction applies under company HR policy and will be deducted from your upcoming payment.",
      tone: "amber"
    });
    return {
      calendarClass: "half",
      detail: durationOutcomeDetail(row, "Half Day"),
      headline: "Half day recorded",
      issues,
      label: "Half day",
      needsRegularization: false,
      payDayType: "half_day",
      tone: "amber"
    };
  }

  const baseLabel = state.includes("full day") ? "Full day" : label;
  const late = issues.some((issue) => issue.code === "late");
  const early = issues.some((issue) => issue.code === "early_out");
  const timingLabel = late ? `${baseLabel} · Late` : early ? `${baseLabel} · Early out` : baseLabel;
  return {
    calendarClass: calendarClassForPayDayType("present", options),
    detail: late
      ? `Reported ${pluralMinutes(lateMinutes)} late. Late penalty applies under company HR policy.`
      : early
        ? `Left ${pluralMinutes(earlyOutMinutes)} early. Early-out penalty applies under company HR policy.`
        : "Your full-day attendance is complete.",
    headline: late
      ? `Reported ${pluralMinutes(lateMinutes)} late`
      : early
        ? `Early out ${pluralMinutes(earlyOutMinutes)}`
        : "Full day complete",
    issues,
    label: timingLabel,
    needsRegularization: false,
    payDayType: "present",
    tone: issues.length ? "amber" : "green"
  };
}

function statusIsWeekOff(row: AttendanceInsightRow, state: string) {
  return row.status.toUpperCase() === "WO" || /weekly off|week off|rest day/.test(state);
}

function statusIsHoliday(row: AttendanceInsightRow, state: string) {
  return row.status.toUpperCase() === "H" || /\bholiday\b/.test(state);
}

export function attendanceCompactNudge(
  row: AttendanceInsightRow | undefined,
  options: { shiftOpen?: boolean; today?: boolean } = {}
): AttendanceCompactNudge | null {
  const insight = attendanceDayInsight(row, options);
  if (!row || (!insight.needsRegularization && !insight.issues.length)) return null;
  if (insight.needsRegularization) {
    const missing = insight.issues.some((issue) => issue.code === "missing_punch");
    return {
      headline: missing ? "Punch incomplete" : "Attendance check needed",
      detail: missing ? "Regularization needed" : "View and correct if required",
      tone: insight.tone
    };
  }
  const issue = attendanceIssueSummary(row);
  if (!issue) return null;
  if (issue.code === "late") {
    const minutes = resolveLateMinutes(row);
    return {
      headline: "Reported late",
      detail: minutes > 0 ? `${pluralMinutes(minutes)} · Penalty applicable` : "Penalty applicable",
      tone: issue.tone
    };
  }
  if (issue.code === "early_out") {
    const minutes = resolveEarlyOutMinutes(row);
    return {
      headline: "Left early",
      detail: minutes > 0 ? `${pluralMinutes(minutes)} · Penalty applicable` : "Penalty applicable",
      tone: issue.tone
    };
  }
  if (issue.code === "half_day") return { headline: "Half day recorded", detail: "Deduction applicable", tone: issue.tone };
  if (issue.code === "absent") return { headline: "Absent recorded", detail: "Deduction applicable", tone: issue.tone };
  return { headline: issue.label, detail: "View details", tone: issue.tone };
}

export function attendanceIssueSummary(row: AttendanceInsightRow | undefined) {
  const insight = attendanceDayInsight(row);
  return insight.issues.find((issue) => issue.code === "missing_punch")
    ?? insight.issues.find((issue) => issue.code === "policy_review")
    ?? insight.issues.find((issue) => issue.code === "late")
    ?? insight.issues.find((issue) => issue.code === "early_out")
    ?? insight.issues.find((issue) => issue.code === "absent")
    ?? insight.issues.find((issue) => issue.code === "half_day")
    ?? null;
}
