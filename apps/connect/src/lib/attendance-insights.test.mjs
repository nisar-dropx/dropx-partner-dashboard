import assert from "node:assert/strict";
import test from "node:test";
import { attendanceDayInsight } from "./attendance-insights.ts";

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

test("surfaces late and early-out consequences without replacing full-day status", () => {
  const insight = attendanceDayInsight(row({ lateMinutes: 18, earlyOutMinutes: 7 }));
  assert.equal(insight.label, "Full day");
  assert.deepEqual(insight.issues.map((issue) => issue.code), ["late", "early_out"]);
  assert.match(insight.issues[0].message, /penalty may apply/i);
});
