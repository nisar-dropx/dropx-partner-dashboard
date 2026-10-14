import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("./workforce-payout-bulk-hold.tsx", import.meta.url), "utf8");
const table = readFileSync(new URL("./workforce-payout-table.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/payments/workforce-payouts/page.tsx", import.meta.url), "utf8");
const historyButton = readFileSync(new URL("./workforce-payout-payment-history-button.tsx", import.meta.url), "utf8");
const paymentStatusRoute = readFileSync(new URL("../app/api/payments/workforce-payouts/payment-status/route.ts", import.meta.url), "utf8");

test("all-location Workforce rows retain profile-wide deduplicated hold targets", () => {
  assert.match(table, /const targets = new Map<string,/);
  assert.match(table, /if \(!hasAllLocationAccess\) \{[\s\S]*?\}\s*if \(!workforceId && !sourceTargets\.length\) return null;[\s\S]*?workforceId: workforceId \|\| undefined/);
  assert.match(table, /const targetKey = workforceId[\s\S]*?`workforce:\$\{workforceId\}`[\s\S]*?rowSourceTargets/);
  assert.match(table, /targets\.set\(targetKey,/);
  assert.match(table, /const uniqueTargets = \[\.\.\.targets\.values\(\)\]/);
  assert.match(table, /holdItems: uniqueTargets\.filter\(\(target\) => !target\.onHold\)/);
  assert.match(table, /releaseItems: uniqueTargets\.filter\(\(target\) => target\.onHold\)/);
  assert.match(table, /canChangePayoutHold\(row\)/);
  assert.match(table, /processingHoldSubjectIds\.has\(profileWorkforceId\)/);
  assert.match(table, /normalizedPayoutStatus\(row\.paymentSummary\?\.status \?\? row\.status\) === "payment processing"/);
});

test("scoped provider-backed rows use only their visible station source for hold and unhold", () => {
  assert.match(page, /hasAllLocationAccess=\{authorization\.hasAllLocationAccess\}/);
  assert.match(table, /hasAllLocationAccess = false/);
  assert.match(table, /return audience === "workforce" && sourceTargets\.length[\s\S]*?\{ workforceId: undefined, sourceTargets, dropxId: row\.dropxId, name: row\.name \}[\s\S]*?: null/);
  assert.match(table, /const holdTarget = payoutHoldSelectionTarget\(row, audience, hasAllLocationAccess\)/);
  assert.match(table, /if \(!holdTarget\) return;/);
  assert.match(table, /const workforceId = holdTarget\.workforceId \?\? ""/);
  assert.match(table, /const targetKey = workforceId[\s\S]*?: `source:\$\{rowSourceTargets\.map\(workforcePayoutSourceIdentityKey\)\.sort\(\)\.join\("\|"\)\}`/);
  assert.match(table, /const individualHoldTarget = payoutHoldSelectionTarget\(row, audience, hasAllLocationAccess\)/);
  assert.match(table, /Boolean\(individualHoldTarget\)[\s\S]*?canChangePayoutHold\(row\)/);
  assert.match(table, /holdItems=\{isPayoutOnHold\(row\) \|\| !individualHoldTarget \? \[\] : \[individualHoldTarget\]\}/);
  assert.match(component, /audience === "workforce" && \(action === "release_hold" \|\| !item\.workforceId\) \? item\.sourceTargets : \[\]/);
});

test("scoped direct-pay Workforce and Helper rows expose no hold target or control", () => {
  assert.match(table, /const sourceTargets = audience === "workforce" \? workforcePayoutRowSourceIdentities\(row\) : \[\]/);
  assert.match(table, /if \(!hasAllLocationAccess\)[\s\S]*?return audience === "workforce" && sourceTargets\.length[\s\S]*?: null/);
  assert.match(table, /canChangePayoutHold\(row\) && Boolean\(payoutHoldSelectionTarget\(row, audience, hasAllLocationAccess\)\)/);
  assert.match(table, /Boolean\(individualHoldTarget\)/);
  assert.match(table, /audience === "workforce" && \(hasAllLocationAccess \|\| holdSelections\.holdItems\.length > 0 \|\| holdSelections\.releaseItems\.length > 0\) \? <WorkforcePayoutBulkHold/);
});

test("bulk hold and unhold submit one audited Workforce profile selection", () => {
  assert.match(component, /type HoldAction = "hold" \| "release_hold"/);
  assert.match(component, /workforceIds: \[\.\.\.new Set\(items\.flatMap\(\(item\) => item\.workforceId/);
  assert.match(component, /sourceTargets: \[\.\.\.new Map\(items\.flatMap/);
  assert.match(component, /audience === "workforce" && \(action === "release_hold" \|\| !item\.workforceId\) \? item\.sourceTargets : \[\]/);
  assert.match(component, /Hold remarks/);
  assert.match(component, /Unhold remarks/);
  assert.match(component, /same audited remark is recorded for every selected DropX ID/);
  assert.match(component, /balance changes from zero to a positive amount/);
});

test("the shared hold control renders one compact row action without changing bulk actions", () => {
  assert.match(component, /type HoldControlMode = "bulk" \| "single"/);
  assert.match(component, /mode === "single"/);
  assert.match(component, /className="button secondary compact"[\s\S]*?>Unhold<\/button>/);
  assert.match(component, /className="button secondary compact"[\s\S]*?>Hold<\/button>/);
  assert.match(component, /audience\?: "workforce" \| "helpers"/);
  assert.match(component, /audience,\s*operationId/);
});

test("the payment status route uses the atomic Workforce bulk hold RPC and rejects processing profiles", () => {
  assert.match(paymentStatusRoute, /Array\.isArray\(body\.workforceIds\)/);
  assert.match(paymentStatusRoute, /const workforceIds = \[\.\.\.new Set\(submittedWorkforceIds\.filter\(Boolean\)\)\]/);
  assert.match(paymentStatusRoute, /\.eq\("status", "processing"\)/);
  assert.match(paymentStatusRoute, /currently Payment Processing/);
  assert.match(paymentStatusRoute, /rpc\("workforce_set_payout_combined_payment_holds"/);
  assert.match(paymentStatusRoute, /p_workforce_ids: workforceIds/);
  assert.match(paymentStatusRoute, /p_sources: sourceTargets/);
});

test("scoped editors cannot submit profile-wide Workforce or Helper holds", () => {
  assert.match(paymentStatusRoute, /!authorization\.hasAllLocationAccess && workforceIds\.length/);
  assert.match(paymentStatusRoute, /Profile-wide payment holds require all-location access/);
  assert.doesNotMatch(paymentStatusRoute, /async function payoutSubjectsScopeError/);
  assert.ok(
    paymentStatusRoute.indexOf("!authorization.hasAllLocationAccess && workforceIds.length")
      < paymentStatusRoute.indexOf('rpc("workforce_set_payout_combined_payment_holds"'),
    "profile-wide requests must be rejected before any hold RPC"
  );
  assert.match(paymentStatusRoute, /companyStationsScopeError\(\{[\s\S]*?stationIds: sourceTargets\.map\(\(source\) => source\.station_id\)/);
});

test("report-only source rows can be held and mapped source holds can be released", () => {
  assert.match(table, /row\.reviewSubjectId \|\| workforcePayoutRowSourceIdentities\(row\)\.length/);
  assert.match(table, /paymentSourceIdentity\?: WorkforcePayoutSourceIdentity/);
  assert.match(table, /paymentSourceIdentities\?: WorkforcePayoutSourceIdentity\[\]/);
  assert.match(table, /rowSourceTargets\.forEach/);
  assert.match(component, /action === "release_hold" \|\| !item\.workforceId/,
    "mapped holds send their exact source only while releasing; ordinary mapped holds remain profile-only");
  assert.match(paymentStatusRoute, /Select at least one Workforce profile or provider payout source/);
});

test("the UI displays exact On Hold while recognizing the legacy Payment On Hold status", () => {
  assert.match(table, /normalized === "on hold" \|\| normalized === "payment on hold"/);
  assert.match(table, /return isPayoutOnHoldStatus\(status\) \? "On Hold" : status/);
  assert.match(historyButton, /hold\.onHold \? "On Hold"/);
  assert.match(table, /visibleStatus === "payment processing"[\s\S]*?isPayoutOnHoldStatus\(visibleStatus\)/);
});
