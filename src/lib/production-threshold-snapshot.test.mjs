import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProductionThresholdSnapshot,
  disabledProductionThresholdSnapshot,
  isFirstDayOfMonth,
  isProductionThresholdExplicitlyDisabled,
  monthlyThresholdChangeRequiresMonthStart,
  parseProductionThresholdSnapshot,
  productionThresholdMinimumLabel,
  resolveMappingProductionThresholdSnapshot
} from "./production-threshold-snapshot.ts";

const methodConfig = { period: "month", component_codes: ["DELIVERY", "CUSTOMER_RETURN"] };

test("builds a person-specific snapshot without changing the method rule", () => {
  assert.deepEqual(buildProductionThresholdSnapshot(methodConfig, "1000"), {
    period: "month",
    component_codes: ["DELIVERY", "CUSTOMER_RETURN"],
    minimum_units: 1000
  });
  assert.deepEqual(methodConfig, { period: "month", component_codes: ["DELIVERY", "CUSTOMER_RETURN"] });
});

test("requires a positive person-specific minimum only when a method enables the rule", () => {
  assert.equal(buildProductionThresholdSnapshot(null, ""), null);
  assert.throws(() => buildProductionThresholdSnapshot(methodConfig, ""), /positive whole number/);
  assert.throws(() => buildProductionThresholdSnapshot(methodConfig, "0"), /positive whole number/);
  assert.throws(() => buildProductionThresholdSnapshot(methodConfig, "2.5"), /positive whole number/);
  assert.throws(() => buildProductionThresholdSnapshot(methodConfig, "not a number"), /positive whole number/);
});

test("parses only complete persisted snapshots", () => {
  assert.deepEqual(parseProductionThresholdSnapshot({ ...methodConfig, minimum_units: 1000 }), {
    ...methodConfig,
    minimum_units: 1000
  });
  assert.equal(parseProductionThresholdSnapshot(methodConfig), null);
  assert.equal(parseProductionThresholdSnapshot({ ...methodConfig, minimum_units: -1 }), null);
  assert.equal(parseProductionThresholdSnapshot({ ...methodConfig, minimum_units: 2.5 }), null);
});

test("recognizes only the exact explicit-disabled sentinel", () => {
  assert.deepEqual(disabledProductionThresholdSnapshot(), { enabled: false });
  assert.equal(isProductionThresholdExplicitlyDisabled({ enabled: false }), true);
  assert.equal(isProductionThresholdExplicitlyDisabled({ enabled: false, period: "day" }), false);
  assert.equal(isProductionThresholdExplicitlyDisabled(null), false);
});

test("legacy and explicitly disabled mapping versions never inherit a later live method rule", () => {
  assert.deepEqual(resolveMappingProductionThresholdSnapshot({
    existingValue: null,
    editsExistingVersion: true,
    methodConfig,
    minimumUnits: ""
  }), { enabled: false });
  assert.deepEqual(resolveMappingProductionThresholdSnapshot({
    existingValue: { enabled: false },
    editsExistingVersion: true,
    methodConfig,
    minimumUnits: ""
  }), { enabled: false });
  assert.throws(() => resolveMappingProductionThresholdSnapshot({
    existingValue: { enabled: false },
    editsExistingVersion: true,
    paymentMethodChanged: true,
    methodConfig,
    minimumUnits: "1000"
  }), /later Effective From date/);
});

test("existing enabled snapshots remain immutable within the same effective version", () => {
  const existingValue = { ...methodConfig, minimum_units: 1000 };
  assert.deepEqual(resolveMappingProductionThresholdSnapshot({
    existingValue,
    editsExistingVersion: true,
    methodConfig: { period: "day", component_codes: ["DELIVERY"] },
    minimumUnits: "1000"
  }), existingValue);
  assert.throws(() => resolveMappingProductionThresholdSnapshot({
    existingValue,
    editsExistingVersion: true,
    methodConfig,
    minimumUnits: "1200"
  }), /later Effective From date/);
  assert.throws(() => resolveMappingProductionThresholdSnapshot({
    existingValue,
    editsExistingVersion: true,
    paymentMethodChanged: true,
    methodConfig,
    minimumUnits: "1000"
  }), /later Effective From date/);
  assert.throws(() => resolveMappingProductionThresholdSnapshot({
    existingValue,
    editsExistingVersion: true,
    paymentMethodChanged: true,
    methodConfig: null,
    minimumUnits: ""
  }), /later Effective From date/);
});

test("new effective versions snapshot the current method rule and may inherit the prior person minimum", () => {
  assert.deepEqual(resolveMappingProductionThresholdSnapshot({
    existingValue: { enabled: false },
    editsExistingVersion: false,
    paymentMethodChanged: true,
    methodConfig,
    minimumUnits: "1000"
  }), { ...methodConfig, minimum_units: 1000 });
  assert.deepEqual(resolveMappingProductionThresholdSnapshot({
    existingValue: { ...methodConfig, minimum_units: 900 },
    editsExistingVersion: false,
    methodConfig,
    minimumUnits: "",
    inheritedMinimumUnits: 900
  }), { ...methodConfig, minimum_units: 900 });
  assert.deepEqual(resolveMappingProductionThresholdSnapshot({
    existingValue: { ...methodConfig, minimum_units: 900 },
    editsExistingVersion: false,
    methodConfig: null,
    minimumUnits: ""
  }), { enabled: false });
});

test("uses a clear mapping label", () => {
  assert.equal(productionThresholdMinimumLabel(methodConfig), "Combined minimum / month");
  assert.equal(productionThresholdMinimumLabel({ ...methodConfig, period: "day" }), "Combined minimum / day");
});

test("requires month-start only when an existing monthly rule changes", () => {
  const previous = { ...methodConfig, minimum_units: 1000 };
  assert.equal(monthlyThresholdChangeRequiresMonthStart(null, previous), false);
  assert.equal(monthlyThresholdChangeRequiresMonthStart(previous, { ...previous }), false);
  assert.equal(monthlyThresholdChangeRequiresMonthStart(previous, { ...previous, component_codes: [...previous.component_codes].reverse() }), true);
  assert.equal(monthlyThresholdChangeRequiresMonthStart(previous, { ...previous, minimum_units: 1200 }), true);
  assert.equal(monthlyThresholdChangeRequiresMonthStart(previous, { ...previous, component_codes: ["DELIVERY"] }), true);
  assert.equal(monthlyThresholdChangeRequiresMonthStart(previous, { ...previous, period: "day" }), true);
  assert.equal(monthlyThresholdChangeRequiresMonthStart(previous, null), false);
  assert.equal(isFirstDayOfMonth("2026-10-01"), true);
  assert.equal(isFirstDayOfMonth("2026-10-05"), false);
});
