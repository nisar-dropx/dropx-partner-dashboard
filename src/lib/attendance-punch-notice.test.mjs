import assert from "node:assert/strict";
import test from "node:test";
import { buildAttendancePunchNotice } from "./attendance-punch-notice.ts";

function outcome(overrides = {}) {
  return {
    attendanceStatus: "Full Day",
    earlyOutMinutes: 0,
    lateMinutes: 0,
    scheduledEnd: "18:30",
    scheduledStart: "09:30",
    workHours: "08:00",
    ...overrides
  };
}

test("combines punch capture, roster expectation and late penalty", () => {
  const notice = buildAttendancePunchNotice({
    outcome: outcome({ lateMinutes: 349, workHours: "00:00" }),
    punchOrder: 1,
    time: "15:19"
  });
  assert.equal(notice.punchType, "in");
  assert.match(notice.title, /5h 49m late/);
  assert.match(notice.body, /Expected 09:30 · reported 15:19/);
  assert.match(notice.body, /will be deducted from an upcoming payment when the configured threshold is met/);
});

test("reports the payable outcome after punch-out", () => {
  const notice = buildAttendancePunchNotice({
    outcome: outcome({ attendanceStatus: "Half Day", lateMinutes: 349, workHours: "05:57" }),
    punchOrder: 2,
    time: "21:16"
  });
  assert.equal(notice.title, "Punch-out captured · Half Day");
  assert.match(notice.body, /Worked 5h 57m · Half Day/);
  assert.match(notice.body, /Late arrival remains recorded \(5h 49m\)/);
  assert.match(notice.body, /Late penalty applies under company HR policy/);
  assert.match(notice.body, /punch in again/);
});

test("treats the third punch as the latest final checkout", () => {
  const notice = buildAttendancePunchNotice({
    outcome: outcome({ attendanceStatus: "Full Day", lateMinutes: 349, workHours: "08:02" }),
    punchOrder: 3,
    time: "23:21"
  });
  assert.equal(notice.punchType, "out");
  assert.equal(notice.title, "Checkout updated · Full Day");
  assert.doesNotMatch(notice.body, /needs review/i);
  assert.match(notice.body, /final checkout was updated/i);
  assert.match(notice.body, /Worked 8h 2m · Full Day/);
  assert.match(notice.body, /Late penalty applies under company HR policy/);
});

test("includes the early checkout consequence in the punch-out notification", () => {
  const notice = buildAttendancePunchNotice({
    outcome: outcome({ attendanceStatus: "Half Day", earlyOutMinutes: 45, workHours: "04:10" }),
    punchOrder: 2,
    time: "17:45"
  });
  assert.match(notice.body, /45 min early/);
  assert.match(notice.body, /Expected shift end: 18:30/);
  assert.match(notice.body, /Early checkout penalty applies when worked hours are short/);
  assert.match(notice.body, /upcoming payment under company HR policy/);
});
