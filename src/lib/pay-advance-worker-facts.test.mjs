import test from "node:test";
import assert from "node:assert/strict";
import { indiaMonthStart, monthEnd, workerCodeFromDetails, workingDaysFromStatuses } from "./pay-advance-worker-facts.ts";

test("present days count fully and half days count as half", () => {
  assert.equal(workingDaysFromStatuses(["P", "HD", "A", "PD", "WO"]), 2.5);
});

test("a payment detail object yields the worker code and anything else does not", () => {
  assert.equal(workerCodeFromDetails({ worker_code: " D0963 " }), "D0963");
  assert.equal(workerCodeFromDetails("D0963"), null);
  assert.equal(workerCodeFromDetails(null), null);
});

test("the applying month is the India calendar month of the request", () => {
  assert.equal(indiaMonthStart("2026-10-03T09:14:00.824Z"), "2026-10-01");
  assert.equal(monthEnd("2026-10-01"), "2026-10-31");
});
