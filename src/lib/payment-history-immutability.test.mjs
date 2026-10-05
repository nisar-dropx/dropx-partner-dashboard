import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMappedPaymentMethodComponentsUnchanged,
  assertPaymentCalculationMetadataEditable,
  paymentMethodComponentOrderChanged
} from "./payment-history-immutability.ts";

test("mapped payment methods preserve field membership and payout order", () => {
  assert.equal(paymentMethodComponentOrderChanged(["delivery", "return"], ["delivery", "return"]), false);
  assert.equal(paymentMethodComponentOrderChanged(["delivery", "return"], ["return", "delivery"]), true);
  assert.equal(paymentMethodComponentOrderChanged(["delivery", "return"], ["delivery"]), true);
  assert.equal(paymentMethodComponentOrderChanged(["delivery"], ["delivery", "return"]), true);

  assert.doesNotThrow(() => assertMappedPaymentMethodComponentsUnchanged({
    mappingCount: 2,
    existingPaymentFieldIds: ["delivery", "return"],
    nextPaymentFieldIds: ["delivery", "return"]
  }));
  assert.throws(() => assertMappedPaymentMethodComponentsUnchanged({
    mappingCount: 2,
    existingPaymentFieldIds: ["delivery", "return"],
    nextPaymentFieldIds: ["return", "delivery"]
  }), /earlier payouts stay unchanged/);
  assert.doesNotThrow(() => assertMappedPaymentMethodComponentsUnchanged({
    mappingCount: 0,
    existingPaymentFieldIds: ["delivery"],
    nextPaymentFieldIds: ["return"]
  }));
});

test("calculation sources are immutable once their method has a mapping", () => {
  assert.doesNotThrow(() => assertPaymentCalculationMetadataEditable({ mappingCount: 0, subject: "payment field" }));
  assert.throws(() => assertPaymentCalculationMetadataEditable({ mappingCount: 1, subject: "payment field" }), /earlier payouts stay unchanged/);
  assert.throws(() => assertPaymentCalculationMetadataEditable({ mappingCount: 4, subject: "provider production count" }), /earlier payouts stay unchanged/);
});
