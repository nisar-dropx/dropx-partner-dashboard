import assert from "node:assert/strict";
import { test } from "node:test";
import { canViewDsLivePerformance } from "./ds-live-performance-access.ts";

const auth = (partial) => ({
  isMasterOwner: false,
  roleCode: null,
  roleName: null,
  effectiveRoleCodes: [],
  designationName: null,
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
