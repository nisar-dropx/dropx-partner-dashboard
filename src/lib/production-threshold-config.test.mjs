import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProductionThresholdConfig,
  parseProductionThresholdConfig,
  productionThresholdLabel
} from "./production-threshold-config.ts";

const components = [
  { component_code: "DELIVERY", component_type: "production" },
  { component_code: "CUSTOMER_RETURN", component_type: "production" },
  { component_code: "VAN_RENT", component_type: "amount" }
];

test("builds one ordered combined threshold from selected production fields", () => {
  assert.deepEqual(buildProductionThresholdConfig({
    enabled: true,
    period: "month",
    selectedComponentCodes: ["customer_return", "DELIVERY"],
    components
  }), {
    period: "month",
    component_codes: ["DELIVERY", "CUSTOMER_RETURN"]
  });
});

test("disabled threshold is stored as null", () => {
  assert.equal(buildProductionThresholdConfig({
    enabled: false,
    period: "invalid",
    selectedComponentCodes: [],
    components
  }), null);
});

test("combined threshold rejects amount fields and unselected fields", () => {
  assert.throws(() => buildProductionThresholdConfig({
    enabled: true,
    period: "day",
    selectedComponentCodes: ["VAN_RENT"],
    components
  }), /only production fields|at least one production field/);

  assert.throws(() => buildProductionThresholdConfig({
    enabled: true,
    period: "day",
    selectedComponentCodes: ["DELIVERY", "NOT_IN_METHOD"],
    components
  }), /only production fields selected/);
});

test("combined threshold requires a cadence and at least one production field", () => {
  assert.throws(() => buildProductionThresholdConfig({
    enabled: true,
    period: "week",
    selectedComponentCodes: ["DELIVERY"],
    components
  }), /every day or every month/);

  assert.throws(() => buildProductionThresholdConfig({
    enabled: true,
    period: "month",
    selectedComponentCodes: [],
    components
  }), /at least one production field/);
});

test("parses persisted configuration defensively", () => {
  const parsed = parseProductionThresholdConfig({
    period: "day",
    component_codes: [" delivery ", "DELIVERY", "customer_return"]
  });
  assert.deepEqual(parsed, { period: "day", component_codes: ["DELIVERY", "CUSTOMER_RETURN"] });
  assert.equal(productionThresholdLabel(parsed), "Combined minimum per day");
  assert.equal(parseProductionThresholdConfig({ period: "week", component_codes: ["DELIVERY"] }), null);
  assert.equal(parseProductionThresholdConfig({ period: "month", component_codes: [] }), null);
  assert.equal(parseProductionThresholdConfig({ period: "month", component_codes: [1] }), null);
  assert.equal(parseProductionThresholdConfig({ period: "month", component_codes: [" "] }), null);
});
