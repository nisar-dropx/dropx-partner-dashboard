import assert from "node:assert/strict";
import test from "node:test";

import {
  isWorkforcePayoutPaymentBalanceAvailable,
  summarizeWorkforcePayoutPayments,
  workforcePayoutPaymentEligibilityLabel
} from "./workforce-payout-payment-summary.ts";

test("summarizes one person across locations without counting duplicate rows twice", () => {
  const summary = summarizeWorkforcePayoutPayments([
    { rowId: "a", workforceId: "W1", netAmount: 700 },
    { rowId: "b", workforceId: "W1", netAmount: 300 },
    { rowId: "b", workforceId: "W1", netAmount: 300 }
  ], []).get("w1");
  assert.deepEqual(summary, {
    currentNetAmount: 1000,
    paidAmount: 0,
    processingAmount: 0,
    balancePayable: 1000,
    availableToPay: 1000,
    overpaidAmount: 0,
    historyCount: 0,
    status: null,
    eligible: null,
    eligibilityCode: null,
    eligibilityMessage: null
  });
});

test("a paid V1 and higher revised payout exposes only the delta", () => {
  const summary = summarizeWorkforcePayoutPayments(
    [{ rowId: "a", workforceId: "W1", netAmount: 1250 }],
    [{ workforceId: "W1", status: "paid", amount: 1000 }]
  ).get("w1");
  assert.equal(summary?.paidAmount, 1000);
  assert.equal(summary?.balancePayable, 250);
  assert.equal(summary?.availableToPay, 250);
  assert.equal(summary?.status, "Partially Paid");
});

test("a failed retry does not hide a finalized partial payment", () => {
  const summary = summarizeWorkforcePayoutPayments(
    [{ rowId: "a", workforceId: "W1", netAmount: 1500 }],
    [
      { workforceId: "W1", status: "paid", amount: 1000 },
      { workforceId: "W1", status: "failed", amount: 500 }
    ]
  ).get("w1");
  assert.equal(summary?.paidAmount, 1000);
  assert.equal(summary?.balancePayable, 500);
  assert.equal(summary?.availableToPay, 500);
  assert.equal(summary?.status, "Partially Paid");
});

test("sums signed station amounts before applying the zero floor", () => {
  const summary = summarizeWorkforcePayoutPayments([
    { rowId: "a", workforceId: "W1", netAmount: 1000 },
    { rowId: "b", workforceId: "W1", netAmount: -200 }
  ], []).get("w1");
  assert.equal(summary?.currentNetAmount, 800);
  assert.equal(summary?.balancePayable, 800);
});

test("processing reserves the payable amount and a lower revision reports overpayment", () => {
  const processing = summarizeWorkforcePayoutPayments(
    [{ rowId: "a", workforceId: "W1", netAmount: 1200 }],
    [{ workforceId: "W1", status: "processing", amount: 1000, currentTargetAmount: 1000 }]
  ).get("w1");
  assert.equal(processing?.currentNetAmount, 1000);
  assert.equal(processing?.balancePayable, 1000);
  assert.equal(processing?.availableToPay, 0);
  assert.equal(processing?.status, "Payment Processing");

  const overpaid = summarizeWorkforcePayoutPayments(
    [{ rowId: "a", workforceId: "W1", netAmount: 900 }],
    [{ workforceId: "W1", status: "paid", amount: 1000 }]
  ).get("w1");
  assert.equal(overpaid?.balancePayable, 0);
  assert.equal(overpaid?.overpaidAmount, 100);
  assert.equal(overpaid?.status, "Paid");
});

test("cancelled attempts remain in history but do not reduce the balance", () => {
  const summary = summarizeWorkforcePayoutPayments(
    [{ rowId: "a", workforceId: "W1", netAmount: 500 }],
    [{ workforceId: "W1", status: "cancelled", amount: 500 }]
  ).get("w1");
  assert.equal(summary?.balancePayable, 500);
  assert.equal(summary?.availableToPay, 500);
  assert.equal(summary?.historyCount, 1);
  assert.equal(summary?.status, "Payment Cancelled");
});

test("failed attempts release the full balance for the next payment version", () => {
  const summary = summarizeWorkforcePayoutPayments(
    [{ rowId: "a", workforceId: "W1", netAmount: 500 }],
    [{ workforceId: "W1", status: "failed", amount: 500 }]
  ).get("w1");
  assert.equal(summary?.balancePayable, 500);
  assert.equal(summary?.availableToPay, 500);
  assert.equal(summary?.historyCount, 1);
  assert.equal(summary?.status, "Payment Failed");
});

test("stale and pending publications expose an unavailable balance with an actionable label", () => {
  const missing = { eligible: false, eligibilityCode: "publication_missing" };
  assert.equal(isWorkforcePayoutPaymentBalanceAvailable(missing), false);
  assert.equal(workforcePayoutPaymentEligibilityLabel(missing), "Publish before payment");

  const stale = { eligible: false, eligibilityCode: "publication_stale_or_incomplete" };
  assert.equal(isWorkforcePayoutPaymentBalanceAvailable(stale), false);
  assert.equal(workforcePayoutPaymentEligibilityLabel(stale), "Republish required");

  const pending = { eligible: false, eligibilityCode: "publication_refresh_pending" };
  assert.equal(isWorkforcePayoutPaymentBalanceAvailable(pending), false);
  assert.equal(workforcePayoutPaymentEligibilityLabel(pending), "Publication refresh pending");
});

test("computed balances remain visible when a separate payment constraint blocks selection", () => {
  const processing = { eligible: false, eligibilityCode: "payment_processing" };
  assert.equal(isWorkforcePayoutPaymentBalanceAvailable(processing), true);
  assert.equal(workforcePayoutPaymentEligibilityLabel(processing), null);

  const invalidBankDetails = { eligible: false, eligibilityCode: "beneficiary_bank_details_missing" };
  assert.equal(isWorkforcePayoutPaymentBalanceAvailable(invalidBankDetails), true);
  assert.equal(workforcePayoutPaymentEligibilityLabel(invalidBankDetails), "Payment details required");

  const held = { eligible: false, eligibilityCode: "payment_on_hold" };
  assert.equal(isWorkforcePayoutPaymentBalanceAvailable(held), true);
  assert.equal(workforcePayoutPaymentEligibilityLabel(held), "Payment on hold");

  const panNotLinked = { eligible: false, eligibilityCode: "pan_not_linked" };
  assert.equal(isWorkforcePayoutPaymentBalanceAvailable(panNotLinked), true);
  assert.equal(workforcePayoutPaymentEligibilityLabel(panNotLinked), "PAN not linked");

  const profileNotActive = { eligible: false, eligibilityCode: "profile_not_active" };
  assert.equal(isWorkforcePayoutPaymentBalanceAvailable(profileNotActive), true);
  assert.equal(workforcePayoutPaymentEligibilityLabel(profileNotActive), "Active profiles only");
});
