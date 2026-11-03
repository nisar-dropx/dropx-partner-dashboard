import assert from "node:assert/strict";
import test from "node:test";

const { canViewEddAgeingPerformance } = await import("./edd-ageing-performance-access.ts");

function auth(overrides = {}) {
  return {
    isMasterOwner: false,
    roleCode: "OPERATIONS_STM",
    roleName: "Station Manager",
    effectiveRoleCodes: [],
    designationName: null,
    ...overrides,
  };
}

test("Ageing/Performance denied for station and cluster ops roles", () => {
  for (const roleCode of ["OPERATIONS_STM", "OPERATIONS_CLM", "OPERATIONS_AOM", "OPERATIONS_BH", "OPERATIONS_NH", "PEOPLE_HRM"]) {
    assert.equal(canViewEddAgeingPerformance(auth({ roleCode })), false, roleCode);
  }
});

test("Ageing/Performance allowed for FSD, Managing Partner, Finance Head", () => {
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "OPERATIONS_FSD" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "FSD" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "OPERATIONS_STM", designationName: "Full Stack Developer" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "OPERATIONS_MANAGING_PARTNER" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "OPERATIONS_MP" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "MANAGING_PARTNER" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "OPERATIONS_FINMGR" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "FINANCE_MANAGER" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "FINANCE_FINMGR" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "OPERATIONS_STM", designationName: "Finance Head" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "OPERATIONS_STM", effectiveRoleCodes: ["OPERATIONS_FSD"] })), true);
});

test("company owners keep Ageing/Performance access", () => {
  assert.equal(canViewEddAgeingPerformance(auth({ isMasterOwner: true, roleCode: "OPERATIONS_STM" })), true);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "OWNER" })), true);
});

test("Finance accounts / generic FIN token alone is not enough", () => {
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "FINANCE_ACCOUNTS" })), false);
  assert.equal(canViewEddAgeingPerformance(auth({ roleCode: "OPERATIONS_ACCOUNTS" })), false);
  assert.equal(canViewEddAgeingPerformance(null), false);
});
