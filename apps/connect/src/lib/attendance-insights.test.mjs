import assert from "node:assert/strict";
import test from "node:test";
import {
  attendanceCompactNudge,
  attendanceDayInsight,
  attendanceIssueSummary,
  isCurrentAttendanceAttentionDate
} from "./attendance-insights.ts";

function row(overrides = {}) {
  return {
    date: "2026-09-01",
    status: "P",
    attendanceStatus: "Full Day",
    inTime: "09:00",
    outTime: "18:00",
    workHours: "09:00",
    punchCount: 2,
    remark: "",
    ...overrides
  };
}

test("uses the canonical People day status", () => {
  assert.equal(attendanceDayInsight(row()).label, "Full day");
  assert.equal(attendanceDayInsight(row({ attendanceStatus: "Half Day" })).calendarClass, "half");
  assert.equal(attendanceDayInsight(row({ attendanceStatus: "Absent", status: "A" })).calendarClass, "absent");
});

test("keeps an open current workday out of needs-review until punch-out", () => {
  const insight = attendanceDayInsight(row({
    attendanceStatus: "Needs Review",
    outTime: "",
    punchCount: 1,
    remark: "Single punch"
  }), { shiftOpen: true, today: true });
  assert.equal(insight.label, "On shift");
  assert.equal(insight.needsRegularization, false);
});

test("makes a closed single punch actionable", () => {
  const insight = attendanceDayInsight(row({
    attendanceStatus: "Needs Review",
    outTime: "",
    punchCount: 1,
    remark: "Single punch"
  }));
  assert.equal(insight.calendarClass, "review");
  assert.equal(insight.needsRegularization, true);
  assert.match(insight.detail, /regularization/i);
});

test("does not call a complete punch pair missing when policy review is required", () => {
  const insight = attendanceDayInsight(row({
    attendanceStatus: "Needs Review",
    punchCount: 2,
    remark: "Policy review required"
  }));
  assert.equal(insight.label, "Needs review");
  assert.equal(insight.issues[0].code, "policy_review");
  assert.doesNotMatch(insight.detail, /punch is missing/i);
});

test("uses first IN and latest OUT for three completed punches", () => {
  const insight = attendanceDayInsight(row({
    attendanceStatus: "Full Day",
    outTime: "23:21",
    punchCount: 3,
    lateMinutes: 349,
    scheduledStart: "09:30",
    inTime: "15:19",
    workHours: "08:02"
  }));
  assert.equal(insight.label, "Full day");
  assert.equal(insight.calendarClass, "full");
  assert.equal(insight.needsRegularization, false);
  assert.deepEqual(insight.issues.map((issue) => issue.code), ["late"]);
});

test("surfaces late and early-out consequences without replacing full-day status", () => {
  const lateRow = row({ lateMinutes: 18, earlyOutMinutes: 7, scheduledStart: "09:30", inTime: "09:48" });
  const insight = attendanceDayInsight(lateRow);
  assert.equal(insight.label, "Full day");
  assert.deepEqual(insight.issues.map((issue) => issue.code), ["late", "early_out"]);
  assert.match(insight.issues[0].message, /Expected 09:30 · reported 09:48/i);
  assert.match(insight.issues[0].message, /Any applicable deduction will appear in an upcoming payment/i);
  assert.equal(attendanceIssueSummary(lateRow)?.code, "late");
  assert.deepEqual(attendanceCompactNudge(lateRow), {
    headline: "Reported late",
    detail: "Penalty applicable",
    tone: "amber"
  });
});

test("keeps half day as the payable status while leading with the late warning", () => {
  const halfDay = row({
    attendanceStatus: "Half Day",
    inTime: "15:19",
    lateMinutes: 349,
    scheduledStart: "09:30",
    workHours: "05:57"
  });
  const insight = attendanceDayInsight(halfDay);
  assert.equal(insight.label, "Half day");
  assert.equal(insight.headline, "Half day recorded");
  assert.match(insight.detail, /worked 5h 57m, below the full-day requirement/i);
  assert.match(insight.detail, /company HR policy/i);
  assert.match(insight.issues[0].message, /Expected 09:30 · reported 15:19/);
  assert.deepEqual(insight.issues.map((issue) => issue.code), ["late", "half_day"]);
  assert.equal(insight.needsRegularization, false);
  assert.equal(attendanceIssueSummary(halfDay)?.code, "late");
});

test("keeps the first-glance message compact while retaining full details", () => {
  const halfDay = row({ attendanceStatus: "Half Day", lateMinutes: 45, scheduledStart: "09:30", inTime: "10:15", workHours: "05:30" });
  const insight = attendanceDayInsight(halfDay);
  const nudge = attendanceCompactNudge(halfDay);
  assert.equal(nudge?.headline, "Reported late");
  assert.equal(nudge?.detail, "Penalty applicable");
  assert.match(insight.detail, /Half Day/);
  assert.deepEqual(insight.issues.map((issue) => issue.code), ["late", "half_day"]);
});

test("carries an attendance nudge for one day only", () => {
  assert.equal(isCurrentAttendanceAttentionDate("2026-09-03", "2026-09-03"), true);
  assert.equal(isCurrentAttendanceAttentionDate("2026-09-02", "2026-09-03"), true);
  assert.equal(isCurrentAttendanceAttentionDate("2026-09-01", "2026-09-03"), false);
  assert.equal(isCurrentAttendanceAttentionDate("2026-08-31", "2026-09-01"), true);
});
