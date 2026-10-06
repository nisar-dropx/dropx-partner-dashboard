import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateAdditionalPayment,
  normalizeAdditionalPaymentCode,
  validateAdditionalPaymentPeriod
} from "./workforce-additional-payments.ts";

test("manual additional payments normalize codes and currency", () => {
  assert.deepEqual(calculateAdditionalPayment({
    code: " festival_bonus ",
    name: "Festival bonus",
    calculationType: "manual_amount"
  }, "1,250.555", 99), {
    code: "FESTIVAL_BONUS",
    name: "Festival bonus",
    calculationType: "manual_amount",
    inputValue: 1250.555,
    rateValue: null,
    finalAmount: 1250.56
  });
});

test("unit calculations use an explicit rate before the field default", () => {
  const field = {
    code: "DELIVERY_INCENTIVE",
    name: "Delivery incentive",
    calculationType: "units_x_rate",
    defaultRateValue: 4.5
  };
  assert.equal(calculateAdditionalPayment(field, 12).finalAmount, 54);
  assert.deepEqual(calculateAdditionalPayment(field, 12, 5), {
    code: "DELIVERY_INCENTIVE",
    name: "Delivery incentive",
    calculationType: "units_x_rate",
    inputValue: 12,
    rateValue: 5,
    finalAmount: 60
  });
});

test("calculations reject missing, negative and non-finite values", () => {
  const field = { code: "INCENTIVE", name: "Incentive", calculationType: "units_x_rate" };
  assert.throws(() => calculateAdditionalPayment(field, 10), /rate is required/i);
  assert.throws(() => calculateAdditionalPayment(field, -1, 2), /non-negative/i);
  assert.throws(() => calculateAdditionalPayment(field, 1, Number.POSITIVE_INFINITY), /finite/i);
});

test("codes and exact payout periods are validated deterministically", () => {
  assert.equal(normalizeAdditionalPaymentCode("night-bonus"), "NIGHT-BONUS");
  assert.throws(() => normalizeAdditionalPaymentCode("1 bonus"), /must start with a letter/i);
  assert.deepEqual(validateAdditionalPaymentPeriod("2026-09-01", "2026-09-30"), {
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30"
  });
  assert.throws(() => validateAdditionalPaymentPeriod("2026-10-01", "2026-09-30"), /cannot be before/i);
  assert.throws(() => validateAdditionalPaymentPeriod("2026-02-30", "2026-03-01"), /invalid date/i);
  assert.throws(() => validateAdditionalPaymentPeriod("01/09/2026", "2026-09-30"), /YYYY-MM-DD/i);
});
