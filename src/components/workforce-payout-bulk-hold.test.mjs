import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("./workforce-payout-bulk-hold.tsx", import.meta.url), "utf8");
const table = readFileSync(new URL("./workforce-payout-table.tsx", import.meta.url), "utf8");
const historyButton = readFileSync(new URL("./workforce-payout-payment-history-button.tsx", import.meta.url), "utf8");
const paymentStatusRoute = readFileSync(new URL("../app/api/payments/workforce-payouts/payment-status/route.ts", import.meta.url), "utf8");

test("selected multi-location Workforce rows are deduplicated into profile hold targets", () => {
  assert.match(table, /const targets = new Map<string,/);
  assert.match(table, /const targetKey = workforceId[\s\S]*?`workforce:\$\{workforceId\}`[\s\S]*?rowSourceTargets/);
  assert.match(table, /targets\.set\(targetKey,/);
  assert.match(table, /const uniqueTargets = \[\.\.\.targets\.values\(\)\]/);
  assert.match(table, /holdItems: uniqueTargets\.filter\(\(target\) => !target\.onHold\)/);
  assert.match(table, /releaseItems: uniqueTargets\.filter\(\(target\) => target\.onHold\)/);
  assert.match(table, /canChangePayoutHold\(row\)/);
  assert.match(table, /processingHoldSubjectIds\.has\(workforceId\)/);
  assert.match(table, /normalizedPayoutStatus\(row\.paymentSummary\?\.status \?\? row\.status\) === "payment processing"/);
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
