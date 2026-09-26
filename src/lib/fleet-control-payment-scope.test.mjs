import assert from "node:assert/strict";
import test from "node:test";
import { isAdHocPaymentHead, isFleetManagerPaymentHead } from "./fleet-control-payment-scope.ts";

test("Fleet Manager payment scope includes owned vehicle expenses", () => {
  for (const name of [
    "Vehicle Service/Maintenance",
    "Vehicle Repair / Tyre",
    "Fleet Insurance",
    "PUC Renewal",
    "Vehicle Fuel",
    "Van Maintenance"
  ]) {
    assert.equal(isFleetManagerPaymentHead({ name }), true, name);
  }
});

test("ad-hoc capacity stays visibility-only", () => {
  for (const name of [
    "Adhoc Van",
    "Ad-hoc Van Cashbook",
    "AD HOC VAN",
    "Van - Adhoc Driver"
  ]) {
    assert.equal(isAdHocPaymentHead({ name }), true, name);
    assert.equal(isFleetManagerPaymentHead({ name }), false, name);
  }
});

test("unrelated operational expenses do not enter the Fleet queue", () => {
  for (const name of ["Pantry", "Station Visits", "Adhoc DA", "Vendor Payment"]) {
    assert.equal(isFleetManagerPaymentHead({ name }), false, name);
  }
});
