import test from "node:test";
import assert from "node:assert/strict";
import {
  directPaymentMethodEligible,
  directPaymentMethodIssue,
  normalizeDirectPaymentValues,
  previousIsoDate
} from "./workforce-payment-allocation.ts";

const amountComponents = [
  { code: "WORKDAY_RATE", label: "Workday rate", type: "amount", schedule: "per_day", active: true },
  { code: "FIXED_ALLOWANCE", label: "Fixed allowance", type: "amount", schedule: "per_month", active: true }
];

test("direct payment methods reject every active production component", () => {
  const components = [...amountComponents, { code: "DELIVERY", label: "Delivery", type: "production", active: true }];
  assert.equal(directPaymentMethodEligible(components), false);
  assert.match(directPaymentMethodIssue(components), /cannot contain production/i);
  assert.equal(directPaymentMethodEligible([...amountComponents, { ...components[2], active: false }]), true);
});

test("direct payment methods require at least one active amount component", () => {
  assert.equal(directPaymentMethodEligible([]), false);
  assert.equal(directPaymentMethodEligible([{ ...amountComponents[0], active: false }]), false);
  assert.equal(directPaymentMethodEligible(amountComponents), true);
  assert.equal(directPaymentMethodEligible([{ ...amountComponents[0], schedule: null }]), false);
  assert.match(directPaymentMethodIssue([{ ...amountComponents[0], schedule: null }]), /schedule/i);
});

test("payment values are normalized to finite non-negative numbers", () => {
  assert.deepEqual(normalizeDirectPaymentValues(amountComponents, {
    WORKDAY_RATE: "1,250.50",
    FIXED_ALLOWANCE: 0
  }), {
    WORKDAY_RATE: 1250.5,
    FIXED_ALLOWANCE: 0
  });
  assert.throws(() => normalizeDirectPaymentValues(amountComponents, { WORKDAY_RATE: 100 }), /Fixed allowance is required/);
  assert.throws(() => normalizeDirectPaymentValues(amountComponents, { WORKDAY_RATE: -1, FIXED_ALLOWANCE: 0 }), /non-negative/);
  assert.throws(() => normalizeDirectPaymentValues(amountComponents, { WORKDAY_RATE: 1, FIXED_ALLOWANCE: 2, DELIVERY: 3 }), /not part/);
});

test("history close dates use the previous calendar day in UTC", () => {
  assert.equal(previousIsoDate("2028-03-01"), "2028-02-29");
  assert.throws(() => previousIsoDate("01/03/2028"), /invalid/);
});
