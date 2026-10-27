import assert from "node:assert/strict";
import test from "node:test";
import { advanceEligibilityAmount, isAdvanceEligible, validAdvanceApprovalAmount } from "./advance-eligibility.ts";

test("current active People assignment is eligible even when legacy completion status is stale", () => {
  assert.equal(isAdvanceEligible({ currentPeopleAssignment: true, profileActive: true, profileStatus: "submitted" }), true);
});

test("legacy active records remain eligible while People migration is incomplete", () => {
  assert.equal(isAdvanceEligible({ currentPeopleAssignment: false, profileActive: true, profileStatus: " Active " }), true);
});

test("inactive profiles cannot request advances", () => {
  assert.equal(isAdvanceEligible({ currentPeopleAssignment: true, profileActive: false, profileStatus: "active" }), false);
});

test("advance capacity is 25% of outstanding pay less an already committed advance", () => {
  assert.equal(advanceEligibilityAmount(40000), 10000);
  assert.equal(advanceEligibilityAmount(40000, 2500), 7500);
  assert.equal(advanceEligibilityAmount(-100), 0);
});

test("reviewers can adjust an advance only within the snapshotted cap", () => {
  assert.equal(validAdvanceApprovalAmount(5000, 7500), true);
  assert.equal(validAdvanceApprovalAmount(7500.01, 7500), false);
  assert.equal(validAdvanceApprovalAmount(0, 7500), false);
});
