import assert from "node:assert/strict";
import test from "node:test";
import { conditionForAssetQuantity, resolveAssetQuantities } from "./asset-quantity.ts";

test("individual assets remain a single physical unit", () => {
  assert.deepEqual(
    resolveAssetQuantities({ trackingMode: "individual", individualCondition: "good" }),
    { trackingMode: "individual", total: 1, working: 1, faulty: 0 },
  );
  assert.deepEqual(
    resolveAssetQuantities({ trackingMode: "individual", individualCondition: "damaged" }),
    { trackingMode: "individual", total: 1, working: 0, faulty: 1 },
  );
});

test("quantity assets calculate working units", () => {
  assert.deepEqual(
    resolveAssetQuantities({ trackingMode: "quantity", total: "12", faulty: "2" }),
    { trackingMode: "quantity", total: 12, working: 10, faulty: 2 },
  );
});

test("quantity assets reject an impossible faulty count", () => {
  assert.throws(
    () => resolveAssetQuantities({ trackingMode: "quantity", total: "4", faulty: "5" }),
    /cannot exceed total quantity/,
  );
});

test("quantity condition reflects the group health", () => {
  assert.equal(conditionForAssetQuantity(10, 0), "good");
  assert.equal(conditionForAssetQuantity(10, 1), "damaged");
  assert.equal(conditionForAssetQuantity(10, 10), "unusable");
});
