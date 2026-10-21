import assert from "node:assert/strict";
import test from "node:test";
import {
  assignedCountProvided,
  deliverySuccessPercent,
  mergeAssignedOnReimport,
  parseOptionalAssignedCount
} from "./shipment-assigned-count.ts";

test("parses valid assigned counts and treats absent columns as null", () => {
  assert.equal(parseOptionalAssignedCount("55", true), 55);
  assert.equal(parseOptionalAssignedCount("0", true), 0);
  assert.equal(parseOptionalAssignedCount("", true), null);
  assert.equal(parseOptionalAssignedCount("-", true), null);
  assert.equal(parseOptionalAssignedCount("12", false), null);
  assert.equal(parseOptionalAssignedCount("", false), null);
  assert.equal(assignedCountProvided(0), true);
  assert.equal(assignedCountProvided(null), false);
});

test("reimport preserves a valid assigned count when the source omits it", () => {
  assert.equal(mergeAssignedOnReimport(null, 40), 40);
  assert.equal(mergeAssignedOnReimport(undefined, 40), 40);
  assert.equal(mergeAssignedOnReimport(0, 40), 0);
  assert.equal(mergeAssignedOnReimport(12, 40), 12);
  assert.equal(mergeAssignedOnReimport(null, 0), 0);
  assert.equal(mergeAssignedOnReimport(null, null), 0);
});

test("delivery success percentage is null when assigned is not trustworthy", () => {
  assert.equal(deliverySuccessPercent(40, 50), 80);
  assert.equal(deliverySuccessPercent(0, 10), 0);
  assert.equal(deliverySuccessPercent(40, 0), null);
  assert.equal(deliverySuccessPercent(40, -1), null);
});
