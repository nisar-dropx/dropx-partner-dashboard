import test from "node:test";
import assert from "node:assert/strict";
import {
  associatePayoutDispute,
  currentPayoutMonth,
  decodePayoutDisputeReason,
  encodePayoutDisputeReason,
  isCompleteCalendarMonth,
  legacyPayoutDisputeCategory,
  normalizePayoutMonth,
  normalizePayoutDisputeAreas,
  payoutMonthForPeriod,
  payoutMonthLabel,
  payoutMonthLongLabel,
  payoutReviewState,
  payoutDisputeWorkflow,
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
  assert.equal(normalizePayoutMonth("2026-09"), "2026-09");
  assert.equal(normalizePayoutMonth("2026-13"), null);
  assert.equal(normalizePayoutMonth("../../admin"), null);
});

test("files a payout under the month in which its pay period ends", () => {
  assert.equal(payoutMonthForPeriod("2026-09-01", "2026-09-30"), "2026-09");
  assert.equal(payoutMonthForPeriod("2026-08-26", "2026-09-25"), "2026-09");
  assert.equal(payoutMonthForPeriod("invalid", "invalid"), "");
});

test("uses friendly four-stage labels for dispute workflow states", () => {
  assert.deepEqual(
    ["open", "pending_final_approval", "approved_for_processing", "processing", "resolved"].map((status) => payoutDisputeWorkflow(status).label),
    [
      "Awaiting initial approval",
      "Awaiting final approval",
      "Approved for payout correction",
      "Payout correction in progress",
      "Resolved",
    ],
  );
  assert.equal(payoutDisputeWorkflow("processing_blocked").blocked, true);
  assert.equal(payoutDisputeWorkflow("in_review").label, "Awaiting final approval");
  assert.equal(payoutDisputeWorkflow("resolved", true).label, "Previous decision recorded");
});

test("builds an associate-safe dispute view with verified payout and payment context", () => {
  const view = associatePayoutDispute({
    id: "dispute-1",
    category: "other",
    reason: "Allowance is missing",
    status: "resolved",
    resolution: "The missing allowance was added.",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-03T00:00:00Z",
    initial_reviewed_by_name: "Internal Reviewer",
    processor_name: "Internal Processor",
    processing_note: "Internal note that must not be sent",
    correction_plan: {
      kind: "additional_payment",
      target_field: "allowance",
      current_value: 0,
      proposed_value: 500,
      expected_delta_paise: 50000,
      note: "Add the approved allowance.",
    },
    processing_result: {
      before_net_paise: 100000,
      after_net_paise: 150000,
      additional_balance_paise: 50000,
      paid_amount_paise: 100000,
    },
    processor_claimed_at: "2026-10-02T00:00:00Z",
    processed_at: "2026-10-03T00:00:00Z",
  }, null, null, { status: "Partially paid", reference: "UTR-1", date: "2026-10-04T00:00:00Z" });

  assert.equal(view.workflow.label, "Resolved");
  assert.equal(view.resolution, "The missing allowance was added.");
  assert.deepEqual(view.correction, {
    kind: "additional_payment",
    targetField: "allowance",
    note: "Add the approved allowance.",
    currentValue: 0,
    proposedValue: 500,
    beforeNetPaise: 100000,
    afterNetPaise: 150000,
    deltaPaise: 50000,
    netChangeVerified: true,
  });
  assert.deepEqual(view.payment, {
    status: "Partially paid",
    date: "2026-10-04T00:00:00Z",
    reference: "UTR-1",
    paidAmountPaise: 100000,
    additionalBalancePaise: 50000,
  });
  assert.equal("processor_name" in view, false);
  assert.equal("processing_note" in view, false);
});

test("derives before and after totals from linked publications and hides unapproved details", () => {
  const publications = [
    { snapshot: { item: { net_amount: 1000.25 } } },
    { snapshot: { item: { net_amount: 1250.75 } } },
  ];
  const approved = associatePayoutDispute({
    id: "dispute-2",
    status: "approved_for_processing",
    correction_plan: { expected_delta_paise: 25050 },
  }, publications[0]);
  assert.equal(approved.correction.beforeNetPaise, 100025);
  assert.equal(approved.correction.afterNetPaise, 125075);
  assert.equal(approved.correction.deltaPaise, 25050);
  assert.equal(approved.correction.netChangeVerified, false);

  const pending = associatePayoutDispute({
    id: "dispute-3",
    status: "pending_final_approval",
    resolution: "Draft internal recommendation",
    correction_plan: { current_value: 1, proposed_value: 2 },
  }, publications[0], publications[1]);
  assert.equal(pending.correction, null);
  assert.equal(pending.resolution, null);

  const legacy = associatePayoutDispute({
    id: "dispute-4",
    status: "resolved",
    resolution: "Closed under the previous workflow",
    correction_plan: { current_value: 1, proposed_value: 2 },
  }, publications[0]);
  assert.equal(legacy.workflow.label, "Previous decision recorded");
  assert.equal(legacy.correction, null);
});
