import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ConnectMobileValidationError,
  connectMobileCountryFilter,
  countryCodeOptions,
  normalizeCanonicalConnectMobile,
  normalizeConnectMobile,
  normalizeStoredConnectMobile,
  normalizeSupportedCountryCode
} from "./country-codes.ts";
import {
  connectMobileCountryFilter as rootConnectMobileCountryFilter,
  countryCodeOptions as rootCountryCodeOptions,
  normalizeConnectMobile as normalizeRootConnectMobile,
  normalizeStoredConnectMobile as normalizeRootStoredConnectMobile,
  normalizeSupportedCountryCode as normalizeRootSupportedCountryCode
} from "../../../../src/lib/country-codes.ts";
import { sameConnectAccountIdentitySet } from "../../../../src/lib/connect-account-freshness.ts";

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

test("selected country code and 6-14 digit local subscriber normalize consistently", () => {
  assert.deepEqual(normalizeConnectMobile("9876543210", "91"), {
    countryCode: "91",
    localMobile: "9876543210",
    mobile: "919876543210"
  });
  assert.deepEqual(normalizeConnectMobile("9123 4567", "65"), {
    countryCode: "65",
    localMobile: "91234567",
    mobile: "6591234567"
  });
  assert.deepEqual(normalizeConnectMobile("50-123-4567", "+971"), {
    countryCode: "971",
    localMobile: "501234567",
    mobile: "971501234567"
  });
});

test("explicit and unambiguous canonical E.164 inputs remain accepted", () => {
  assert.deepEqual(normalizeConnectMobile("+65 9123 4567", "65"), {
    countryCode: "65",
    localMobile: "91234567",
    mobile: "6591234567"
  });
  assert.deepEqual(normalizeConnectMobile("9715012345678", "971"), {
    countryCode: "971",
    localMobile: "5012345678",
    mobile: "9715012345678"
  });
  // Without a leading + this can also be a local subscriber beginning in 65,
  // so selected-code + local input wins instead of silently removing digits.
  assert.deepEqual(normalizeConnectMobile("6591234567", "65"), {
    countryCode: "65",
    localMobile: "6591234567",
    mobile: "656591234567"
  });
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

test("invalid mobile shapes and lengths are rejected", () => {
  for (const [mobile, countryCode] of [
    ["12345", "65"],
    ["123456789012345", "65"],
    ["91abc123", "91"],
    ["+971501234567", "65"],
    ["12345678901234", "971"]
  ]) {
    assert.throws(() => normalizeConnectMobile(mobile, countryCode), ConnectMobileValidationError);
  }
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

test("every Connect login endpoint uses the shared input normalizer", async () => {
  const authRoot = resolve(here, "../../app/api/connect/auth");
  const routeNames = ["start", "verify-pin", "set-pin", "send-otp", "verify-otp"];
  for (const routeName of routeNames) {
    const source = await readFile(resolve(authRoot, routeName, "route.ts"), "utf8");
    assert.match(source, /normalizeConnectMobile\(body\.mobile, body\.countryCode\)/, routeName);
    assert.match(source, /ConnectMobileValidationError/, routeName);
    assert.doesNotMatch(source, /\bnormalizeMobile\s*\(/, routeName);
  }

  const sessionSource = await readFile(resolve(authRoot, "session", "route.ts"), "utf8");
  assert.match(sessionSource, /normalizeStoredConnectMobile\([\s\S]*?session\.mobile_number_format/);
  const authSource = await readFile(resolve(here, "connect-auth.ts"), "utf8");
  assert.match(authSource, /from "\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/connect-session-issuance"/);
  assert.match(authSource, /connectMobileCountryFilter\(countryCode\)/);
  assert.match(authSource, /countryCode !== "91"/);
});

test("root and Connect login surfaces enforce the same mobile contract", async () => {
  assert.deepEqual(rootCountryCodeOptions, countryCodeOptions);
  assert.equal(normalizeRootSupportedCountryCode("+65"), "65");
  assert.throws(() => normalizeRootSupportedCountryCode("92"));
  assert.deepEqual(normalizeRootConnectMobile("6591234567", "65"), normalizeConnectMobile("6591234567", "65"));
  assert.deepEqual(
    normalizeRootStoredConnectMobile("6591234567", "65", "canonical"),
    normalizeStoredConnectMobile("6591234567", "65", "canonical")
  );

  const rootAuthRoot = resolve(here, "../../../../src/app/api/connect/auth");
  for (const routeName of ["start", "verify-pin", "set-pin", "send-otp", "verify-otp"]) {
    const source = await readFile(resolve(rootAuthRoot, routeName, "route.ts"), "utf8");
    assert.match(source, /normalizeConnectMobile\(body\.mobile, body\.countryCode\)/, routeName);
    assert.match(source, /ConnectMobileValidationError/, routeName);
    assert.doesNotMatch(source, /\bnormalizeMobile\s*\(/, routeName);
  }

  const rootAuthSource = await readFile(resolve(here, "../../../../src/lib/connect-auth.ts"), "utf8");
  assert.match(rootAuthSource, /from "@\/lib\/country-codes"/);
  assert.match(rootAuthSource, /from "@\/lib\/connect-session-issuance"/);
  assert.match(rootAuthSource, /connectMobileCountryFilter\(countryCode\)/);
  assert.match(rootAuthSource, /countryCode === "91"/);
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

test("root OTP account discovery never treats legacy null country codes as non-India", async () => {
  const rootAuthRoot = resolve(here, "../../../../src/app/api/connect/auth");
  for (const [routeName, expectedAccountQueries] of [["send-otp", 3], ["verify-otp", 2]]) {
    const source = await readFile(resolve(rootAuthRoot, routeName, "route.ts"), "utf8");
    assert.match(source, /connectMobileCountryFilter/);
    assert.match(source, /const mobileCountryFilter = connectMobileCountryFilter\(countryCode\)/);
    assert.equal(
      (source.match(/\.or\(mobileCountryFilter\)/g) ?? []).length,
      expectedAccountQueries,
      `${routeName} must scope every account query by the selected country`
    );
    assert.equal(
      (source.match(/countryCode === "91"/g) ?? []).length,
      expectedAccountQueries,
      `${routeName} must permit each legacy no-country fallback only for India`
    );
    assert.doesNotMatch(
      source,
      /mobile_country_code\.eq\.\$\{countryCode\},mobile_country_code\.is\.null/
    );
  }
});
