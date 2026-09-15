import assert from "node:assert/strict";
import test from "node:test";
import { wfhCreditState, wfhCreditLabel } from "./wfh-attendance-credit.ts";
import { resolveAttendancePayDayType } from "./attendance-pay-day.ts";
const row = { work_mode: "wfh", wfh_scheduled_start_at: "2026-09-15T04:00Z", wfh_scheduled_end_at: "2026-09-15T13:00Z",
  in_time: null, out_time: null, punch_count: 0 };
test("future and unfinished WFH are not paid attendance", () => {
  assert.equal(wfhCreditState(row, Date.parse("2026-09-14T10:00Z")), "upcoming");
  assert.equal(wfhCreditState(row, Date.parse("2026-09-15T10:00Z")), "in_progress");
  assert.equal(resolveAttendancePayDayType({ status: "PENDING", workMode: "wfh", attendanceStatus: "WFH approved · Upcoming" }), "no_record");
});
test("end-of-shift policy credit never needs invented punches", () => {
  assert.equal(wfhCreditState(row, Date.parse("2026-09-15T13:00Z")), "awaiting_finalization");
  assert.equal(wfhCreditState({ ...row, wfh_credit_finalized_at: "2026-09-15T13:01Z" }, Date.parse("2026-09-15T13:02Z")), "credited");
  assert.equal(wfhCreditLabel("credited"), "Present · WFH credit");
  assert.equal(resolveAttendancePayDayType({ status: "P", workMode: "wfh" }), "present_wfh");
});
test("real punches and overnight shifts retain their timing", () => {
  assert.equal(wfhCreditState({ ...row, punch_count: 1, in_time: "2026-09-15T04:01Z" }), null);
  assert.equal(wfhCreditState({ ...row, wfh_scheduled_end_at: "2026-09-16T03:00Z" }, Date.parse("2026-09-15T22:00Z")), "in_progress");
});
