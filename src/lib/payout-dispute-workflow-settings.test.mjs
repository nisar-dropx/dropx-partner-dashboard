import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeWorkflowRoleIds,
  validateWorkflowSelection
} from "./payout-dispute-workflow-settings.ts";

test("workflow role candidates preserve precedence and remove blanks and duplicates", () => {
  assert.deepEqual(normalizeWorkflowRoleIds(["role-a", "", "role-b", "role-a", null]), ["role-a", "role-b"]);
});

test("every dispute workflow stage requires a role", () => {
  assert.match(validateWorkflowSelection({ initial: ["a"], final: [], processor: ["c"] }) ?? "", /Final approval requires/);
});

test("approval and processing stages must be disjoint", () => {
  assert.match(validateWorkflowSelection({ initial: ["a"], final: ["b"], processor: ["a"] }) ?? "", /same role cannot be used/i);
  assert.equal(validateWorkflowSelection({ initial: ["a"], final: ["b"], processor: ["c"] }), null);
});

test("workflow setup is protected by Payment Settings and saves through the versioned database function", () => {
  const page = readFileSync(new URL("../app/settings/payout-disputes/page.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../app/settings/payout-disputes/actions.ts", import.meta.url), "utf8");
  assert.match(page, /requirePagePermission\("payment_settings", "access"\)/);
  assert.match(actions, /requirePagePermissionOrThrow\("payment_settings", "edit"\)/);
  assert.match(actions, /rpc\("workforce_upsert_dispute_workflow"/);
  assert.match(actions, /p_expected_version: expectedVersion/);
  assert.match(actions, /"workforce_payout_disputes", true/);
  assert.match(actions, /"ops_workforce_payout_disputes", true/);
  assert.match(actions, /"workforce_payouts", true/);
  assert.match(actions, /"ops_workforce_payouts", true/);
  assert.match(actions, /dashboardDisputeEditors\.has\(roleId\) && dashboardPayoutEditors\.has\(roleId\)/);
  assert.match(actions, /opsDisputeEditors\.has\(roleId\) && opsPayoutEditors\.has\(roleId\)/);
  assert.match(page, /\.eq\("product_code", "operations"\)/);
  assert.match(page, /const operationsMemberIds = new Set/);
  assert.match(page, /const dashboardAccessByProfile = new Map/);
  assert.match(page, /access\.roleIds\.add\(position\.role_id\)/);
  assert.match(page, /for \(const locationId of position\.location_scope_ids/);
  assert.match(page, /dashboardScope: CandidateScope \| null/);
  assert.match(page, /opsScope: CandidateScope \| null/);
  assert.match(page, /dashboardDisputeEditors\.has\(roleId\).*dashboardPayoutEditors\.has\(roleId\)/s);
  assert.match(page, /opsDisputeEditors\.has\(roleId\).*opsPayoutEditors\.has\(roleId\)/s);
});

test("Dashboard and Ops navigation expose the shared workflow setup", () => {
  const page = readFileSync(new URL("../app/settings/payout-disputes/page.tsx", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("app-navigation.ts", import.meta.url), "utf8");
  const accessSurface = readFileSync(new URL("access-surface.ts", import.meta.url), "utf8");
  const ops = readFileSync(new URL("ops-pulse/navigation.ts", import.meta.url), "utf8");
  const middleware = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
  for (const source of [dashboard, ops]) {
    assert.match(source, /Payout Dispute Workflow/);
    assert.match(source, /\/settings\/payout-disputes/);
  }
  assert.match(middleware, /path !== "\/settings\/payout-disputes"/);
  assert.match(page, /Back to OpsPulse/);
  assert.match(accessSurface, /opsAccessPageCodes[\s\S]*?"payment_settings"/);
  assert.match(accessSurface, /sharedPageCodes[\s\S]*?"payment_settings"/);
});

