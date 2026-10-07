import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateResolvedShipmentDeliveriesByWorkforceDay,
  mappingsForAuthorizedWorkforce,
  payoutMappingMatchesShipment,
  resolveShipmentPayoutMapping,
  shipmentIdentityKey,
  workforcePayoutDropxStatus
} from "./workforce-payout-population.ts";
import { shipmentAttendanceUnit } from "./workforce-attendance-capture.ts";

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

test("monthly threshold carry-in includes prior-station mappings only for authorized workers", () => {
  const mappings = [
    { id: "old-a", workforce_id: "worker-1", station_id: "station-a" },
    { id: "current-b", workforce_id: "worker-1", station_id: "station-b" },
    { id: "other-a", workforce_id: "worker-2", station_id: "station-a" },
    { id: "legacy-b", contractor_id: "contractor-1", station_id: "station-b" }
  ];

  assert.deepEqual(
    mappingsForAuthorizedWorkforce(mappings, [{ id: "worker-1", source_profile_id: "contractor-1" }]).map((row) => row.id),
    ["old-a", "current-b", "legacy-b"]
  );
});

test("shipment attendance threshold is stable when deliveries span visible and hidden stations", () => {
  const mappings = [
    {
      ...mapping,
      id: "worker-1-station-a",
      workforce_id: "worker-1",
      stationCode: "KOZA"
    },
    {
      ...mapping,
      id: "worker-1-station-b",
      workforce_id: "worker-1",
      stationCode: "KLZH"
    },
    {
      ...mapping,
      id: "other-worker-station-c",
      workforce_id: "worker-2",
      workforceId: "worker-2",
      providerMemberId: "AM999",
      stationCode: "NOIDA"
    }
  ];
  const shipments = [
    { ...shipment, station_code: "KOZA", total_delivery: 4 },
    { ...shipment, station_code: "KLZH", total_delivery: 6 },
    { ...shipment, provider_employee_id: "AM999", station_code: "NOIDA", total_delivery: 50 }
  ];
  const policy = {
    capture_method: "shipment_data",
    minimum_daily_deliveries: 10,
    effective_from: "2026-09-01"
  };

  for (const viewerStation of ["KOZA", "KLZH"]) {
    const visibleMapping = mappings.find((candidate) => candidate.stationCode === viewerStation);
    const canonicalWorkers = [{ id: visibleMapping.workforce_id }];
    const allStationIdentities = mappingsForAuthorizedWorkforce(mappings, canonicalWorkers);
    const resolutions = new Map(shipments.map((row) => [
      row,
      resolveShipmentPayoutMapping(row, allStationIdentities)
    ]));
    const deliveries = aggregateResolvedShipmentDeliveriesByWorkforceDay(
      shipments,
      (row) => resolutions.get(row)
    );

    assert.equal(deliveries.get("worker-1|2026-09-10"), 10, viewerStation);
    assert.equal(
      shipmentAttendanceUnit(deliveries.get("worker-1|2026-09-10"), policy),
      1,
      viewerStation
    );
    assert.equal(deliveries.has("worker-2|2026-09-10"), false, viewerStation);

    const scopedRows = shipments.filter((row) => row.station_code === viewerStation);
    const scopedDeliveries = aggregateResolvedShipmentDeliveriesByWorkforceDay(
      scopedRows,
      (row) => resolveShipmentPayoutMapping(row, allStationIdentities)
    );
    assert.equal(
      scopedDeliveries.get("worker-1|2026-09-10"),
      viewerStation === "KOZA" ? 4 : 6,
      viewerStation
    );
  }
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
