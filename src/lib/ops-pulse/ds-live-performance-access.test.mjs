import assert from "node:assert/strict";
import { test } from "node:test";
import { canViewDsLivePerformance, canViewDsOperations } from "./ds-live-performance-access.ts";

const auth = (partial) => ({
  isMasterOwner: false,
  roleCode: null,
  roleName: null,
  effectiveRoleCodes: [],
  designationName: null,
  permissions: {},
  ...partial
});

test("DS Live denied for Review Desk / station roles", () => {
  assert.equal(canViewDsLivePerformance(auth({ roleCode: "OPERATIONS_STM" })), false);
  assert.equal(canViewDsLivePerformance(auth({ roleCode: "OPERATIONS_CM" })), false);
  assert.equal(canViewDsLivePerformance(auth({ roleCode: "OPERATIONS_MANAGING_PARTNER" })), false);
  assert.equal(canViewDsLivePerformance(auth({ roleCode: "TECH" })), false);
  assert.equal(canViewDsLivePerformance(auth({ designationName: "Station Admin" })), false);
  assert.equal(canViewDsLivePerformance(null), false);
});

test("DS Live allowed for FSD and Admin", () => {
  assert.equal(canViewDsLivePerformance(auth({ roleCode: "OPERATIONS_FSD" })), true);
  assert.equal(canViewDsLivePerformance(auth({ roleCode: "FSD" })), true);
  assert.equal(canViewDsLivePerformance(auth({ designationName: "Full Stack Developer" })), true);
  assert.equal(canViewDsLivePerformance(auth({ roleCode: "ADMIN" })), true);
  assert.equal(canViewDsLivePerformance(auth({ roleCode: "OPERATIONS_ADMIN" })), true);
  assert.equal(canViewDsLivePerformance(auth({ isMasterOwner: true })), true);
  assert.equal(canViewDsLivePerformance(auth({ roleCode: "OWNER" })), true);
});

test("Settings page grant unlocks Operations pages without FSD role", () => {
  const granted = auth({
    roleCode: "OPERATIONS_STM",
    permissions: { ds_ppi: { canView: true } }
  });
  assert.equal(canViewDsOperations(granted, "ds_ppi"), true);
  assert.equal(canViewDsOperations(granted, "ds_live_performance"), false);
  assert.equal(canViewDsOperations(granted, "ds_site_summary"), false);
});
