import test from "node:test";
import assert from "node:assert/strict";
import { resolveConversionRate, conversionRateTiers } from "./conversion-rate-rules.ts";
import { buildWorkforcePayoutInputMaps, resolveWorkforcePaymentFieldRate } from "./workforce-payout-input-calculation.ts";
import { allocateCombinedProductionThresholds } from "./workforce-production-threshold.ts";

const rule = { id: "r", company_id: "c", provider_id: "p", payment_method_id: "m", payment_field_id: "f", location_model_id: "model", station_id: "s", numerator_source: "total_delivery", denominator_source: "delivery_assigned_count", effective_from: "2027-01-01", effective_to: "2027-01-31", tiers: [{ minimum: 0, rate: 12 }, { minimum: 80, rate: 14 }, { minimum: 90, rate: 16 }] };
const input = { rules: [rule], companyId: "c", providerId: "p", paymentMethodId: "m", paymentFieldId: "f", modelId: "model", stationId: "s", date: "2027-01-02", fallbackRate: 11, rows: [{ total_delivery: 85, delivery_assigned_count: 100 }] };

test("selects the slab at exact boundaries without rounding conversion", () => {
  for (const [count, expected] of [[0, 12], [79.999, 12], [80, 14], [89.999, 14], [90, 16], [100, 16]]) {
    assert.equal(resolveConversionRate({ ...input, rows: [{ total_delivery: count, delivery_assigned_count: 100 }] }).rate, expected);
  }
});
test("conversion is a ratio of summed counts, not an average of percentages", () => {
  assert.equal(resolveConversionRate({ ...input, rows: [{ total_delivery: 1, delivery_assigned_count: 1 }, { total_delivery: 79, delivery_assigned_count: 99 }] }).rate, 14);
});
test("floating-point percentage division cannot push an exact slab boundary down", () => {
  assert.equal(resolveConversionRate({ ...input, rules: [{ ...rule, tiers: [{ minimum: 0, rate: 10 }, { minimum: 29, rate: 15 }] }],
    rows: [{ total_delivery: 58, delivery_assigned_count: 200 }] }).rate, 15);
});
test("new methods and conversion inputs work without code-side metric names", () => {
  assert.equal(resolveConversionRate({ ...input, paymentMethodId: "NEW_METHOD", paymentFieldId: "NEW_FIELD",
    rules: [{ ...rule, payment_method_id: "NEW_METHOD", payment_field_id: "NEW_FIELD", numerator_source: "new_completed_metric", denominator_source: "new_base_metric" }],
    rows: [{ new_completed_metric: 91, new_base_metric: 100 }] }).rate, 16);
  assert.equal(resolveConversionRate({ ...input, rules: [{ ...rule, numerator_source: "mfn", denominator_source: "pickup_assigned_count" }],
    rows: [{ mfn: 85, pickup_assigned_count: 100 }] }).rate, 14);
});
test("every scope dimension and effective date must match; legacy rate is untouched", () => {
  for (const key of ["companyId", "providerId", "paymentMethodId", "paymentFieldId", "modelId", "stationId"]) assert.equal(resolveConversionRate({ ...input, [key]: "other" }).rate, 11);
  for (const date of ["2026-12-31", "2027-02-01"]) assert.equal(resolveConversionRate({ ...input, date }).rate, 11);
  assert.equal(resolveConversionRate({ ...input, rules: [] }).rate, 11);
});
test("missing, invalid, zero and incomplete assigned data preserve the fixed rate", () => {
  for (const rows of [[], [{ total_delivery: 85 }], [{ total_delivery: 0, delivery_assigned_count: 0 }], [{ total_delivery: 100, delivery_assigned_count: 90 }], [{ total_delivery: -1, delivery_assigned_count: 100 }], [...input.rows, { total_delivery: 1, delivery_assigned_count: null }]]) {
    assert.equal(resolveConversionRate({ ...input, rows }).rate, 11);
  }
});
test("zero slab rate is intentional, and overlaps cannot silently select a rate", () => {
  assert.equal(resolveConversionRate({ ...input, rules: [{ ...rule, tiers: [{ minimum: 0, rate: 0 }] }] }).rate, 0);
  assert.throws(() => resolveConversionRate({ ...input, rules: [rule, { ...rule, id: "other" }] }), /Overlapping/);
});
test("invalid tiers are rejected", () => {
  for (const tiers of [[], [{ minimum: 1, rate: 12 }], [{ minimum: 0, rate: -1 }], [{ minimum: 0, rate: 12 }, { minimum: 0, rate: 14 }], [{ minimum: 0, rate: 12 }, { minimum: 101, rate: 14 }], [{ minimum: 0, rate: Infinity }]]) assert.throws(() => conversionRateTiers(tiers));
});
test("existing individual rate overrides retain priority over a conversion slab", () => {
  const maps = buildWorkforcePayoutInputMaps({ paymentFieldOverrides: [{ id: "override", workforce_id: "worker", station_id: "s", payment_field_id: "f", field_code_snapshot: "ANY_FIELD", effective_from: "2027-01-01", effective_to: "2027-01-31", input_value: 0 }] });
  assert.equal(resolveWorkforcePaymentFieldRate(maps, { workforceId: "worker", stationId: "s", paymentFieldId: "f", date: input.date, fallbackRate: resolveConversionRate(input).rate }), 0);
});
test("production minimums reduce payable units before applying the selected conversion rate", () => {
  const [allocation] = allocateCombinedProductionThresholds([{ id: "day", workforceId: "worker", mappingId: "mapping", date: input.date,
    effectiveFrom: "2027-01-01", componentCode: "ANY_FIELD", reportedUnits: 85, rate: resolveConversionRate(input).rate,
    thresholdConfig: { period: "day", component_codes: ["ANY_FIELD"], minimum_units: 20 } }]);
  assert.equal(allocation.payableUnits, 65);
  assert.equal(allocation.amount, 65 * 14);
});
