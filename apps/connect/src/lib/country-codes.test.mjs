import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ConnectMobileValidationError,
  connectMobileCountryFilter,
  countryCodeOptions,
  emergencyContactMatchesMobile,
  MOBILE_EMERGENCY_CONTACT_CONFLICT_ERROR,
  normalizeCanonicalConnectMobile,
  normalizeConnectMobile,
  normalizeProfileEditMobile,
  normalizeStoredConnectMobile,
  normalizeSupportedCountryCode
} from "./country-codes.ts";
import {
  connectMobileCountryFilter as rootConnectMobileCountryFilter,
  countryCodeOptions as rootCountryCodeOptions,
  emergencyContactMatchesMobile as rootEmergencyContactMatchesMobile,
  MOBILE_EMERGENCY_CONTACT_CONFLICT_ERROR as ROOT_MOBILE_EMERGENCY_CONTACT_CONFLICT_ERROR,
  normalizeConnectMobile as normalizeRootConnectMobile,
  normalizeProfileEditMobile as normalizeRootProfileEditMobile,
  normalizeStoredConnectMobile as normalizeRootStoredConnectMobile,
  normalizeSupportedCountryCode as normalizeRootSupportedCountryCode
} from "../../../../src/lib/country-codes.ts";
import {
  eligibleConnectWorkforceAccount,
  sameConnectAccountIdentitySet
} from "../../../../src/lib/connect-account-freshness.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("country codes come from one exact supported allowlist", () => {
  assert.deepEqual(
    countryCodeOptions.map((option) => option.code),
    ["91", "971", "966", "974", "965", "968", "973", "1", "44", "61", "65", "60"]
  );
  assert.equal(normalizeSupportedCountryCode("+65"), "65");
  assert.equal(normalizeSupportedCountryCode("971"), "971");
  assert.throws(() => normalizeSupportedCountryCode("92"), ConnectMobileValidationError);
  assert.throws(() => normalizeSupportedCountryCode("abc91"), ConnectMobileValidationError);
});
test("country lookup treats legacy null country codes as India only", () => {
  assert.equal(connectMobileCountryFilter("91"), "mobile_country_code.eq.91,mobile_country_code.is.null");
  assert.equal(connectMobileCountryFilter("65"), "mobile_country_code.eq.65");
  assert.equal(rootConnectMobileCountryFilter("91"), connectMobileCountryFilter("91"));
  assert.equal(rootConnectMobileCountryFilter("65"), connectMobileCountryFilter("65"));
});

test("Connect login keeps its legacy mobile normalization contract", () => {
  assert.deepEqual(normalizeConnectMobile("9876543210", "91"), {
    countryCode: "91",
    localMobile: "9876543210",
    mobile: "919876543210"
  });
  assert.deepEqual(normalizeConnectMobile("9123 4567", "65"), {
    countryCode: "65",
    localMobile: "91234567",
    mobile: "91234567"
  });
  assert.deepEqual(normalizeConnectMobile("50-123-4567", "+971"), {
    countryCode: "971",
    localMobile: "501234567",
    mobile: "501234567"
  });
  assert.deepEqual(normalizeConnectMobile("919876543210", "91"), {
    countryCode: "91",
    localMobile: "9876543210",
    mobile: "919876543210"
  });
});

test("self-service profile edit uses strict country-aware mobile validation", () => {
  assert.deepEqual(normalizeProfileEditMobile("9123 4567", "65"), {
    countryCode: "65",
    localMobile: "91234567",
    mobile: "6591234567"
  });
  assert.deepEqual(normalizeProfileEditMobile("+65 9123 4567", "65"), {
    countryCode: "65",
    localMobile: "91234567",
    mobile: "6591234567"
  });
  for (const [mobile, countryCode] of [
    ["12345", "65"],
    ["123456789012345", "65"],
    ["91abc123", "91"],
    ["+971501234567", "65"],
    ["12345678901234", "971"]
  ]) {
    assert.throws(() => normalizeProfileEditMobile(mobile, countryCode), ConnectMobileValidationError);
  }
});

test("trusted stored sessions accept canonical and legacy local mobile values", () => {
  assert.deepEqual(normalizeCanonicalConnectMobile("6591234567", "65"), {
    countryCode: "65",
    localMobile: "91234567",
    mobile: "6591234567"
  });
  assert.deepEqual(normalizeCanonicalConnectMobile("91234567", "65"), {
    countryCode: "65",
    localMobile: "91234567",
    mobile: "6591234567"
  });
  assert.deepEqual(normalizeStoredConnectMobile("65912345", "65", "legacy"), {
    countryCode: "65",
    localMobile: "65912345",
    mobile: "6565912345"
  });
  assert.deepEqual(normalizeStoredConnectMobile("6591234567", "65", "canonical"), {
    countryCode: "65",
    localMobile: "91234567",
    mobile: "6591234567"
  });
});

test("same-profile mobile and emergency contact comparison accepts local or canonical digits", () => {
  const indiaMobile = normalizeProfileEditMobile("9876543210", "91");
  assert.equal(emergencyContactMatchesMobile(indiaMobile, "98765 43210"), true);
  assert.equal(emergencyContactMatchesMobile(indiaMobile, "+91 98765 43210"), true);
  assert.equal(emergencyContactMatchesMobile(indiaMobile, "9876543211"), false);
  assert.equal(emergencyContactMatchesMobile(indiaMobile, ""), false);
  assert.equal(
    MOBILE_EMERGENCY_CONTACT_CONFLICT_ERROR,
    "Mobile number and Emergency contact number cannot be same"
  );
  assert.equal(
    ROOT_MOBILE_EMERGENCY_CONTACT_CONFLICT_ERROR,
    MOBILE_EMERGENCY_CONTACT_CONFLICT_ERROR
  );
  assert.equal(rootEmergencyContactMatchesMobile(indiaMobile, "919876543210"), true);
});

test("Connect account freshness compares identity sets, not presentation fields or order", () => {
  const first = [
    { id: "worker-a", companyId: "company-a", profileType: "workforce", name: "Before" },
    { id: "user-a", companyId: "company-a", profileType: "user", name: "Manager" }
  ];
  const reorderedAndRenamed = [
    { id: "user-a", companyId: "company-a", profileType: "user", name: "Manager renamed" },
    { id: "worker-a", companyId: "company-a", profileType: "workforce", name: "After" }
  ];

  assert.equal(sameConnectAccountIdentitySet(first, reorderedAndRenamed), true);
  assert.equal(sameConnectAccountIdentitySet(first, reorderedAndRenamed.slice(0, 1)), false);
  assert.equal(sameConnectAccountIdentitySet(first, [
    reorderedAndRenamed[0],
    { ...reorderedAndRenamed[1], companyId: "company-b" }
  ]), false);
  assert.equal(sameConnectAccountIdentitySet(first, [
    reorderedAndRenamed[0],
    { ...reorderedAndRenamed[1], profileType: "employee" }
  ]), false);
});

test("Connect Workforce account eligibility preserves onboarding without reopening inactive identities", () => {
  assert.equal(eligibleConnectWorkforceAccount({
    onboarding_status: "active",
    lifecycle_status: "active",
    is_active: true
  }), true);
  assert.equal(eligibleConnectWorkforceAccount({
    onboarding_status: "active",
    lifecycle_status: "onboarding",
    is_active: true
  }), true);
  assert.equal(eligibleConnectWorkforceAccount({
    onboarding_status: "active",
    lifecycle_status: "settlement_pending",
    is_active: true
  }), true);

  for (const onboarding_status of ["pending", "under_review", "returned", "approved"]) {
    assert.equal(eligibleConnectWorkforceAccount({
      onboarding_status,
      lifecycle_status: "onboarding",
      is_active: false
    }), true, onboarding_status);
  }

  for (const row of [
    { onboarding_status: "active", lifecycle_status: "active", is_active: false },
    { onboarding_status: "active", lifecycle_status: "inactive", is_active: false },
    { onboarding_status: "active", lifecycle_status: "active", is_active: true, deleted_at: "2026-10-01" },
    { onboarding_status: "active", lifecycle_status: "active", is_active: true, deactivated_at: "2026-10-01" },
    { onboarding_status: "rejected", lifecycle_status: "onboarding", is_active: false },
    { onboarding_status: "cancelled", lifecycle_status: "onboarding", is_active: false }
  ]) {
    assert.equal(eligibleConnectWorkforceAccount(row), false, JSON.stringify(row));
  }

  for (const lifecycle_status of [
    "closed",
    "deactivated",
    "exited",
    "inactive",
    "offboarded",
    "resigned",
    "settled",
    "suspended",
    "terminated"
  ]) {
    assert.equal(eligibleConnectWorkforceAccount({
      onboarding_status: "active",
      lifecycle_status,
      is_active: true
    }), false, lifecycle_status);
  }
});

test("every Connect login endpoint preserves the shared legacy input contract", async () => {
  const authRoot = resolve(here, "../../app/api/connect/auth");
  const routeNames = ["start", "verify-pin", "set-pin", "send-otp", "verify-otp"];
  for (const routeName of routeNames) {
    const source = await readFile(resolve(authRoot, routeName, "route.ts"), "utf8");
    assert.match(source, /normalizeConnectMobile\(body\.mobile, body\.countryCode\)/, routeName);
    assert.doesNotMatch(source, /\bnormalizeMobile\s*\(/, routeName);
    assert.match(source, /Enter a valid mobile number\./, routeName);
  }

  const sessionSource = await readFile(resolve(authRoot, "session", "route.ts"), "utf8");
  assert.match(sessionSource, /findConnectSessionAccounts\(session\.country_code, session\.mobile_number\)/);
  assert.doesNotMatch(sessionSource, /mobile_number_format|normalizeStoredConnectMobile/);
  const authSource = await readFile(resolve(here, "connect-auth.ts"), "utf8");
  assert.match(authSource, /from "\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/connect-session-issuance"/);
  assert.match(authSource, /eligibleConnectWorkforceAccount/);
  assert.match(authSource, /deleted_at,deactivated_at/);
  assert.match(authSource, /mobile_country_code\.eq\.\$\{countryCode\},mobile_country_code\.is\.null/);
  assert.doesNotMatch(authSource, /connectMobileCountryFilter\(countryCode\)|countryCode !== "91"/);
});

test("root and Connect login surfaces enforce the same mobile contract", async () => {
  assert.deepEqual(rootCountryCodeOptions, countryCodeOptions);
  assert.equal(normalizeRootSupportedCountryCode("+65"), "65");
  assert.throws(() => normalizeRootSupportedCountryCode("92"));
  assert.deepEqual(normalizeRootConnectMobile("6591234567", "65"), normalizeConnectMobile("6591234567", "65"));
  assert.deepEqual(normalizeRootProfileEditMobile("91234567", "65"), normalizeProfileEditMobile("91234567", "65"));
  assert.deepEqual(
    normalizeRootStoredConnectMobile("6591234567", "65", "canonical"),
    normalizeStoredConnectMobile("6591234567", "65", "canonical")
  );

  const rootAuthRoot = resolve(here, "../../../../src/app/api/connect/auth");
  for (const routeName of ["start", "verify-pin", "set-pin", "send-otp", "verify-otp"]) {
    const source = await readFile(resolve(rootAuthRoot, routeName, "route.ts"), "utf8");
    assert.match(source, /normalizeConnectMobile\(body\.mobile, body\.countryCode\)/, routeName);
    assert.doesNotMatch(source, /\bnormalizeMobile\s*\(/, routeName);
    assert.match(source, /Enter a valid mobile number\./, routeName);
  }

  const rootAuthSource = await readFile(resolve(here, "../../../../src/lib/connect-auth.ts"), "utf8");
  assert.match(rootAuthSource, /from "@\/lib\/country-codes"/);
  assert.match(rootAuthSource, /from "@\/lib\/connect-session-issuance"/);
  assert.match(rootAuthSource, /eligibleConnectWorkforceAccount/);
  assert.match(rootAuthSource, /deleted_at, deactivated_at/);
  assert.match(rootAuthSource, /mobile_country_code\.eq\.\$\{countryCode\},mobile_country_code\.is\.null/);
  assert.doesNotMatch(rootAuthSource, /connectMobileCountryFilter\(countryCode\)|countryCode === "91"/);
});

test("credential routes revalidate account identity before activating a session", async () => {
  const routeGroups = [
    {
      authRoot: resolve(here, "../../app/api/connect/auth"),
      expectedLookups: 3,
      deviceBound: true
    },
    {
      authRoot: resolve(here, "../../../../src/app/api/connect/auth"),
      expectedLookups: 2,
      deviceBound: false
    }
  ];

  for (const { authRoot, expectedLookups, deviceBound } of routeGroups) {
    for (const routeName of ["verify-pin", "set-pin"]) {
      const source = await readFile(resolve(authRoot, routeName, "route.ts"), "utf8");
      assert.equal(
        (source.match(/findConnectAccounts\(countryCode, mobile/g) ?? []).length,
        expectedLookups,
        `${routeName} must re-read the account identity set`
      );
      assert.equal(
        (source.match(/findConnectAccounts\(countryCode, mobile, \{ fresh: true \}\)/g) ?? []).length,
        expectedLookups - 1,
        `${routeName} freshness reads must bypass the short-lived shared lookup`
      );
      assert.match(source, /sameConnectAccountIdentitySet\(accounts, freshAccounts\)/);
      assert.match(source, /ConnectCredentialError\("Authentication state changed\. Please try again\.", 409\)/);
      assert.match(source, /revokeIssuedConnectSession\(session\)/);
      assert.match(source, /activateConnectSession\(session\);[\s\S]*?accounts: freshAccounts/);
      if (deviceBound) {
        assert.match(source, /bindDevice\(\{ accounts: freshAccounts, countryCode, mobile, request \}\)/);
        assert.match(source, /sameConnectAccountIdentitySet\(freshAccounts, postBindAccounts\)/);
        assert.match(source, /rollbackCreatedDeviceBindings\(bindingMutation\)/);
      }
    }
  }

  const deviceBindingSource = await readFile(resolve(here, "connect-device-binding.ts"), "utf8");
  assert.match(deviceBindingSource, /\.insert\([\s\S]*?\.select\("id"\)/);
  assert.match(deviceBindingSource, /\.delete\(\)[\s\S]*?\.in\("id", mutation\.createdBindingIds\)/);
});

test("root OTP account discovery preserves legacy null-country matching", async () => {
  const rootAuthRoot = resolve(here, "../../../../src/app/api/connect/auth");
  for (const [routeName, expectedAccountQueries] of [["send-otp", 3], ["verify-otp", 2]]) {
    const source = await readFile(resolve(rootAuthRoot, routeName, "route.ts"), "utf8");
    assert.doesNotMatch(source, /connectMobileCountryFilter/);
    assert.equal(
      (source.match(/mobile_country_code\.eq\.\$\{countryCode\},mobile_country_code\.is\.null/g) ?? []).length,
      expectedAccountQueries,
      `${routeName} must preserve every existing account query`
    );
    assert.doesNotMatch(source, /countryCode === "91"/);
  }
});
