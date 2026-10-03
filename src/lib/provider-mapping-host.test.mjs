import assert from "node:assert/strict";
import test from "node:test";
import { providerMappingPageCodeForHost } from "./provider-mapping-host.ts";

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
