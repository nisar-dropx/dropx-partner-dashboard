import assert from "node:assert/strict";
import test from "node:test";
import {
  isRegionalManagerSeat,
  mergeRosterLocationScopeIds,
  shouldResolveRegionalManagerReporteeScope
} from "./roster-manager-scope-logic.ts";

test("detects Regional Manager designation codes and names", () => {
  assert.equal(isRegionalManagerSeat({ designationCode: "RM" }), true);
  assert.equal(isRegionalManagerSeat({ designationCode: "RH" }), true);
  assert.equal(isRegionalManagerSeat({ designationName: "Regional Manager" }), true);
  assert.equal(isRegionalManagerSeat({ designationName: "Regional Head" }), true);
  assert.equal(isRegionalManagerSeat({ roleCodes: ["OPERATIONS_RM"] }), true);
  assert.equal(isRegionalManagerSeat({ roleCodes: ["OPERATIONS_REGIONAL_HEAD"] }), true);
});

test("rejects non-RM seats", () => {
  assert.equal(isRegionalManagerSeat({ designationCode: "CM", designationName: "City Manager" }), false);
  assert.equal(isRegionalManagerSeat({ designationCode: "SM", designationName: "Store Manager" }), false);
  assert.equal(isRegionalManagerSeat({ roleCodes: ["OPERATIONS_LOCATION"] }), false);
  assert.equal(isRegionalManagerSeat({ roleCodes: ["OPERATIONS_CM"] }), false);
  assert.equal(isRegionalManagerSeat({}), false);
});

test("skips People lookup for known non-RM identities", () => {
  assert.equal(shouldResolveRegionalManagerReporteeScope({
    designationName: "City Manager",
    roleCodes: ["OPERATIONS_CM"]
  }), false);
  assert.equal(shouldResolveRegionalManagerReporteeScope({
    designationName: null,
    roleCodes: ["OPERATIONS_LOCATION"]
  }), false);
  assert.equal(shouldResolveRegionalManagerReporteeScope({
    designationName: "Regional Manager",
    roleCodes: ["OPERATIONS_RM"]
  }), true);
  assert.equal(shouldResolveRegionalManagerReporteeScope({
    designationName: null,
    roleCodes: []
  }), true);
});

test("merge keeps membership scopes and inherited reportee stations without duplicates", () => {
  assert.deepEqual(
    mergeRosterLocationScopeIds(["a", "b"], ["b", "c", ""], false).sort(),
    ["a", "b", "c"]
  );
  assert.deepEqual(mergeRosterLocationScopeIds(["a"], ["b"], true), []);
});
