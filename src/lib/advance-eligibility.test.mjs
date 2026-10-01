import assert from "node:assert/strict";
import test from "node:test";
import { isAdvanceEligible } from "./advance-eligibility.ts";

test("current active People assignment is eligible even when legacy completion status is stale", () => {
  assert.equal(isAdvanceEligible({ currentPeopleAssignment: true, profileActive: true, profileStatus: "submitted" }), true);
});

test("legacy active records remain eligible while People migration is incomplete", () => {
  assert.equal(isAdvanceEligible({ currentPeopleAssignment: false, profileActive: true, profileStatus: " Active " }), true);
});

test("inactive profiles cannot request advances", () => {
  assert.equal(isAdvanceEligible({ currentPeopleAssignment: true, profileActive: false, profileStatus: "active" }), false);
});
