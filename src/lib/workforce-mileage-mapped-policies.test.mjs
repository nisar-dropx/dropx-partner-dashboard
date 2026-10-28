import test from "node:test";
import assert from "node:assert/strict";
import { aggregateMappedMileageTerms } from "./workforce-mileage-mapped-policies.ts";

test("aggregates KM_RUN mappings into station terms", () => {
  const terms = aggregateMappedMileageTerms([
    { id: "1", station_id: "s1", workforce_id: "w1", payment_values: { KM_RUN: 3 }, effective_from: "2026-01-01", effective_to: null, status: "active" },
    { id: "2", station_id: "s1", workforce_id: "w2", payment_values: { KM_RUN: 3 }, effective_from: "2026-02-01", effective_to: "2026-12-31", status: "active" },
    { id: "3", station_id: "s2", workforce_id: "w3", payment_values: { km_run: 2.5 }, effective_from: "2026-03-01", effective_to: null, status: "closed" }
  ]);
  assert.equal(terms.length, 2);
  const s1 = terms.find((term) => term.stationId === "s1");
  assert.equal(s1?.ratePerKm, 3);
  assert.equal(s1?.mappedCount, 2);
  assert.equal(s1?.openEnded, true);
  assert.equal(s1?.rateConflict, false);
  const s2 = terms.find((term) => term.stationId === "s2");
  assert.equal(s2?.ratePerKm, 2.5);
});

test("flags conflicting station rates and ignores zero or missing KM_RUN", () => {
  const terms = aggregateMappedMileageTerms([
    { id: "1", station_id: "s1", workforce_id: "w1", payment_values: { KM_RUN: 3 }, effective_from: "2026-01-01", effective_to: null, status: "active" },
    { id: "2", station_id: "s1", workforce_id: "w2", payment_values: { KM_RUN: 2.5 }, effective_from: "2026-01-01", effective_to: null, status: "active" },
    { id: "3", station_id: "s1", workforce_id: "w3", payment_values: { KM_RUN: 0 }, effective_from: "2026-01-01", effective_to: null, status: "active" },
    { id: "4", station_id: "s3", workforce_id: "w4", payment_values: { delivery_rate: 10 }, effective_from: "2026-01-01", effective_to: null, status: "active" },
    { id: "5", station_id: "s4", workforce_id: "w5", payment_values: { KM_RUN: 3 }, effective_from: "2026-01-01", effective_to: null, status: "cancelled" }
  ]);
  assert.equal(terms.length, 1);
  assert.equal(terms[0].rateConflict, true);
  assert.deepEqual(terms[0].rates, [2.5, 3]);
});
