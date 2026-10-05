import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateCombinedProductionThresholds,
  parseEffectiveProductionThresholdConfig
} from "./workforce-production-threshold.ts";

const threshold = (period = "day", minimumUnits = 100) => ({
  period,
  component_codes: ["DELIVERY", "CRETURN"],
  minimum_units: minimumUnits
});

function input(overrides = {}) {
  return {
    id: "mapping-1|2026-09-01|DELIVERY",
    workforceId: "worker-1",
    mappingId: "mapping-1",
    date: "2026-09-01",
    effectiveFrom: "2026-09-01",
    effectiveTo: null,
    componentCode: "DELIVERY",
    componentOrder: 1,
    reportedUnits: 80,
    rate: 10,
    thresholdConfig: threshold(),
    ...overrides
  };
}

test("daily combined threshold allocates the crossing component in payment-field order", () => {
  const allocations = allocateCombinedProductionThresholds([
    input({ id: "return", componentCode: "CRETURN", componentOrder: 2, reportedUnits: 30, rate: 20 }),
    input({ id: "delivery" })
  ]);

  assert.deepEqual(allocations.map((item) => ({
    id: item.id,
    reported: item.reportedUnits,
    excluded: item.thresholdDeducted,
    payable: item.payableUnits,
    amount: item.amount
  })), [
    { id: "delivery", reported: 80, excluded: 80, payable: 0, amount: 0 },
    { id: "return", reported: 30, excluded: 20, payable: 10, amount: 200 }
  ]);
});

test("effective snapshot order wins over a later live payment-field reorder", () => {
  const allocations = allocateCombinedProductionThresholds([
    input({ id: "return", componentCode: "CRETURN", componentOrder: 0, reportedUnits: 30, rate: 20 }),
    input({ id: "delivery", componentOrder: 1 })
  ]);

  assert.deepEqual(allocations.map((item) => [item.id, item.thresholdDeducted, item.payableUnits]), [
    ["delivery", 80, 0],
    ["return", 20, 10]
  ]);
});

test("monthly threshold processes dates chronologically and resets at the calendar month", () => {
  const allocations = allocateCombinedProductionThresholds([
    input({ id: "october", date: "2026-10-01", reportedUnits: 110, thresholdConfig: threshold("month") }),
    input({ id: "september-second", date: "2026-09-02", reportedUnits: 30, thresholdConfig: threshold("month") }),
    input({ id: "september-first", date: "2026-09-01", reportedUnits: 80, thresholdConfig: threshold("month") })
  ]);

  assert.deepEqual(allocations.map((item) => [item.id, item.thresholdDeducted, item.payableUnits]), [
    ["september-first", 80, 0],
    ["september-second", 20, 10],
    ["october", 100, 10]
  ]);
});

test("multiple provider IDs for one canonical worker consume one shared minimum", () => {
  const allocations = allocateCombinedProductionThresholds([
    input({ id: "provider-a", mappingId: "provider-a", reportedUnits: 70 }),
    input({ id: "provider-b", mappingId: "provider-b", componentCode: "CRETURN", componentOrder: 2, reportedUnits: 50, rate: 15 })
  ]);

  assert.equal(allocations.reduce((sum, item) => sum + item.thresholdDeducted, 0), 100);
  assert.equal(allocations.reduce((sum, item) => sum + item.payableUnits, 0), 20);
  assert.equal(allocations.find((item) => item.id === "provider-b")?.amount, 300);
});

test("threshold state is separate per canonical worker", () => {
  const allocations = allocateCombinedProductionThresholds([
    input({ id: "worker-a", workforceId: "worker-a", reportedUnits: 110 }),
    input({ id: "worker-b", workforceId: "worker-b", reportedUnits: 110 })
  ]);

  assert.deepEqual(allocations.map((item) => [item.workforceId, item.thresholdDeducted, item.payableUnits]), [
    ["worker-a", 100, 10],
    ["worker-b", 100, 10]
  ]);
});

test("inactive mapping dates do not consume or receive threshold allocation", () => {
  const allocations = allocateCombinedProductionThresholds([
    input({ id: "before", date: "2026-08-31" }),
    input({ id: "active", date: "2026-09-01", reportedUnits: 120 }),
    input({ id: "after", date: "2026-09-11", effectiveTo: "2026-09-10" })
  ]);

  assert.deepEqual(allocations.map((item) => item.id), ["active"]);
  assert.equal(allocations[0].thresholdDeducted, 100);
  assert.equal(allocations[0].payableUnits, 20);
});

test("production fields outside the configured combined minimum remain fully payable", () => {
  const [allocation] = allocateCombinedProductionThresholds([
    input({ componentCode: "SELLER_PICKUP", reportedUnits: 25, rate: 7 })
  ]);

  assert.equal(allocation.thresholdApplied, false);
  assert.equal(allocation.reportedUnits, 25);
  assert.equal(allocation.thresholdDeducted, 0);
  assert.equal(allocation.payableUnits, 25);
  assert.equal(allocation.amount, 175);
  assert.equal(allocation.thresholdPeriod, null);
});

test("effective snapshot parsing requires a positive whole-unit minimum", () => {
  assert.deepEqual(parseEffectiveProductionThresholdConfig(threshold("month", 250)), {
    period: "month",
    component_codes: ["DELIVERY", "CRETURN"],
    minimum_units: 250
  });
  assert.equal(parseEffectiveProductionThresholdConfig({ ...threshold(), minimum_units: 0 }), null);
  assert.equal(parseEffectiveProductionThresholdConfig({ ...threshold(), minimum_units: 1.5 }), null);
  assert.equal(parseEffectiveProductionThresholdConfig({ ...threshold(), minimum_units: "not-a-number" }), null);
});

test("enabled method without an effective mapping snapshot fails closed", () => {
  const [allocation] = allocateCombinedProductionThresholds([
    input({
      reportedUnits: 25,
      thresholdConfig: null,
      methodThresholdConfig: { period: "day", component_codes: ["DELIVERY", "CRETURN"] }
    })
  ]);

  assert.equal(allocation.thresholdConfigurationMissing, true);
  assert.equal(allocation.reportedUnits, 25);
  assert.equal(allocation.thresholdDeducted, 25);
  assert.equal(allocation.payableUnits, 0);
  assert.equal(allocation.amount, 0);
  assert.equal(allocation.thresholdPeriod, "day");
  assert.equal(allocation.thresholdMinimum, null);
});

test("pre-feature mapping explicitly disabled by migration stays fully payable after method enablement", () => {
  const [allocation] = allocateCombinedProductionThresholds([
    input({
      reportedUnits: 25,
      thresholdConfig: { enabled: false },
      methodThresholdConfig: { period: "day", component_codes: ["DELIVERY", "CRETURN"] }
    })
  ]);

  assert.equal(allocation.thresholdConfigurationMissing, false);
  assert.equal(allocation.thresholdApplied, false);
  assert.equal(allocation.thresholdDeducted, 0);
  assert.equal(allocation.payableUnits, 25);
  assert.equal(allocation.amount, 250);
});

test("historical mapping snapshot remains authoritative after the method rule changes", () => {
  const [allocation] = allocateCombinedProductionThresholds([
    input({
      reportedUnits: 120,
      thresholdConfig: threshold("day", 100),
      methodThresholdConfig: { period: "month", component_codes: ["DELIVERY"] }
    })
  ]);

  assert.equal(allocation.thresholdConfigurationMissing, false);
  assert.equal(allocation.thresholdPeriod, "day");
  assert.equal(allocation.thresholdMinimum, 100);
  assert.equal(allocation.payableUnits, 20);
});
