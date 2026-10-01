import assert from "node:assert/strict";
import test from "node:test";
import { ongoingMappingClosureError } from "./provider-mapping-period.ts";

test("blocks ending an ongoing mapping without creating its successor", () => {
  assert.match(ongoingMappingClosureError({
    existingEffectiveFrom: "2026-09-01",
    existingEffectiveTo: null,
    requestedEffectiveFrom: "2026-09-01",
    requestedEffectiveTo: "2026-09-22"
  }) ?? "", /cannot end without its next payment period/);
});

test("allows an immediately succeeding payment period", () => {
  assert.equal(ongoingMappingClosureError({
    existingEffectiveFrom: "2026-09-01",
    existingEffectiveTo: null,
    requestedEffectiveFrom: "2026-09-23",
    requestedEffectiveTo: null
  }), null);
});

test("allows editing a bounded historical period", () => {
  assert.equal(ongoingMappingClosureError({
    existingEffectiveFrom: "2026-09-01",
    existingEffectiveTo: "2026-09-22",
    requestedEffectiveFrom: "2026-09-01",
    requestedEffectiveTo: "2026-09-22"
  }), null);
});
