import assert from "node:assert/strict";
import test from "node:test";
import { fleetAdHocRequestType } from "./fleet-control-adhoc-scope.ts";

test("Fleet visibility includes van and explicit driver requests", () => {
  assert.equal(fleetAdHocRequestType({ category: "Van", resourceCategory: "Van" }), "Van");
  assert.equal(fleetAdHocRequestType({ category: "Van" }), "Van");
  assert.equal(fleetAdHocRequestType({ category: "DA", resourceCategory: "Driver" }), "Driver");
});

test("generic ad-hoc DA does not enter Fleet capacity", () => {
  assert.equal(fleetAdHocRequestType({ category: "DA", resourceCategory: "DA" }), null);
  assert.equal(fleetAdHocRequestType({ category: "DA" }), null);
});
