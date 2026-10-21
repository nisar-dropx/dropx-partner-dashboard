import assert from "node:assert/strict";
import test from "node:test";

import { chunkedValues, mapWithConcurrency } from "./bounded-concurrency.ts";
import {
  loadPostgrestInFilterBatches,
  POSTGREST_IN_FILTER_BATCH_SIZE
} from "./postgrest-in-filter-batching.ts";

test("bounded mapping preserves input order without exceeding its concurrency", async () => {
  let active = 0;
  let peak = 0;
  const values = Array.from({ length: 9 }, (_, index) => index + 1);
  const result = await mapWithConcurrency(values, 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value % 3 === 0 ? 2 : 5));
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(result, values.map((value) => value * 10));
  assert.equal(peak, 3);
});

test("bounded mapping and chunking reject invalid limits", async () => {
  await assert.rejects(() => mapWithConcurrency([1], 0, async (value) => value), /positive whole number/);
  assert.throws(() => chunkedValues([1], 0), /positive whole number/);
});

test("chunking keeps every value in stable order", () => {
  const values = Array.from({ length: 237 }, (_, index) => index);
  const chunks = chunkedValues(values, 100);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 37]);
  assert.deepEqual(chunks.flat(), values);
});

test("large PostgREST IN filters are split below the gateway request limit", async () => {
  const values = Array.from({ length: 1_403 }, (_, index) => `id-${index + 1}`);
  const batchSizes = [];
  const result = await loadPostgrestInFilterBatches({
    values,
    loadBatch: async (batch) => {
      batchSizes.push(batch.length);
      return { data: batch.map((id) => ({ id })), error: null };
    }
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.data.map((row) => row.id), values);
  assert.equal(batchSizes.length, 15);
  assert.equal(batchSizes.filter((size) => size === POSTGREST_IN_FILTER_BATCH_SIZE).length, 14);
  assert.ok(batchSizes.includes(3));
});

test("the first failed IN-filter batch remains terminal", async () => {
  const expectedError = { message: "permission denied", code: "42501" };
  let calls = 0;
  const result = await loadPostgrestInFilterBatches({
    values: ["one", "two", "three"],
    batchSize: 1,
    concurrency: 1,
    loadBatch: async (batch) => {
      calls += 1;
      if (batch[0] === "two") return { data: null, error: expectedError };
      return { data: batch, error: null };
    }
  });

  assert.equal(calls, 3);
  assert.equal(result.error, expectedError);
  assert.deepEqual(result.data, ["one"]);
});
