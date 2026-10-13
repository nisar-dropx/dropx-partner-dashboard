import assert from "node:assert/strict";
import test from "node:test";
import {
  providerFirstLocationIsAllowed,
  providerFirstLocationRemap,
  providerFirstNamesMatch
} from "./provider-first-mapping-view.ts";

const baseWorker = {
  id: "worker-1",
  dropxId: "DF1264",
  fullName: "Mohammed Thaha",
  stationId: "station-a",
  providerId: "provider-1",
  dateOfJoin: "2026-08-01",
  mappingId: "mapping-a",
  paymentMethodId: "method-1",
  paymentValues: {},
  productionThresholdConfig: null,
  productionThresholdMinimumUnits: "",
  effectiveFrom: "2026-08-01",
  effectiveTo: "",
  mappedProviderMemberId: "2000074247130",
  locationLabel: "KGQC",
  profileStationId: "station-a",
  profileLocationLabel: "KGQC",
  onboardingStatus: "Active"
};

const secondLocationRow = {
  providerMemberId: "2000074247130",
  providerMemberName: "Thaha Mohammad B / SPVAN-DROP / 206139406",
  stationId: "station-b",
  stationLabel: "KGQE",
  providerId: "provider-1",
  workforceId: "worker-1",
  dropxId: "DF1264",
  dropxName: "Mohammed Thaha",
  mappingId: "mapping-a",
  paymentMethodId: "method-1",
  paymentValues: {},
  productionThresholdConfig: null,
  productionThresholdMinimumUnits: "",
  effectiveFrom: "2026-08-10",
  effectiveTo: "",
  history: []
};

test("one distinctive name part authorizes a multi-part provider-name match", () => {
  assert.equal(providerFirstNamesMatch(
    "Thaha Mohammad B / SPVAN-DROP / 206139406",
    "MOHAMMED THAHA"
  ), true);
  assert.equal(providerFirstNamesMatch("Suresh Chandran / DROP / 1", "CHANDRAN"), true);
  assert.equal(providerFirstNamesMatch("Rithesh Kumar / DROP / 2", "RITESH SINGH"), true);
});

test("common names and initials never provide the single matching name part", () => {
  for (const commonName of ["KUMAR", "MUHAMED", "MOHAMMED", "ABDUL", "SINGH"]) {
    assert.equal(
      providerFirstNamesMatch(`ARUN ${commonName} / DROP / 1`, `RAJESH ${commonName}`),
      false,
      `${commonName} must not authorize a mapping by itself`
    );
  }
  assert.equal(providerFirstNamesMatch("B / DROP / 2", "BASHEER"), false);
  assert.equal(providerFirstNamesMatch("R KUMAR / DROP / 3", "RITESH KUMAR"), false);
  assert.equal(providerFirstNamesMatch("Bhuwneshwar", "Bhuwaneswar"), false);
});

test("a verified registered-location mapping permits only Keep all at a second location", () => {
  assert.equal(providerFirstLocationIsAllowed(secondLocationRow, baseWorker), true);
  const remap = providerFirstLocationRemap(secondLocationRow, baseWorker);
  assert.equal(remap?.kind, "location");
  assert.equal(remap?.allowMove, false);
  assert.equal(remap?.mappingId, "mapping-a");
});

test("the location exception fails closed without exact registered-location identity evidence", () => {
  assert.equal(providerFirstLocationIsAllowed(secondLocationRow, {
    ...baseWorker,
    profileStationId: ""
  }), false);
  assert.equal(providerFirstLocationIsAllowed(secondLocationRow, {
    ...baseWorker,
    stationId: "station-c"
  }), false);
  assert.equal(providerFirstLocationIsAllowed(secondLocationRow, {
    ...baseWorker,
    providerId: "provider-2"
  }), false);
  assert.equal(providerFirstLocationIsAllowed(secondLocationRow, {
    ...baseWorker,
    mappedProviderMemberId: "different-member"
  }), false);
  assert.equal(providerFirstLocationIsAllowed(secondLocationRow, {
    ...baseWorker,
    id: "worker-2"
  }), false);
});

test("a mapping may still be moved back to the profile's registered location", () => {
  const registeredLocationRow = {
    ...secondLocationRow,
    stationId: "station-a",
    stationLabel: "KGQC"
  };
  const driftedWorker = {
    ...baseWorker,
    stationId: "station-b",
    locationLabel: "KGQE"
  };
  assert.equal(providerFirstLocationIsAllowed(registeredLocationRow, driftedWorker), true);
  assert.notEqual(providerFirstLocationRemap(registeredLocationRow, driftedWorker)?.allowMove, false);
});
