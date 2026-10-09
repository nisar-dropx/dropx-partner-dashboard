import assert from "node:assert/strict";
import test from "node:test";

import { assertOnboardingIdentityAllowed, identityExceptionEventMetadata } from "./onboarding-identity.ts";

const exactMatch = {
  normalizedMobile: "9876543210",
  exactMatches: [{
    source_type: "workforce",
    source_id: "existing-workforce-id",
    display_name: "EXISTING WORKER",
    designation_id: "designation-id",
    designation_code: "DA",
    designation_name: "Delivery Associate",
    profile_status: "active"
  }],
  otherMatches: []
};

const otherDesignationMatch = {
  normalizedMobile: "9876543210",
  exactMatches: [],
  otherMatches: [{
    source_type: "employees",
    source_id: "existing-employee-id",
    display_name: "EXISTING EMPLOYEE",
    designation_id: "other-designation-id",
    designation_code: "SSA",
    designation_name: "Station Support Associate",
    profile_status: "active"
  }]
};

test("any People ID can reuse a mobile number from the same designation", () => {
  assert.doesNotThrow(() => assertOnboardingIdentityAllowed(exactMatch));
});

test("any People ID can reuse a mobile number from another designation", () => {
  assert.doesNotThrow(() => assertOnboardingIdentityAllowed(otherDesignationMatch));
});

test("shared mobile numbers do not create lifecycle exception metadata", () => {
  assert.deepEqual(identityExceptionEventMetadata(otherDesignationMatch), {});
});
