import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("mapping locks require same-origin payout edit access and company-wide scope", () => {
  assert.match(source, /sameOrigin\(request\)/);
  assert.match(source, /currentAdminAccessSurface\(\) === "ops" \? "ops_workforce_payouts" : "workforce_payouts"/);
  assert.match(source, /hasPermission\(authorization, pageCode, "edit"\)/);
  assert.match(source, /authorization\.hasAllLocationAccess/);
  assert.match(source, /requireCompanyId\(authorization\)/);
  assert.match(source, /Cache-Control": "private, no-store"/);
});

test("mapping lock request validates month, idempotency key, bounded unique selections and audit text", () => {
  assert.match(source, /completeCalendarMonth\(periodStart, periodEnd\)/);
  assert.match(source, /UUID\.test\(operationId\)/);
  assert.match(source, /MAX_MAPPING_LOCK_SELECTION = 50/);
  assert.match(source, /new Set\(ids\)\.size !== ids\.length/);
  assert.match(source, /explanation\.length < 10 \|\| explanation\.length > 500/);
  assert.match(source, /content-length/);
  assert.match(source, /serializedJsonByteLength\(body\)/);
});

test("unlock delegates exact people and period to the audited database operation", () => {
  assert.match(source, /body\.workforceIds/);
  assert.match(source, /rpc\("workforce_unlock_payout_mappings"/);
  assert.match(source, /p_workforce_ids: workforceIds/);
  assert.match(source, /p_operation_id: operationId/);
  assert.match(source, /p_reason: explanation/);
});

test("relock resolves impacted identities and recalculates one stable current worksheet", () => {
  assert.match(source, /rpc\("workforce_payout_mapping_unlock_impacted_ids"/);
  assert.match(source, /loadStablePayoutWorksheet\(\{/);
  assert.match(source, /workforcePayoutDependencyHash\(companyId, periodStart, periodEnd\)/);
  assert.match(source, /loadWorkforcePayoutRows\([\s\S]*?\{ workforceIds: impactedIds \}/);
  assert.match(source, /!UUID\.test\(stationId\) \|\| !row\.paymentDetailsAvailable/);
  assert.match(source, /itemKeys\.has\(key\)/);
  assert.match(source, /buildWorkforcePayoutPublicationSnapshot/);
  assert.match(source, /workforcePayoutPublicationSnapshotHash\(snapshot\)/);
});

test("relock permits a true zero-row removal, bounds the atomic payload and replays committed operations", () => {
  assert.doesNotMatch(source, /if \(!items\.length\)/);
  assert.match(source, /existingRelock\(operationId\)/);
  assert.match(source, /sameUuidSet\(replay\.data\.unlock_ids \?\? \[\], unlockIds\)/);
  assert.match(source, /replay\.data\.change_summary\.trim\(\) !== explanation/);
  assert.match(source, /serializedJsonByteLength\(relockArguments\) > MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES/);
  assert.match(source, /rpc\("workforce_relock_payout_mappings", relockArguments\)/);
  assert.match(source, /p_expected_dependency_hash: worksheet\.dependencyHash/);
  assert.match(source, /p_items: items/);
});
