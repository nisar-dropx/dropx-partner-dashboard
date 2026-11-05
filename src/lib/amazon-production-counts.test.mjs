import assert from "node:assert/strict";
import test from "node:test";
import { amazonProductionCounts } from "./amazon-production-counts.ts";

const row = { workDate: "2026-10-01", shipmentType: "Delivery", delivered: 23,
  smd: 0, smd2: 0, swa: 1, finalCReturn: 1, mfn: 0, mfnReturn: 0 };

test("Delivery C-return is paid as delivery from October 1", () => {
  assert.deepEqual(amazonProductionCounts(row), {
    amazonDelivery: 24, cReturn: 0, totalDelivery: 25, totalActivity: 25
  });
});
test("ReturnPickup remains separate and both rows match the salary script", () => {
  const delivery = amazonProductionCounts(row);
  const pickup = amazonProductionCounts({ ...row, shipmentType: "ReturnPickup", delivered: 0, swa: 0 });
  assert.equal(delivery.totalDelivery + pickup.totalDelivery, 25);
  assert.equal(delivery.cReturn + pickup.cReturn, 1);
  assert.equal((delivery.totalDelivery + pickup.totalDelivery) * 15 + (delivery.cReturn + pickup.cReturn) * 9, 384);
});
test("September keeps its previous classification", () => {
  assert.deepEqual(amazonProductionCounts({ ...row, workDate: "2026-09-30" }), {
    amazonDelivery: 23, cReturn: 1, totalDelivery: 24, totalActivity: 25
  });
});
test("SMD, SMD2, SWA and MFN each contribute once", () => {
  assert.deepEqual(amazonProductionCounts({ ...row, smd: 2, smd2: 3, swa: 4, mfn: 5, mfnReturn: 6 }), {
    amazonDelivery: 29, cReturn: 0, totalDelivery: 33, totalActivity: 44
  });
});
test("unknown shipment types do not receive C-return credit", () => {
  assert.equal(amazonProductionCounts({ ...row, shipmentType: "Other" }).cReturn, 0);
  assert.equal(amazonProductionCounts({ ...row, shipmentType: " Delivery " }).amazonDelivery, 24);
});
