import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkValues,
  MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION,
  MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES,
  serializedJsonByteLength,
  WORKFORCE_NOTIFICATION_RECIPIENT_QUERY_CHUNK
} from "./workforce-payout-publication-limits.ts";

test("recipient lookup chunks retain every ID in stable order", () => {
  const ids = Array.from({ length: 237 }, (_, index) => `worker-${index}`);
  const chunks = chunkValues(ids, WORKFORCE_NOTIFICATION_RECIPIENT_QUERY_CHUNK);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 37]);
  assert.deepEqual(chunks.flat(), ids);
});

test("chunkValues rejects invalid sizes", () => {
  assert.throws(() => chunkValues(["worker"], 0), /positive whole number/);
  assert.throws(() => chunkValues(["worker"], 1.5), /positive whole number/);
});

test("serialized payload sizing counts UTF-8 bytes deterministically", () => {
  const payload = { english: "pay", unicode: "₹ भुगतान" };
  assert.equal(serializedJsonByteLength(payload), Buffer.byteLength(JSON.stringify(payload), "utf8"));
  assert.ok(serializedJsonByteLength("x".repeat(MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES)) > MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES);
  assert.throws(() => serializedJsonByteLength(undefined), /JSON serializable/);
});

test("notification batch and RPC size limits are deliberately bounded", () => {
  assert.equal(MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION, 50);
  assert.equal(MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES, 3 * 1024 * 1024);
});
