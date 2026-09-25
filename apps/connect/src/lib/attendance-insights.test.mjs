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

test("WFH approval is not a full day or missing-punch warning before finalization", () => {
  // Calendar tile color matters here too: "Upcoming" (shift hasn't started)
  // stays "off" (no data yet), but "Day in progress" and "Finalizing" are an
  // approved WFH day that must render as "paid-leave" like any other WFH
  // day - not the current-day "on-shift" marker, which made an approved WFH
  // day whose credit hadn't posted yet look like an ordinary working day.
  const expectedCalendarClass = {
    "WFH approved · Upcoming": "off",
    "WFH approved · Day in progress": "paid-leave",
    "WFH approved · Finalizing": "paid-leave"
  };
  for (const label of ["WFH approved · Upcoming", "WFH approved · Day in progress", "WFH approved · Finalizing"]) {
    const insight = attendanceDayInsight(row({ workMode: "wfh", status: "PENDING", attendanceStatus: label,
      inTime: "", outTime: "", workHours: "00:00", punchCount: 0 }));
    assert.equal(insight.label, label);
    assert.equal(insight.payDayType, "no_record");
    assert.equal(insight.needsRegularization, false);
    assert.deepEqual(insight.issues, []);
    assert.equal(insight.calendarClass, expectedCalendarClass[label]);
  }
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
  assert.equal(insight.label, "Full day · Late");
  assert.equal(insight.calendarClass, "full");
  assert.equal(insight.needsRegularization, false);
  assert.deepEqual(insight.issues.map((issue) => issue.code), ["late"]);
});

test("surfaces late and early-out consequences without replacing full-day status", () => {
  const lateRow = row({ lateMinutes: 18, earlyOutMinutes: 7, scheduledStart: "09:30", inTime: "09:48" });
  const insight = attendanceDayInsight(lateRow);
  assert.equal(insight.label, "Full day · Late");
  assert.deepEqual(insight.issues.map((issue) => issue.code), ["late", "early_out"]);
  assert.match(insight.issues[0].message, /Expected 09:30 · reported 09:48/i);
  assert.match(insight.issues[0].message, /Any applicable deduction will appear in an upcoming payment/i);
  assert.equal(attendanceIssueSummary(lateRow)?.code, "late");
  assert.deepEqual(attendanceCompactNudge(lateRow), {
    headline: "Reported late",
    detail: "18 min · Penalty applicable",
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
  assert.equal(nudge?.detail, "45 min · Penalty applicable");
  assert.match(insight.detail, /Half Day/);
  assert.deepEqual(insight.issues.map((issue) => issue.code), ["late", "half_day"]);
});

test("recovers late flashes from People-style remark notes", () => {
  const insight = attendanceDayInsight(row({
    lateMinutes: 0,
    remark: "22 min late · First punch and latest punch used for the attendance outcome"
  }));
  assert.equal(insight.label, "Full day · Late");
  assert.equal(insight.issues[0]?.code, "late");
  assert.match(insight.issues[0]?.label ?? "", /22 min late/i);
});

test("carries an attendance nudge for one day only", () => {
  assert.equal(isCurrentAttendanceAttentionDate("2026-09-03", "2026-09-03"), true);
  assert.equal(isCurrentAttendanceAttentionDate("2026-09-02", "2026-09-03"), true);
  assert.equal(isCurrentAttendanceAttentionDate("2026-09-01", "2026-09-03"), false);
  assert.equal(isCurrentAttendanceAttentionDate("2026-08-31", "2026-09-01"), true);
});

test("maps WFH to paid-leave color and holiday to week-off color", () => {
  assert.equal(attendanceDayInsight(row({
    status: "V",
    statusLabel: "LOP",
    statusKind: "leave",
    isPaidLeave: false,
    attendanceStatus: "LOP"
  })).calendarClass, "leave");
  assert.equal(attendanceDayInsight(row({
    status: "CL",
    statusLabel: "Casual Leave",
    statusKind: "paid_leave",
    isPaidLeave: true,
    attendanceStatus: "Casual Leave"
  })).calendarClass, "paid-leave");
  const wfh = attendanceDayInsight(row({
    status: "P",
    workMode: "wfh",
    attendanceStatus: "Full Day"
  }));
  assert.equal(wfh.calendarClass, "paid-leave");
  assert.equal(wfh.label, "Present · WFH");
  // A rest day nobody worked has no punches (the default fixture has a full pair).
  const noPunches = { inTime: "--:--", outTime: "--:--", workHours: "00:00", punchCount: 0 };
  assert.equal(attendanceDayInsight(row({
    status: "WO",
    attendanceStatus: "Weekly Off",
    ...noPunches
  })).calendarClass, "week-off");
  const holiday = attendanceDayInsight(row({
    status: "H",
    attendanceStatus: "Holiday",
    ...noPunches
  }));
  assert.equal(holiday.calendarClass, "week-off");
  assert.equal(holiday.label, "Holiday");
});

test("a worked week off shows as present, not as a day off (SREEKANTH, 13 Sep)", () => {
  const worked = attendanceDayInsight(row({
    date: "2026-09-13",
    status: "P",
    payDayType: "week_off",
    attendanceStatus: "Full Day",
    inTime: "09:49",
    outTime: "19:37",
    punchCount: 2
  }));
  assert.equal(worked.calendarClass, attendanceDayInsight(row()).calendarClass);
  assert.equal(worked.label, "Worked on week off");
  assert.equal(worked.payDayType, "present");
  assert.equal(attendanceDayInsight(row({ status: "H", attendanceStatus: "Holiday" })).label, "Worked on holiday");
});

test("a single stray punch on a week off is still a week off", () => {
  assert.equal(attendanceDayInsight(row({
    status: "WO",
    attendanceStatus: "Weekly Off",
    inTime: "09:49",
    outTime: "--:--",
    punchCount: 1
  })).calendarClass, "week-off");
});

test("the day a week-off comp-off is taken shows as that leave", () => {
  const compOff = attendanceDayInsight(row({
    status: "WOFFCOMP",
    statusLabel: "Approved week-off compensatory off",
    statusKind: "paid_leave",
    isPaidLeave: true,
    attendanceStatus: "Approved week-off compensatory off",
    inTime: "--:--",
    outTime: "--:--",
    punchCount: 0
  }));
  assert.equal(compOff.calendarClass, "paid-leave");
  assert.equal(compOff.label, "Approved week-off compensatory off");
  // "holiday" in the label must not turn a paid comp-off into the rest-day colour.
  const holidayCompOff = attendanceDayInsight(row({
    status: "HOLCOMP",
    statusLabel: "Approved holiday compensatory off",
    statusKind: "paid_leave",
    isPaidLeave: true,
    payDayType: "paid_leave",
    attendanceStatus: "Approved holiday compensatory off",
    inTime: "--:--",
    outTime: "--:--",
    punchCount: 0
  }));
  assert.equal(holidayCompOff.calendarClass, "paid-leave");
});
