import assert from "node:assert/strict";
import test from "node:test";

import { assertOnboardingIdentityAllowed } from "./onboarding-identity.ts";

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

test("Workforce can reuse a mobile number from the same designation", () => {
  assert.doesNotThrow(() => assertOnboardingIdentityAllowed(exactMatch, {
    allowDuplicateMobile: true,
    allowDifferentWorkforceDesignation: true
  }));
});

test("Workforce can reuse a mobile number from another designation", () => {
  assert.doesNotThrow(() => assertOnboardingIdentityAllowed(otherDesignationMatch, {
    allowDuplicateMobile: true,
    allowDifferentWorkforceDesignation: true
  }));
});

test("other registers retain duplicate-mobile protection", () => {
  assert.throws(() => assertOnboardingIdentityAllowed(exactMatch), /already registered/i);
  assert.throws(() => assertOnboardingIdentityAllowed(otherDesignationMatch), /already belongs/i);
});

test("the existing different-Workforce-designation exception remains available", () => {
  assert.doesNotThrow(() => assertOnboardingIdentityAllowed(otherDesignationMatch, {
    allowDifferentWorkforceDesignation: true
  }));
});
