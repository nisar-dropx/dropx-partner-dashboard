import test from "node:test";
import assert from "node:assert/strict";
import {
  currentPayoutMonth,
  decodePayoutDisputeReason,
  encodePayoutDisputeReason,
  isCompleteCalendarMonth,
  legacyPayoutDisputeCategory,
  normalizePayoutDisputeAreas,
  payoutMonthForPeriod,
  payoutMonthLabel,
  payoutMonthLongLabel,
  payoutReviewState,
  shiftPayoutMonth,
} from "./payout-dispute.ts";

test("normalizes, validates and de-duplicates multi-area disputes", () => {
  assert.deepEqual(
    normalizePayoutDisputeAreas(["delivery", "deduction", "delivery", "unknown", ""]),
    ["delivery", "deduction"],
  );
  assert.deepEqual(normalizePayoutDisputeAreas("work_days,incentive"), ["work_days", "incentive"]);
});

test("keeps the legacy RPC category while preserving every selected area", () => {
  const areas = normalizePayoutDisputeAreas(["allowances", "delivery", "deduction"]);
  assert.equal(legacyPayoutDisputeCategory(areas), "counts");
  const encoded = encodePayoutDisputeReason(areas, "  Delivery total is short by 12.  ");
  assert.equal(encoded, "Dispute areas: Allowances, Delivery, Deduction\n\nDelivery total is short by 12.");
  assert.deepEqual(decodePayoutDisputeReason(encoded), {
    areas: ["Allowances", "Delivery", "Deduction"],
    reason: "Delivery total is short by 12.",
  });
});

test("recognizes open, expired, revising and confirmed review windows", () => {
  const now = Date.parse("2026-09-27T00:00:00Z");
  assert.equal(payoutReviewState({ hasPublication: true, runStatus: "review", reviewUntil: "2026-09-28T00:00:00Z" }, now), "open");
  assert.equal(payoutReviewState({ hasPublication: true, runStatus: "review", reviewUntil: "2026-09-26T00:00:00Z" }, now), "expired");
  assert.equal(payoutReviewState({ hasPublication: true, runStatus: "review", reviewUntil: "2026-09-28T00:00:00Z", revisionPending: true }, now), "revising");
  assert.equal(payoutReviewState({ hasPublication: true, runStatus: "paid", reviewUntil: "2026-09-28T00:00:00Z" }, now), "confirmed");
  assert.equal(payoutReviewState({ hasPublication: true, runStatus: "draft", reviewUntil: "2026-09-28T00:00:00Z" }, now), "unavailable");
  assert.equal(payoutReviewState({ hasPublication: false, runStatus: "review" }, now), "unavailable");
});

test("distinguishes a complete calendar month from partial payroll periods", () => {
  assert.equal(isCompleteCalendarMonth("2026-09-01", "2026-09-30"), true);
  assert.equal(isCompleteCalendarMonth("2024-02-01", "2024-02-29"), true);
  assert.equal(isCompleteCalendarMonth("2026-09-01", "2026-09-15"), false);
  assert.equal(isCompleteCalendarMonth("2026-09-16", "2026-09-30"), false);
  assert.equal(isCompleteCalendarMonth("2026-09-01", "2026-10-31"), false);
});

test("uses Attendance-style month navigation in India time", () => {
  assert.equal(currentPayoutMonth(new Date("2026-09-30T18:00:00Z")), "2026-09");
  assert.equal(currentPayoutMonth(new Date("2026-09-30T19:00:00Z")), "2026-10");
  assert.equal(shiftPayoutMonth("2026-01", -1), "2025-12");
  assert.equal(shiftPayoutMonth("2026-12", 1), "2027-01");
  assert.equal(payoutMonthLabel("2026-09"), "Sep-26");
  assert.equal(payoutMonthLongLabel("2026-09"), "September 2026");
});

test("files a payout under the month in which its pay period ends", () => {
  assert.equal(payoutMonthForPeriod("2026-09-01", "2026-09-30"), "2026-09");
  assert.equal(payoutMonthForPeriod("2026-08-26", "2026-09-25"), "2026-09");
  assert.equal(payoutMonthForPeriod("invalid", "invalid"), "");
});
