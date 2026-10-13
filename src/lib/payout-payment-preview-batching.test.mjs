import assert from "node:assert/strict";
import test from "node:test";

import {
  isPayoutPaymentPreviewStatementTimeout,
  loadPayoutPaymentPreviews,
  PAYOUT_PAYMENT_PREVIEW_BATCH_SIZE
} from "./payout-payment-preview-batching.ts";

test("payment previews use bounded batches and preserve every result", async () => {
  const rows = Array.from({ length: 137 }, (_, index) => index + 1);
  const batchSizes = [];
  const result = await loadPayoutPaymentPreviews({
    rows,
    loadBatch: async (batch) => {
      batchSizes.push(batch.length);
      return { data: batch.map((value) => value * 10), error: null };
    }
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.data, rows.map((value) => value * 10));
  assert.ok(batchSizes.every((size) => size <= PAYOUT_PAYMENT_PREVIEW_BATCH_SIZE));
  assert.deepEqual(batchSizes.sort((left, right) => right - left), [50, 50, 37]);
});

test("a statement timeout is retried once as two smaller batches", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => index + 1);
  const batchSizes = [];
  let first = true;
  const result = await loadPayoutPaymentPreviews({
    rows,
    concurrency: 1,
    loadBatch: async (batch) => {
      batchSizes.push(batch.length);
      if (first) {
        first = false;
        return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      }
      return { data: batch, error: null };
    }
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.data, rows);
  assert.deepEqual(batchSizes, [50, 25, 25]);
});

test("non-timeout errors remain terminal and are not retried", async () => {
  let calls = 0;
  const error = { code: "42501", message: "permission denied" };
  const result = await loadPayoutPaymentPreviews({
    rows: [1, 2, 3],
    loadBatch: async () => {
      calls += 1;
      return { data: null, error };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.error, error);
  assert.deepEqual(result.data, []);
});

test("statement timeout detection accepts Postgres codes and messages", () => {
  assert.equal(isPayoutPaymentPreviewStatementTimeout({ code: "57014" }), true);
  assert.equal(isPayoutPaymentPreviewStatementTimeout({ message: "canceling statement due to statement timeout" }), true);
  assert.equal(isPayoutPaymentPreviewStatementTimeout({ code: "42501", message: "permission denied" }), false);
});
