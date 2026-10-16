import assert from "node:assert/strict";
import test from "node:test";
import { payoutCheckFlags, payoutChecks } from "./workforce-payout-checks.ts";

const row = (extra = {}) => ({ id: "r", dropxId: "W1", name: "A", location: "BLR1", workDays: 20, workDaysSource: "Attendance", grossPayment: 16000, deductions: 500, netAmount: 15500, paymentDetailsAvailable: true, publicationTargetAmount: 15500, mappingStatus: "Mapped", ...extra });

test("a normal payout raises nothing", () => assert.deepEqual(payoutCheckFlags(row()), []));

test("each check fires on its own condition", () => {
  assert.deepEqual(payoutCheckFlags(row({ publicationTargetAmount: 15000 })), ["changed_after_review"]);
  assert.deepEqual(payoutCheckFlags(row({ publicationTargetAmount: 15500.4 })), [], "paise rounding is not a change");
  assert.deepEqual(payoutCheckFlags(row({ publicationTargetAmount: null })), [], "unpublished rows are not flagged");
  assert.ok(payoutCheckFlags(row({ workDays: 0 })).includes("paid_without_work"));
  assert.ok(!payoutCheckFlags(row({ workDays: 0, workDaysSource: "Attendance unavailable" })).includes("paid_without_work"));
  assert.deepEqual(payoutCheckFlags(row({ paymentDetailsAvailable: false })), ["no_bank_details"]);
  assert.deepEqual(payoutCheckFlags(row({ deductions: 17000, netAmount: 0, publicationTargetAmount: 0 })), ["deductions_exceed_gross"]);
  assert.deepEqual(payoutCheckFlags(row({ workDays: 2, grossPayment: 6000, netAmount: 5500, publicationTargetAmount: 5500 })), ["high_day_rate"]);
  assert.deepEqual(payoutCheckFlags(row({ grossPayment: 0, deductions: 0, netAmount: 0, publicationTargetAmount: 0 })), ["work_without_pay"]);
  assert.deepEqual(payoutCheckFlags(row({ grossPayment: 0, deductions: 0, netAmount: 0, publicationTargetAmount: 0, mappingStatus: "Unmapped" })), []);
});

test("summary counts people once and totals their net pay", () => {
  const s = payoutChecks([row({ id: "a", paymentDetailsAvailable: false, workDays: 0 }), row({ id: "b" }), row({ id: "c", publicationTargetAmount: 1 })]);
  assert.equal(s.checked, 3);
  assert.equal(s.flagged, 2);
  assert.equal(s.flaggedAmount, 31000);
  assert.equal(s.critical, 3);
  assert.deepEqual(s.groups.map((g) => g.code), ["changed_after_review", "paid_without_work", "no_bank_details"]);
});
