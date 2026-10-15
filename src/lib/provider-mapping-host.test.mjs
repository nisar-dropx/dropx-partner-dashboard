import assert from "node:assert/strict";
import test from "node:test";
import {
  isDashboardPaymentSettingsDirectPayEntry,
  providerMappingPageCodeForHost
} from "./provider-mapping-host.ts";

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
