import assert from "node:assert/strict";
import test from "node:test";

import { summarizeWorkforcePayoutPayments } from "./workforce-payout-payment-summary.ts";

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
    status: null
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
  assert.equal(summary?.status, "Partially paid");
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
  assert.equal(summary?.status, null);
});
