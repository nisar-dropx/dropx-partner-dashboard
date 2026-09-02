import assert from "node:assert/strict";
import test from "node:test";
import { attendanceReviewDueAt, isAttendanceReviewDue } from "./attendance-review-timing.ts";

test("schedules a review four hours after the assigned shift ends", () => {
  const dueAt = attendanceReviewDueAt({
    punchDate: "2026-09-02",
    scheduledStart: "09:00",
    scheduledEnd: "18:00"
  });
  assert.equal(dueAt?.toISOString(), "2026-09-02T16:30:00.000Z");
});

test("supports overnight shifts", () => {
  const dueAt = attendanceReviewDueAt({
    punchDate: "2026-09-02",
    scheduledStart: "21:00",
    scheduledEnd: "06:00"
  });
  assert.equal(dueAt?.toISOString(), "2026-09-03T04:30:00.000Z");
});

test("does not schedule reminders without an assigned shift", () => {
  assert.equal(attendanceReviewDueAt({
    punchDate: "2026-09-02",
    scheduledStart: "",
    scheduledEnd: ""
  }), null);
});

test("becomes due only after the review delay", () => {
  const input = {
    punchDate: "2026-09-02",
    scheduledStart: "09:00",
    scheduledEnd: "18:00"
  };
  assert.equal(isAttendanceReviewDue(input, new Date("2026-09-02T16:29:59.000Z")), false);
  assert.equal(isAttendanceReviewDue(input, new Date("2026-09-02T16:30:00.000Z")), true);
});
