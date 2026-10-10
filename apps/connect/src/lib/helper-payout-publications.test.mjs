import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const loader = readFileSync(new URL("./associate-payouts.ts", import.meta.url), "utf8");
const reviewRoute = readFileSync(new URL("../../app/api/connect/payout-review/route.ts", import.meta.url), "utf8");

test("DropX One resolves worker accounts directly to active Helpers", () => {
  assert.match(loader, /if \(account\.profileType === "worker"\)[\s\S]*?from\("helpers"\)/);
  assert.match(loader, /\.eq\("id", account\.id\)[\s\S]*?\.eq\("is_active", true\)[\s\S]*?\.eq\("onboarding_status", "active"\)/);
  assert.match(loader, /subjectType: "helper" as const/);
});

test("DropX One reads only the Helper's immutable publication ledger", () => {
  assert.match(loader, /function loadHelperAssociatePayouts/);
  assert.match(loader, /from\("helper_payout_publications"\)[\s\S]*?\.eq\("company_id", company\)[\s\S]*?\.eq\("helper_id", helper\)/);
  assert.match(loader, /snapshot\.source !== "helper_payout_worksheet"/);
  assert.match(loader, /latestKeys\.has\(key\)/);
  assert.match(loader, /payoutSlipAvailable: false/);
  assert.match(loader, /disputes: \[\]/);
});

test("payout review passes the verified subject type and blocks unsupported Helper disputes", () => {
  assert.match(reviewRoute, /loadAssociatePayouts\(company,worker,subjectType\)/);
  assert.match(reviewRoute, /if\(subjectType==='helper'\)throw new Error\('Helper payout disputes are not available/);
});
