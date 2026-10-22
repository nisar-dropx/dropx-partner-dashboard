import assert from "node:assert/strict";
import test from "node:test";
import {
  isDashboardPaymentSettingsDirectPayEntry,
  providerMappingPageCodeForHost
} from "./provider-mapping-host.ts";
import {
  providerFirstLocationIsAllowed,
  providerFirstMappingReferenceForRow,
  providerFirstRowIssue
} from "./provider-first-mapping-view.ts";

test("provider mapping uses isolated Dashboard and Ops permissions", () => {
  assert.equal(providerMappingPageCodeForHost("dashboard.dropxlogistics.com"), "provider_mapping");
  assert.equal(providerMappingPageCodeForHost("dropx-partner-dashboard-abc-dropx1.vercel.app"), "provider_mapping");
  assert.equal(providerMappingPageCodeForHost("ops.dropxlogistics.com"), "ops_provider_mapping");
  assert.equal(providerMappingPageCodeForHost("ops-source-abc.vercel.app"), "ops_provider_mapping");
});

test("provider mapping is denied on every other application surface", () => {
  for (const host of [
    "people.dropxlogistics.com",
    "finance.dropxlogistics.com",
    "admin-panel.dropxlogistics.com",
    "dropx-ops-pulse-abc-dropx1.vercel.app",
    "unknown.dropxlogistics.com",
    "ops-evil.example.com",
    "ops.dropxlogistics.com, dashboard.dropxlogistics.com",
    ""
  ]) {
    assert.equal(providerMappingPageCodeForHost(host), null, host);
  }
});

test("payment settings can open helper direct pay only on Dashboard", () => {
  assert.equal(isDashboardPaymentSettingsDirectPayEntry("provider_mapping", "helpers", "payment-settings"), true);
  assert.equal(isDashboardPaymentSettingsDirectPayEntry("ops_provider_mapping", "helpers", "payment-settings"), false);
  assert.equal(isDashboardPaymentSettingsDirectPayEntry("provider_mapping", "workforce", "payment-settings"), false);
  assert.equal(isDashboardPaymentSettingsDirectPayEntry("provider_mapping", "helpers", null), false);
});

test("Dashboard and Ops apply the same effective-period registered-location proof", () => {
  const method = {
    id: "fixed-per-day",
    components: [{ code: "FIXED_PAY_PER_DAY", label: "Fixed pay per day" }],
    productionThresholdConfig: null
  };
  const registeredMapping = {
    mappingId: "registered-peua",
    stationId: "peua",
    locationLabel: "PEUA - Kuttiady",
    providerId: "amazon",
    mappedProviderMemberId: "2000073910810",
    paymentMethodId: method.id,
    paymentValues: { FIXED_PAY_PER_DAY: "800" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-10-01",
    effectiveTo: "",
    status: "active"
  };
  const worker = {
    id: "peua8099",
    dropxId: "PEUA8099",
    fullName: "VISHNURAJ TP",
    stationId: registeredMapping.stationId,
    providerId: registeredMapping.providerId,
    dateOfJoin: "2026-10-01",
    mappingId: registeredMapping.mappingId,
    paymentMethodId: registeredMapping.paymentMethodId,
    paymentValues: registeredMapping.paymentValues,
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: registeredMapping.effectiveFrom,
    effectiveTo: "",
    mappedProviderMemberId: registeredMapping.mappedProviderMemberId,
    locationLabel: registeredMapping.locationLabel,
    profileStationId: registeredMapping.stationId,
    profileLocationLabel: registeredMapping.locationLabel,
    onboardingStatus: "Active",
    currentMappings: [registeredMapping],
    mappingHistory: [registeredMapping],
    registeredLocationMappings: [registeredMapping]
  };
  const additionalLocationRow = {
    providerMemberId: registeredMapping.mappedProviderMemberId,
    providerMemberName: worker.fullName,
    stationId: "kgqe",
    stationLabel: "KGQE - Nadapuram",
    providerId: registeredMapping.providerId,
    workforceId: worker.id,
    dropxId: worker.dropxId,
    dropxName: worker.fullName,
    mappingId: "",
    paymentMethodId: method.id,
    paymentValues: registeredMapping.paymentValues,
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-10-01",
    effectiveTo: ""
  };

  for (const [host, pageCode] of [
    ["dashboard.dropxlogistics.com", "provider_mapping"],
    ["ops.dropxlogistics.com", "ops_provider_mapping"]
  ]) {
    assert.equal(providerMappingPageCodeForHost(host), pageCode, host);
    assert.equal(providerFirstLocationIsAllowed(additionalLocationRow, worker), true, host);
    assert.equal(providerFirstMappingReferenceForRow(additionalLocationRow, worker)?.mappingId, registeredMapping.mappingId, host);
    assert.equal(providerFirstRowIssue(additionalLocationRow, worker, method), null, host);
  }

  const beforeRegisteredMapping = { ...additionalLocationRow, effectiveFrom: "2026-09-30" };
  assert.equal(providerFirstLocationIsAllowed(beforeRegisteredMapping, worker), false);
  assert.equal(providerFirstRowIssue(beforeRegisteredMapping, worker, method), "Location mismatch.");
});
