import assert from "node:assert/strict";
import test from "node:test";
import {
  officialAssociateDeliveryCount,
  officialBreakdownDeliveryCount
} from "./associate-delivery-count.ts";

test("uses only Amazon Daily Shipment Count for associate delivery", () => {
  const imported = {
    amazon_delivery: 223,
    swa_delivery: 1,
    c_return: 4,
    total_delivery: 224,
    total_activity: 228
  };

  assert.equal(officialAssociateDeliveryCount(imported.amazon_delivery), 223);
});

test("reconstructs the official Amazon count from its base, SMD and SMD2 fields", () => {
  assert.equal(officialBreakdownDeliveryCount({
    base_amazon_delivery: 220,
    smd_delivery: 2,
    smd2_delivery: 1
  }), 223);
});
