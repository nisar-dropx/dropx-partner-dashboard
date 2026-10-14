import assert from "node:assert/strict";
import test from "node:test";
import {
  providerFirstLocationIsAllowed,
  providerFirstLocationRemap,
  providerFirstMappingPeriodContains,
  providerFirstMappingReferenceForRow,
  providerFirstNamesMatch,
  providerFirstRowForMappingPeriod,
  providerFirstRowIssue
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

test("a closed registered-location mapping permits only fully contained bounded periods", () => {
  const historicalWorker = {
    ...baseWorker,
    mappingId: "",
    paymentMethodId: "",
    mappedProviderMemberId: "",
    effectiveFrom: "",
    effectiveTo: "",
    registeredLocationMappings: [{
      mappingId: "mapping-history",
      stationId: "station-a",
      locationLabel: "KGQC",
      providerId: "provider-1",
      mappedProviderMemberId: "2000074247130",
      paymentMethodId: "method-1",
      paymentValues: {},
      productionThresholdConfig: null,
      productionThresholdMinimumUnits: "",
      effectiveFrom: "2026-09-01",
      effectiveTo: "2026-09-30",
      status: "closed"
    }]
  };
  const exactSeptember = {
    ...secondLocationRow,
    mappingId: "",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30"
  };
  const narrowerSeptember = {
    ...exactSeptember,
    effectiveFrom: "2026-09-10",
    effectiveTo: "2026-09-20"
  };

  assert.equal(providerFirstLocationIsAllowed(exactSeptember, historicalWorker), true);
  assert.equal(providerFirstLocationIsAllowed(narrowerSeptember, historicalWorker), true);
  assert.deepEqual(providerFirstLocationRemap(exactSeptember, historicalWorker), {
    kind: "location",
    allowMove: false,
    mappingId: "mapping-history",
    providerMemberId: "2000074247130",
    providerMemberName: "Thaha Mohammad B / SPVAN-DROP / 206139406",
    existingDropxId: "DF1264",
    existingDropxName: "Mohammed Thaha",
    existingLocationLabel: "KGQC",
    newLocationLabel: "KGQE",
    effectiveFrom: "2026-09-01"
  });

  for (const outsideAnchor of [
    { ...exactSeptember, effectiveFrom: "2026-07-01", effectiveTo: "2026-07-31" },
    { ...exactSeptember, effectiveFrom: "2026-07-01", effectiveTo: "" },
    { ...exactSeptember, effectiveFrom: "2026-09-01", effectiveTo: "" },
    { ...exactSeptember, effectiveFrom: "2026-10-01", effectiveTo: "2026-10-31" },
    { ...exactSeptember, effectiveFrom: "2026-08-31", effectiveTo: "2026-09-15" },
    { ...exactSeptember, effectiveFrom: "2026-09-15", effectiveTo: "2026-10-01" }
  ]) {
    assert.equal(providerFirstLocationIsAllowed(outsideAnchor, historicalWorker), false);
    assert.equal(providerFirstLocationRemap(outsideAnchor, historicalWorker), null);
  }
});

test("location validation waits for a start date when an exact registered mapping exists", () => {
  const registeredMapping = {
    mappingId: "mapping-history",
    stationId: "station-a",
    locationLabel: "KGQC",
    providerId: "provider-1",
    mappedProviderMemberId: "2000074247130",
    paymentMethodId: "method-1",
    paymentValues: {},
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30",
    status: "closed"
  };
  const historicalWorker = {
    ...baseWorker,
    mappingId: "",
    paymentMethodId: "",
    mappedProviderMemberId: "",
    effectiveFrom: "",
    effectiveTo: "",
    registeredLocationMappings: [registeredMapping]
  };
  const awaitingStartDate = {
    ...secondLocationRow,
    mappingId: "",
    effectiveFrom: "",
    effectiveTo: ""
  };

  assert.equal(providerFirstLocationIsAllowed(awaitingStartDate, baseWorker), true);
  assert.equal(providerFirstLocationRemap(awaitingStartDate, baseWorker), null);
  assert.equal(providerFirstLocationIsAllowed(awaitingStartDate, historicalWorker), true);
  assert.equal(providerFirstLocationRemap(awaitingStartDate, historicalWorker), null);
  assert.equal(providerFirstLocationIsAllowed({
    ...awaitingStartDate,
    effectiveFrom: "2026-10-01",
    effectiveTo: "2026-10-31"
  }, historicalWorker), false);
  assert.equal(providerFirstLocationIsAllowed(awaitingStartDate, {
    ...historicalWorker,
    registeredLocationMappings: [{ ...registeredMapping, mappedProviderMemberId: "another-member" }]
  }), false);
});

test("the exact closed mapping remains the edit target when it is reopened at the same location", () => {
  const closedMapping = {
    mappingId: "mapping-history",
    stationId: "station-a",
    locationLabel: "KGQC",
    providerId: "provider-1",
    mappedProviderMemberId: "2000074247130",
    paymentMethodId: "method-history",
    paymentValues: { DELIVERY: "16" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30",
    status: "closed"
  };
  const historicalWorker = {
    ...baseWorker,
    mappingId: "",
    paymentMethodId: "",
    mappedProviderMemberId: "",
    effectiveFrom: "",
    effectiveTo: "",
    mappingHistory: [closedMapping],
    registeredLocationMappings: [closedMapping]
  };
  const reopenedRow = {
    ...secondLocationRow,
    stationId: "station-a",
    stationLabel: "KGQC",
    mappingId: closedMapping.mappingId,
    paymentMethodId: closedMapping.paymentMethodId,
    paymentValues: closedMapping.paymentValues,
    effectiveFrom: "2026-09-01",
    effectiveTo: ""
  };

  assert.equal(
    providerFirstMappingReferenceForRow(reopenedRow, historicalWorker)?.mappingId,
    closedMapping.mappingId
  );
  assert.deepEqual(providerFirstRowForMappingPeriod(reopenedRow, historicalWorker), reopenedRow);
  assert.equal(providerFirstLocationIsAllowed(reopenedRow, historicalWorker), true);

  const differentMember = { ...reopenedRow, providerMemberId: "different-member" };
  assert.equal(providerFirstMappingReferenceForRow(differentMember, historicalWorker), undefined);
  assert.equal(providerFirstRowForMappingPeriod(differentMember, historicalWorker).mappingId, "");

  // Reopening a closed row is an in-place same-location edit. It must not let
  // the historical row authorize an open-ended mapping at another location.
  const additionalLocation = { ...reopenedRow, stationId: "station-b", stationLabel: "KGQE" };
  assert.equal(providerFirstMappingReferenceForRow(additionalLocation, historicalWorker), undefined);
  assert.equal(providerFirstLocationIsAllowed(additionalLocation, historicalWorker), false);
});

test("mapping period containment is inclusive and fails closed for ambiguous dates", () => {
  assert.equal(providerFirstMappingPeriodContains("2026-09-01", "2026-09-30", "2026-09-01", "2026-09-30"), true);
  assert.equal(providerFirstMappingPeriodContains("2026-09-01", "2026-09-30", "2026-09-30", "2026-09-30"), true);
  assert.equal(providerFirstMappingPeriodContains("2026-09-01", "", "2026-09-01", ""), true);
  assert.equal(providerFirstMappingPeriodContains("2026-09-01", "2026-09-30", "2026-09-01", ""), false);

  for (const periods of [
    ["", "2026-09-30", "2026-09-01", "2026-09-30"],
    ["2026-09-01", "2026-09-30", "", "2026-09-30"],
    ["2026-09-31", "", "2026-09-01", "2026-09-30"],
    ["2026-09-01", "2026-09-30", "2026-09-31", "2026-09-31"],
    ["2026-09-30", "2026-09-01", "2026-09-10", "2026-09-20"],
    ["2026-09-01", "2026-09-30", "2026-09-20", "2026-09-10"]
  ]) {
    assert.equal(providerFirstMappingPeriodContains(...periods), false);
  }
});

test("malformed registered mapping status and end-date pairs are never anchors", () => {
  const boundedRow = {
    ...secondLocationRow,
    mappingId: "",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30"
  };
  const anchor = {
    mappingId: "mapping-history",
    stationId: "station-a",
    locationLabel: "KGQC",
    providerId: "provider-1",
    mappedProviderMemberId: "2000074247130",
    paymentMethodId: "method-1",
    paymentValues: {},
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30",
    status: "closed"
  };
  const noCurrentWorker = {
    ...baseWorker,
    mappingId: "",
    paymentMethodId: "",
    mappedProviderMemberId: "",
    effectiveFrom: "",
    effectiveTo: ""
  };
  for (const malformed of [
    { ...anchor, status: "active" },
    { ...anchor, status: "closed", effectiveTo: "" },
    { ...anchor, status: "cancelled" }
  ]) {
    assert.equal(providerFirstLocationIsAllowed(boundedRow, { ...noCurrentWorker, registeredLocationMappings: [malformed] }), false);
  }
});

test("a third-location row selects the historical registered anchor instead of another active location", () => {
  const registeredLocationMapping = {
    mappingId: "mapping-history",
    stationId: "station-a",
    locationLabel: "KGQC",
    providerId: "provider-1",
    mappedProviderMemberId: "2000074247130",
    paymentMethodId: "method-history",
    paymentValues: { DELIVERY: "16" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30",
    status: "closed"
  };
  const olderRegisteredLocationMapping = {
    ...registeredLocationMapping,
    mappingId: "mapping-history-august",
    paymentMethodId: "method-history-august",
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-08-31"
  };
  const workerWithAnotherActiveLocation = {
    ...baseWorker,
    stationId: "station-c",
    locationLabel: "NLRF",
    mappingId: "mapping-active-c",
    mappedProviderMemberId: "DIFFERENT-CURRENT-MEMBER",
    effectiveFrom: "2026-10-01",
    effectiveTo: "",
    registeredLocationMappings: [olderRegisteredLocationMapping, registeredLocationMapping]
  };
  const boundedSecondLocation = {
    ...secondLocationRow,
    mappingId: "",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30"
  };

  assert.deepEqual(
    providerFirstMappingReferenceForRow(boundedSecondLocation, workerWithAnotherActiveLocation),
    registeredLocationMapping
  );
  assert.equal(providerFirstLocationIsAllowed(boundedSecondLocation, workerWithAnotherActiveLocation), true);
  assert.equal(providerFirstLocationRemap(boundedSecondLocation, workerWithAnotherActiveLocation)?.mappingId, "mapping-history");
  const overlappingCurrentMapping = {
    ...boundedSecondLocation,
    effectiveFrom: "2026-10-01",
    effectiveTo: "2026-10-15"
  };
  assert.equal(providerFirstLocationIsAllowed(overlappingCurrentMapping, workerWithAnotherActiveLocation), false);
  assert.equal(providerFirstLocationRemap(overlappingCurrentMapping, workerWithAnotherActiveLocation), null);
  assert.equal(providerFirstLocationIsAllowed(boundedSecondLocation, {
    ...workerWithAnotherActiveLocation,
    registeredLocationMappings: [{ ...registeredLocationMapping, mappedProviderMemberId: "MEMBER-X" }]
  }), false);
});

test("period edits switch the complete mapping state to the exact historical anchor", () => {
  const september = {
    mappingId: "mapping-september",
    stationId: "station-a",
    locationLabel: "KGQC",
    providerId: "provider-1",
    mappedProviderMemberId: "2000074247130",
    paymentMethodId: "method-september",
    paymentValues: { DELIVERY: "16" },
    productionThresholdConfig: { period: "month", component_codes: ["DELIVERY"] },
    productionThresholdMinimumUnits: "900",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30",
    status: "closed"
  };
  const august = {
    ...september,
    mappingId: "mapping-august",
    paymentMethodId: "method-august",
    paymentValues: { DELIVERY: "14" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-08-31"
  };
  const laterCurrentAtDestination = {
    ...baseWorker,
    stationId: "station-b",
    locationLabel: "KGQE",
    mappingId: "mapping-current-october",
    paymentMethodId: "method-current",
    paymentValues: { DELIVERY: "20" },
    effectiveFrom: "2026-10-01",
    effectiveTo: "",
    registeredLocationMappings: [september, august]
  };
  const septemberRow = {
    ...secondLocationRow,
    mappingId: september.mappingId,
    paymentMethodId: september.paymentMethodId,
    paymentValues: september.paymentValues,
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30"
  };
  assert.equal(providerFirstMappingReferenceForRow(septemberRow, laterCurrentAtDestination)?.mappingId, september.mappingId);

  const augustDates = { ...septemberRow, effectiveFrom: "2026-08-01", effectiveTo: "2026-08-31" };
  const switched = providerFirstRowForMappingPeriod(augustDates, laterCurrentAtDestination);
  assert.equal(switched.mappingId, august.mappingId);
  assert.equal(switched.paymentMethodId, august.paymentMethodId);
  assert.deepEqual(switched.paymentValues, august.paymentValues);
  assert.equal(switched.effectiveFrom, "2026-08-01");
  assert.equal(switched.effectiveTo, "2026-08-31");
  assert.equal(providerFirstLocationRemap(switched, laterCurrentAtDestination)?.mappingId, august.mappingId);

  const outsideBoth = { ...switched, effectiveFrom: "2026-07-01", effectiveTo: "2026-07-31" };
  assert.equal(providerFirstMappingReferenceForRow(outsideBoth, laterCurrentAtDestination), undefined);
  const cleared = providerFirstRowForMappingPeriod(outsideBoth, laterCurrentAtDestination);
  assert.equal(cleared.mappingId, "");
  assert.equal(cleared.paymentMethodId, "");
  assert.deepEqual(cleared.paymentValues, {});
  assert.equal(providerFirstLocationIsAllowed(outsideBoth, laterCurrentAtDestination), false);
  assert.equal(providerFirstLocationRemap(outsideBoth, laterCurrentAtDestination), null);

  const unboundManual = {
    ...outsideBoth,
    mappingId: "",
    paymentMethodId: "manual-method",
    paymentValues: { DELIVERY: "22" }
  };
  assert.deepEqual(providerFirstRowForMappingPeriod(unboundManual, laterCurrentAtDestination), unboundManual);
});

test("an active additional-location row keeps its own current mapping state", () => {
  const registeredCurrent = {
    mappingId: "mapping-current-registered",
    stationId: "station-a",
    locationLabel: "KGQC",
    providerId: "provider-1",
    mappedProviderMemberId: "2000074247130",
    paymentMethodId: "method-registered",
    paymentValues: { DELIVERY: "16" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-08-01",
    effectiveTo: "",
    status: "active"
  };
  const additionalCurrent = {
    ...registeredCurrent,
    mappingId: "mapping-current-additional",
    stationId: "station-b",
    locationLabel: "KGQE",
    paymentMethodId: "method-additional",
    paymentValues: { DELIVERY: "19" },
    effectiveFrom: "2026-09-01"
  };
  const workerWithBothCurrentLocations = {
    ...baseWorker,
    mappingId: registeredCurrent.mappingId,
    paymentMethodId: registeredCurrent.paymentMethodId,
    paymentValues: registeredCurrent.paymentValues,
    currentMappings: [registeredCurrent, additionalCurrent],
    registeredLocationMappings: [registeredCurrent]
  };
  const activeAdditionalRow = {
    ...secondLocationRow,
    mappingId: additionalCurrent.mappingId,
    paymentMethodId: additionalCurrent.paymentMethodId,
    paymentValues: additionalCurrent.paymentValues,
    effectiveFrom: "2026-09-10",
    effectiveTo: ""
  };

  assert.equal(providerFirstMappingReferenceForRow(activeAdditionalRow, workerWithBothCurrentLocations)?.mappingId, additionalCurrent.mappingId);
  assert.deepEqual(providerFirstRowForMappingPeriod(activeAdditionalRow, workerWithBothCurrentLocations), activeAdditionalRow);
});

test("mapping conflicts validate both provider and normalized member identity", () => {
  const sameStationRow = {
    ...secondLocationRow,
    stationId: "station-a",
    stationLabel: "KGQC",
    effectiveFrom: "2026-08-10",
    effectiveTo: ""
  };
  const method = { id: "method-1", components: [], productionThresholdConfig: null };
  assert.match(
    providerFirstRowIssue(sameStationRow, { ...baseWorker, providerId: "provider-2" }, method),
    /another Provider/
  );
  assert.match(
    providerFirstRowIssue(sameStationRow, { ...baseWorker, mappedProviderMemberId: "different-member" }, method),
    /another Provider/
  );
  assert.equal(providerFirstLocationIsAllowed(sameStationRow, { ...baseWorker, mappingId: "", providerId: "", mappedProviderMemberId: "" }), true);
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
