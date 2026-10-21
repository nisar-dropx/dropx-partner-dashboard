import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actions = await readFile(new URL("./actions.ts", import.meta.url), "utf8");
const audit = await readFile(new URL("../../lib/provider-mapping-audit.ts", import.meta.url), "utf8");
const providerPage = await readFile(new URL("../provider-id-mapping/page.tsx", import.meta.url), "utf8");
const paymentHistory = await readFile(new URL("../../lib/payment-allocation-history.ts", import.meta.url), "utf8");

test("exact-period clear requires provider-mapping edit permission and authorized locations", () => {
  assert.match(actions, /export async function clearProviderMappingPeriod/);
  assert.match(actions, /canEditProviderMappings\(authorization\)/);
  assert.match(actions, /\.eq\("company_id", companyId\)[\s\S]*?\.eq\("id", normalizedMappingId\)/);
  assert.match(actions, /allowedLocationIds\.has\(mapping\.station_id\)/);
  assert.match(actions, /allowedLocationIds\.has\(workforce\.location_id\)/);
});

test("exact-period clear targets the submitted mapping UUID and refreshes every consumer", () => {
  assert.match(actions, /rpc\("workforce_clear_mapping_period", \{/);
  assert.match(actions, /p_workforce: mapping\.workforce_id/);
  assert.match(actions, /p_mapping: normalizedMappingId/);
  assert.match(actions, /p_expected_updated_at: expectedUpdatedAt/);
  assert.match(actions, /revalidatePath\("\/provider-id-mapping"\)/);
  assert.match(actions, /revalidatePath\("\/payments\/workforce-payouts"\)/);
});

test("exact-period clear uses the saved row version and names the location-period", () => {
  assert.match(actions, /expectedUpdatedAt = String\(input\?\.expectedUpdatedAt/);
  assert.match(actions, /\.select\("id, workforce_id, provider_member_id, station_id, effective_from, effective_to, status, updated_at"\)/);
  assert.match(actions, /Other locations and periods were not changed\./);
  assert.match(providerPage, /status, reason, updated_at/);
  assert.match(providerPage, /updatedAt: mapping\.updated_at/);
  assert.match(paymentHistory, /updatedAt\?: string/);
});

test("period-clear events have a readable audit label", () => {
  assert.match(audit, /provider_mapping_period_cleared: 'Mapping period cleared'/);
});
