import assert from "node:assert/strict";
import test from "node:test";

import { chunkedValues, mapWithConcurrency } from "./bounded-concurrency.ts";

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
