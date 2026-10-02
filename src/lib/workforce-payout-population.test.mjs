import assert from "node:assert/strict";
import test from "node:test";
import {
  payoutMappingMatchesShipment,
  resolveShipmentPayoutMapping,
  shipmentIdentityKey,
  workforcePayoutDropxStatus
} from "./workforce-payout-population.ts";

const shipment = {
  provider_employee_id: "am-101",
  provider_employee_name: "Example Person",
  work_date: "2026-09-10",
  station_code: "KOZA",
  client: "Amazon"
};

const mapping = {
  id: "mapping-1",
  providerMemberId: "AM101",
  stationCode: "KOZA",
  providerIdentity: "AMAZON Amazon",
  effectiveFrom: "2026-09-01",
  effectiveTo: null,
  workforceId: "worker-1",
  paymentMethodId: "method-1"
};

test("shipment mapping uses provider ID, date, station and client", () => {
  assert.equal(payoutMappingMatchesShipment(mapping, shipment), true);
  assert.equal(payoutMappingMatchesShipment({ ...mapping, stationCode: "KLZH" }, shipment), false);
  assert.equal(payoutMappingMatchesShipment({ ...mapping, providerIdentity: "Flipkart" }, shipment), false);
  assert.equal(payoutMappingMatchesShipment({ ...mapping, effectiveFrom: "2026-09-11" }, shipment), false);
});

test("mapping resolution distinguishes unmapped, mapped and conflicting identities", () => {
  assert.equal(resolveShipmentPayoutMapping(shipment, []).kind, "unmapped");
  assert.deepEqual(resolveShipmentPayoutMapping(shipment, [mapping]), {
    kind: "mapped",
    workforceId: "worker-1",
    matches: [mapping]
  });
  assert.equal(resolveShipmentPayoutMapping(shipment, [mapping, { ...mapping, id: "mapping-2", workforceId: "worker-2" }]).kind, "conflict");
  assert.equal(resolveShipmentPayoutMapping(shipment, [{ ...mapping, workforceId: "" }]).kind, "conflict");
});

test("report identity grouping keeps the same provider ID separate by station and client", () => {
  assert.notEqual(shipmentIdentityKey(shipment), shipmentIdentityKey({ ...shipment, station_code: "KLZH" }));
  assert.notEqual(shipmentIdentityKey(shipment), shipmentIdentityKey({ ...shipment, client: "Flipkart" }));
});

test("DropX status exposes onboarding, lifecycle and inactive states", () => {
  assert.equal(workforcePayoutDropxStatus({ onboarding_status: "pending", lifecycle_status: "", is_active: false }), "Pending");
  assert.equal(workforcePayoutDropxStatus({ onboarding_status: "pending", lifecycle_status: "onboarding", is_active: false }), "Pending");
  assert.equal(workforcePayoutDropxStatus({ onboarding_status: "active", lifecycle_status: "onboarding", is_active: true }), "Active");
  assert.equal(workforcePayoutDropxStatus({ onboarding_status: "returned", lifecycle_status: "", is_active: false }), "Returned");
  assert.equal(workforcePayoutDropxStatus({ onboarding_status: "active", lifecycle_status: "settlement_pending", is_active: true }), "Settlement Pending");
  assert.equal(workforcePayoutDropxStatus({ onboarding_status: "active", lifecycle_status: "active", is_active: true }), "Active");
  assert.equal(workforcePayoutDropxStatus({ onboarding_status: "active", lifecycle_status: "active", is_active: false }), "Inactive");
});
