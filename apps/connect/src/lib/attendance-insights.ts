export type AttendanceInsightTone = "green" | "amber" | "red" | "blue" | "neutral";

export type AttendanceInsightRow = {
  date: string;
  status: string;
  statusLabel?: string | null;
  statusKind?: "attendance" | "leave";
  attendanceStatus?: string | null;
  inTime: string;
  outTime: string;
  workHours: string;
  punchCount: number;
  remark: string;
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
  calendarClass: "full" | "half" | "absent" | "review" | "leave" | "off" | "on-shift";
  detail: string;
  headline: string;
  issues: AttendanceIssue[];
  label: string;
  needsRegularization: boolean;
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
    ? `You worked ${worked}, below the full-day requirement. This day is marked Half Day under company HR policy.`
    : `You worked ${worked}, below the half-day requirement. This day is marked Absent under company HR policy.`;
  return `${reason} If the attendance record is wrong, request regularization.`;
}

function fallbackLabel(row: AttendanceInsightRow) {
  const status = row.status.toUpperCase();
  if (status === "P") return "Present";
  if (status === "A") return "Absent";
  if (status === "HD") return "Half day";
  if (status === "WO") return "Weekly off";
  return row.status || "No record";
}

function outcomeLabel(row: AttendanceInsightRow) {
  return row.statusLabel || row.attendanceStatus || fallbackLabel(row);
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
      tone: "neutral"
    };
  }

  const label = outcomeLabel(row);
  const state = normalized(label);
  const remark = normalized(row.remark);
  const lateMinutes = Math.max(0, Number(row.lateMinutes ?? 0));
  const earlyOutMinutes = Math.max(0, Number(row.earlyOutMinutes ?? 0));
  const missingPunch = row.punchCount < 2 || !row.outTime || /single|missing/.test(remark);
  const needsPolicyReview = state.includes("needs review");

  const issues: AttendanceIssue[] = [];
  if (lateMinutes > 0) {
    issues.push({
      code: "late",
      label: `Reported ${pluralMinutes(lateMinutes)} late`,
      message: `${rosterExpectation(row)}Late penalty applies under company HR policy and will be deducted from an upcoming payment when the configured threshold is met.`,
      tone: "amber"
    });
  }
  if (earlyOutMinutes > 0) {
    issues.push({
      code: "early_out",
      label: `Early out ${pluralMinutes(earlyOutMinutes)}`,
      message: `${row.scheduledEnd && row.scheduledEnd !== "--:--" ? `Expected shift end ${row.scheduledEnd}. ` : ""}Early checkout penalty applies when worked hours are short; the applicable deduction will be made from an upcoming payment under company HR policy.`,
      tone: "amber"
    });
  }

  if (row.statusKind === "leave") {
    return {
      calendarClass: "leave",
      detail: "Approved leave is applied for this day.",
      headline: label,
      issues: [],
      label,
      needsRegularization: false,
      tone: "blue"
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
      tone: "red"
    };
  }

  if (needsPolicyReview) {
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
      tone: "red"
    };
  }

  if (state.includes("absent") || row.status.toUpperCase() === "A") {
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
      tone: "red"
    };
  }

  if (state.includes("half day") || row.status.toUpperCase() === "HD") {
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
      tone: "amber"
    };
  }

  if (/weekly off|week off|rest day|holiday|no record/.test(state) || ["WO", "H"].includes(row.status.toUpperCase())) {
    return {
      calendarClass: "off",
      detail: label,
      headline: label,
      issues: [],
      label,
      needsRegularization: false,
      tone: "neutral"
    };
  }

  const hasTimingIssue = issues.length > 0;
  return {
    calendarClass: "full",
    detail: hasTimingIssue ? issues[0].message : "Your full-day attendance is complete.",
    headline: hasTimingIssue ? issues[0].label : "Full day complete",
    issues,
    label: state.includes("full day") ? "Full day" : label,
    needsRegularization: false,
    tone: hasTimingIssue ? "amber" : "green"
  };
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
