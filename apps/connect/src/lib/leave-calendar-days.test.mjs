import assert from "node:assert/strict";
import test from "node:test";
import { approvedLeaveDays } from "./leave-calendar-days.ts";

const compOff = { startDate: "2026-09-26", endDate: "2026-09-26", attendanceCode: "WOFFCOMP", attendanceLabel: "Approved week-off compensatory off", name: "Week-off Comp Off" };

test("a one-day comp-off covers exactly that day", () => {
  const days = approvedLeaveDays([compOff], "2026-09-01", "2026-09-30");
  assert.deepEqual([...days.keys()], ["2026-09-26"]);
  assert.equal(days.get("2026-09-26").attendanceCode, "WOFFCOMP");
});

test("a multi-day leave is clipped to the month shown", () => {
  const days = approvedLeaveDays([{ ...compOff, attendanceCode: "SICK", startDate: "2026-08-30", endDate: "2026-09-02" }], "2026-09-01", "2026-09-30");
  assert.deepEqual([...days.keys()], ["2026-09-01", "2026-09-02"]);
});

test("leave outside the month adds nothing; a type without an attendance code is skipped", () => {
  assert.equal(approvedLeaveDays([{ ...compOff, startDate: "2026-10-01", endDate: "2026-10-01" }], "2026-09-01", "2026-09-30").size, 0);
  assert.equal(approvedLeaveDays([{ ...compOff, attendanceCode: "" }], "2026-09-01", "2026-09-30").size, 0);
});
