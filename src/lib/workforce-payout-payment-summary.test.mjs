import assert from "node:assert/strict";
import test from "node:test";

import {
  isWorkforcePayoutPaymentBalanceAvailable,
  mergeWorkforcePayoutPaymentState,
  summarizeWorkforcePayoutPayments,
  workforcePayoutPaymentEligibilityLabel,
  workforcePayoutPublicationRefreshPending,
  workforcePayoutTargetAmountsMatch
} from "./workforce-payout-payment-summary.ts";

function paymentSummary(overrides = {}) {
  return {
    currentNetAmount: 0,
    paidAmount: 0,
    processingAmount: 0,
    balancePayable: 0,
    availableToPay: 0,
    overpaidAmount: 0,
    historyCount: 0,
    status: null,
    eligible: false,
    eligibilityCode: "no_positive_balance",
    eligibilityMessage: "No positive balance",
    ...overrides
  };
}

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

test("money target comparison is stable to paise and rejects a missing publication amount", () => {
  assert.equal(workforcePayoutTargetAmountsMatch(16_830, "16830.00"), true);
  assert.equal(workforcePayoutTargetAmountsMatch(16_830.004, 16_830), true);
  assert.equal(workforcePayoutTargetAmountsMatch(16_830.01, 16_830), false);
  assert.equal(workforcePayoutTargetAmountsMatch(16_830, null), false);
});

test("publication target mismatch is permission-independent and requires an actual locked publication", () => {
  assert.equal(workforcePayoutPublicationRefreshPending("workforce", "locked", 16_830, 0), true);
  assert.equal(workforcePayoutPublicationRefreshPending("workforce", "locked", 16_830, 16_830), false);
  assert.equal(workforcePayoutPublicationRefreshPending("workforce", "locked", 16_830, null), false);
  assert.equal(workforcePayoutPublicationRefreshPending("workforce", "unlocked", 16_830, 0), false);
  assert.equal(workforcePayoutPublicationRefreshPending("helpers", "locked", 16_830, 0), false);
});

test("a stale published zero cannot overwrite a positive live payout", () => {
  const reviewed = {
    id: "df1088-station",
    netAmount: 16_830,
    status: "Payment published",
    publicationLockState: "locked",
    publicationPaymentReady: false
  };
  const payment = {
    ...reviewed,
    publicationPaymentReady: false,
    paymentSummary: paymentSummary()
  };

  const merged = mergeWorkforcePayoutPaymentState(reviewed, payment, "workforce");
  assert.equal(merged.publicationPaymentReady, false);
  assert.equal(merged.status, "Publication refresh pending");
  assert.equal(merged.paymentSummary?.eligibilityCode, "publication_refresh_pending");
  assert.match(merged.paymentSummary?.eligibilityMessage ?? "", /revalidated before the bank file/i);
});

test("an old eligible preview cannot bypass a review freshness blocker", () => {
  const reviewed = {
    id: "stale-row",
    netAmount: 500,
    status: "Republish required",
    publicationLockState: "locked",
    publicationPaymentReady: false
  };
  const payment = {
    ...reviewed,
    publicationPaymentReady: true,
    paymentSummary: paymentSummary({
      currentNetAmount: 500,
      balancePayable: 500,
      availableToPay: 500,
      eligible: true,
      eligibilityCode: "eligible",
      eligibilityMessage: null
    })
  };

  const merged = mergeWorkforcePayoutPaymentState(reviewed, payment, "workforce");
  assert.equal(merged.publicationPaymentReady, false);
  assert.equal(merged.status, "Republish required");
});

test("an authoritative eligible row candidate overrides only the legacy global review hash", () => {
  const reviewed = {
    id: "df1088-station",
    netAmount: 16_830,
    status: "Payment published",
    publicationLockState: "locked",
    publicationPaymentReady: false,
    publicationTargetAmount: 16_830
  };
  const payment = {
    ...reviewed,
    publicationPaymentReady: true,
    paymentSummary: paymentSummary({
      currentNetAmount: 16_830,
      balancePayable: 16_830,
      availableToPay: 16_830,
      eligible: true,
      eligibilityCode: "eligible",
      eligibilityMessage: null
    })
  };

  const merged = mergeWorkforcePayoutPaymentState(reviewed, payment, "workforce");
  assert.equal(merged.publicationPaymentReady, true);
  assert.equal(merged.status, "Payment published");
  assert.equal(merged.paymentSummary?.availableToPay, 16_830);
});

test("an authoritative candidate does not bypass a row without publication evidence", () => {
  const reviewed = {
    id: "unpublished-row",
    netAmount: 500,
    status: "Ready for review",
    publicationLockState: "locked",
    publicationPaymentReady: false,
    publicationTargetAmount: 500
  };
  const payment = {
    ...reviewed,
    publicationPaymentReady: true,
    paymentSummary: paymentSummary({
      currentNetAmount: 500,
      balancePayable: 500,
      availableToPay: 500,
      eligible: true,
      eligibilityCode: "eligible",
      eligibilityMessage: null
    })
  };

  const merged = mergeWorkforcePayoutPaymentState(reviewed, payment, "workforce");
  assert.equal(merged.publicationPaymentReady, false);
  assert.equal(merged.status, "Ready for review");
});

test("finalized paid status remains visible when the current publication is not review-ready", () => {
  const reviewed = {
    id: "paid-row",
    netAmount: 1_000,
    status: "Payment published",
    publicationLockState: "locked",
    publicationPaymentReady: false,
    publicationTargetAmount: 1_000
  };
  const payment = {
    ...reviewed,
    paymentSummary: paymentSummary({
      currentNetAmount: 1_000,
      paidAmount: 1_000,
      balancePayable: 0,
      status: "Profile Not Active",
      eligibilityCode: "profile_not_active",
      eligibilityMessage: "Active profiles only"
    })
  };

  const merged = mergeWorkforcePayoutPaymentState(reviewed, payment, "workforce");
  assert.equal(merged.status, "Paid");
  assert.equal(merged.publicationPaymentReady, false);
  assert.equal(merged.paymentSummary?.eligibilityCode, "profile_not_active");
});

test("finalized partial payment remains visible when the current publication is not review-ready", () => {
  const reviewed = {
    id: "partially-paid-row",
    netAmount: 1_500,
    status: "Payment published",
    publicationLockState: "locked",
    publicationPaymentReady: false,
    publicationTargetAmount: 1_500
  };
  const payment = {
    ...reviewed,
    paymentSummary: paymentSummary({
      currentNetAmount: 1_500,
      paidAmount: 1_000,
      balancePayable: 500,
      status: null,
      eligibilityCode: "publication_stale_or_incomplete",
      eligibilityMessage: "Republish required"
    })
  };

  const merged = mergeWorkforcePayoutPaymentState(reviewed, payment, "workforce");
  assert.equal(merged.status, "Partially Paid");
  assert.equal(merged.publicationPaymentReady, false);
});

test("a pending publication refresh derives partial payment from the live balance", () => {
  const reviewed = {
    id: "paid-refresh-row",
    netAmount: 1_500,
    status: "Publication refresh pending",
    publicationLockState: "locked",
    publicationPaymentReady: false,
    publicationTargetAmount: 1_000
  };
  const payment = {
    ...reviewed,
    paymentSummary: paymentSummary({
      currentNetAmount: 0,
      paidAmount: 1_000,
      balancePayable: 0,
      status: null,
      eligibilityCode: "publication_refresh_pending",
      eligibilityMessage: "Refresh pending"
    })
  };

  const merged = mergeWorkforcePayoutPaymentState(reviewed, payment, "workforce");
  assert.equal(merged.status, "Partially Paid");
  assert.equal(merged.publicationPaymentReady, false);
  assert.equal(merged.paymentSummary?.eligible, false);
  assert.equal(merged.paymentSummary?.eligibilityCode, "publication_refresh_pending");
});

test("payment processing stays above a finalized payment during publication refresh", () => {
  const reviewed = {
    id: "paid-processing-refresh-row",
    netAmount: 1_500,
    status: "Publication refresh pending",
    publicationLockState: "locked",
    publicationPaymentReady: false,
    publicationTargetAmount: 1_000
  };
  const payment = {
    ...reviewed,
    paymentSummary: paymentSummary({
      currentNetAmount: 0,
      paidAmount: 1_000,
      processingAmount: 500,
      balancePayable: 0,
      status: "Payment Processing",
      eligibilityCode: "publication_refresh_pending",
      eligibilityMessage: "Refresh pending"
    })
  };

  const merged = mergeWorkforcePayoutPaymentState(reviewed, payment, "workforce");
  assert.equal(merged.status, "Payment Processing");
  assert.equal(merged.publicationPaymentReady, false);
});

test("a pending publication refresh preserves paid and processing ledger context", () => {
  const reviewed = {
    id: "processing-refresh-row",
    netAmount: 5_000,
    status: "Publication refresh pending",
    publicationLockState: "locked",
    publicationPaymentReady: false,
    publicationTargetAmount: 3_000
  };
  const payment = {
    ...reviewed,
    paymentSummary: paymentSummary({
      processingPaymentItemId: "payment-item-1",
      processingInstructionAmount: 500,
      currentNetAmount: 0,
      paidAmount: 1_000,
      processingAmount: 500,
      historyCount: 3,
      status: "Payment Processing",
      eligibilityCode: "publication_refresh_pending",
      eligibilityMessage: "Refresh pending"
    })
  };

  const merged = mergeWorkforcePayoutPaymentState(reviewed, payment, "workforce");
  assert.equal(merged.status, "Payment Processing");
  assert.equal(merged.publicationPaymentReady, false);
  assert.equal(merged.paymentSummary?.currentNetAmount, 3_000);
  assert.equal(merged.paymentSummary?.paidAmount, 1_000);
  assert.equal(merged.paymentSummary?.processingAmount, 500);
  assert.equal(merged.paymentSummary?.balancePayable, 2_000);
  assert.equal(merged.paymentSummary?.availableToPay, 0);
  assert.equal(merged.paymentSummary?.historyCount, 3);
  assert.equal(merged.paymentSummary?.processingPaymentItemId, "payment-item-1");
  assert.equal(merged.paymentSummary?.processingInstructionAmount, 500);
  assert.equal(merged.paymentSummary?.eligibilityCode, "publication_refresh_pending");
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
