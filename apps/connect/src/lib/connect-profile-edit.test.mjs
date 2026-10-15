import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  canonicalProfileEditType,
  changedProfileEditPayload,
  createProfileEditOtpHmac,
  maskProfileEditMobile,
  normalizeProfileEditPayload,
  profileEditLocalMobile,
  profileEditMobileHash,
  profileEditVerificationKeys,
  verifyProfileEditOtpHmac
} from "./connect-profile-edit.ts";

test("profile edit accepts only supported account types and mutable camelCase fields", () => {
  assert.equal(canonicalProfileEditType("field_executive"), "workforce");
  assert.equal(canonicalProfileEditType("employee"), "employee");
  assert.equal(canonicalProfileEditType("worker"), null);
  assert.equal(canonicalProfileEditType("user"), null);

  assert.deepEqual(normalizeProfileEditPayload({
    dateOfBirth: "03/04/1990",
    panNumber: "abcde1234f",
    isHandicapped: "false",
    vehicleRegistrationNo: "kl01ab1234",
    pollutionExpiry: ""
  }, "employee"), {
    date_of_birth: "1990-04-03",
    pan_number: "ABCDE1234F",
    is_handicapped: false,
    vehicle_reg_no: "KL01AB1234",
    vehicle_pollution_exp_date: null
  });

  assert.throws(
    () => normalizeProfileEditPayload({ fullName: "Changed" }, "employee"),
    /cannot be edited: fullName/
  );
  assert.throws(
    () => normalizeProfileEditPayload({ state: "Kerala" }, "workforce"),
    /State name cannot be edited/
  );
});

test("changed payload excludes semantically unchanged values and preserves explicit clears", () => {
  assert.deepEqual(changedProfileEditPayload({
    pan_number: "ABCDE1234F",
    address: null,
    is_handicapped: false
  }, {
    pan_number: "ABCDE1234F",
    address: "Old address",
    is_handicapped: false
  }), { address: null });
});

test("OTP and mobile hashes are secret, request, and leg bound", () => {
  const secret = "a".repeat(64);
  const expected = createProfileEditOtpHmac({ requestId: "request-a", leg: "current", otp: "123456", secret });
  assert.equal(verifyProfileEditOtpHmac({
    requestId: "request-a", leg: "current", otp: "123456", secret, expected
  }), true);
  assert.equal(verifyProfileEditOtpHmac({
    requestId: "request-a", leg: "new", otp: "123456", secret, expected
  }), false);
  assert.notEqual(profileEditMobileHash("+91 99999 99999", secret), profileEditMobileHash("+91 88888 88888", secret));
  assert.equal(maskProfileEditMobile("919999999999").endsWith("9999"), true);
});

test("serializer returns a local mobile only when the country prefix is unambiguous", () => {
  assert.equal(profileEditLocalMobile("919876543210", "91"), "9876543210");
  assert.equal(profileEditLocalMobile("+44 7700 900123", "44"), "7700900123");
  assert.equal(profileEditLocalMobile("91234567890", "91"), "91234567890");
  assert.equal(profileEditLocalMobile("9876543210", "91"), "9876543210");
  assert.equal(profileEditLocalMobile("6591234567", "65", "6591234567"), "91234567");
  assert.equal(profileEditLocalMobile("91234567", "65", "6591234567"), "91234567");
});

test("verification keys bind provider checks to the final normalized identity values", () => {
  assert.deepEqual(profileEditVerificationKeys({
    pan_number: "abcde1234f",
    aadhaar_number: "123412341234",
    bank_account_no: "12345",
    ifsc: "abcd0123456",
    pf_uan: "100000000001",
    driving_license_no: "kl0120201234",
    date_of_birth: "1990-04-03",
    vehicle_reg_no: "kl01ab1234"
  }), {
    pan: "ABCDE1234F",
    pan_aadhaar: "ABCDE1234F|123412341234",
    bank: "12345|ABCD0123456",
    pf_uan: "100000000001",
    dl: "KL0120201234|03/04/1990",
    vehicle: "KL01AB1234"
  });
});

test("atomic migration preserves the critical session, staging, CAS, and redaction invariants", () => {
  const sql = fs.readFileSync(new URL("../../../../supabase/migrations/20261015220000_connect_profile_edit_otp.sql", import.meta.url), "utf8");
  assert.match(sql, /source_updated_at timestamptz not null/);
  assert.match(sql, /profile_before->>'updated_at'[\s\S]*?edit_request\.source_updated_at/);
  assert.match(sql, /from public\.connect_profile_edit_verifications verification[\s\S]*?verification\.request_id = edit_request\.id/);
  assert.match(sql, /profile_updated_at timestamptz not null/);
  assert.match(sql, /identity_name_hash text not null/);
  assert.match(sql, /expected_identity_name_hash := encode\(digest\([\s\S]*?profile_before->>'full_name'/);
  assert.equal(
    (sql.match(/set search_path = extensions, public, pg_temp/g) ?? []).length,
    5,
    "every security-definer function must resolve pgcrypto from the trusted extensions schema"
  );
  assert.match(sql, /final_pan := nullif\(upper\(btrim\(case[\s\S]*?profile_before->>'pan_number'[\s\S]*?\)\), ''\);/);
  assert.match(sql, /final_aadhaar := nullif\(btrim\(case[\s\S]*?profile_before->>'aadhaar_number'[\s\S]*?\), ''\);/);
  assert.match(sql, /final_dob := nullif\(btrim\(case[\s\S]*?profile_before->>'date_of_birth'[\s\S]*?\), ''\);/);
  assert.match(sql, /final_vehicle := nullif\(upper\(btrim\(case[\s\S]*?profile_before->>'vehicle_reg_no'[\s\S]*?\)\), ''\);/);
  assert.equal((sql.match(/verification\.identity_name_hash = expected_identity_name_hash/g) ?? []).length, 8);
  assert.match(sql, /verification\.kind = 'pan'[\s\S]*?edit_request\.payload \? 'pan_number'/);
  assert.match(sql, /verification\.manual_review is true[\s\S]*?profile_edit_review_pending = review_pending_after_commit/);
  assert.doesNotMatch(sql, /profile_completion_status = case when review_pending_after_commit/);
  assert.doesNotMatch(sql, /onboarding_status = case when \$6/);
  assert.match(sql, /'manualReviewRequired', review_pending_after_commit/);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*?new_mobile_country_code[\s\S]*?new_mobile_number/);
  assert.match(sql, /This mobile number cannot be used for self-service profile editing\. Contact an administrator\./);
  assert.match(sql, /update public\.connect_user_pins[\s\S]*?reset_required = true/);
  assert.match(sql, /update public\.connect_whatsapp_otp_requests[\s\S]*?purpose in \('connect_login', 'connect_pin_reset'\)/);
  assert.match(sql, /update public\.connect_sms_otp_requests[\s\S]*?purpose in \('connect_login', 'connect_pin_reset'\)/);
  assert.match(sql, /create or replace function public\.connect_authenticate_pin_and_create_session\(/);
  assert.match(sql, /create or replace function public\.connect_set_pin_and_create_session\(/);
  assert.match(
    sql,
    /status = 'verified',[\s\S]*?where id = otp_record\.id;[\s\S]*?status = 'cancelled',[\s\S]*?purpose in \('connect_login', 'connect_pin_reset'\)[\s\S]*?status = 'pending'[\s\S]*?id <> otp_record\.id;/
  );
  assert.match(sql, /create or replace function public\.connect_reserve_profile_edit_request\(/);
  assert.match(
    sql,
    /connect_reserve_profile_edit_request[\s\S]*?select distinct candidate[\s\S]*?order by candidate[\s\S]*?pg_advisory_xact_lock\(lock_key\)/
  );
  assert.match(
    sql,
    /if target_unavailable then[\s\S]*?redacted_at[\s\S]*?'failed'[\s\S]*?'target_unavailable'/
  );
  assert.equal(
    (sql.match(/hashtextextended\(p_country_code \|\| ':' \|\| p_mobile_number, 0\)/g) ?? []).length,
    2,
    "both credential RPCs must serialize on the same canonical mobile key"
  );
  assert.match(
    sql,
    /for phone_lock_key in[\s\S]*?current_mobile_country_code \|\| ':' \|\| edit_request\.current_mobile_number[\s\S]*?new_mobile_country_code \|\| ':' \|\| edit_request\.new_mobile_number[\s\S]*?order by 1[\s\S]*?pg_advisory_xact_lock\(phone_lock_key\)/
  );
  assert.match(sql, /if not source_phone_still_in_use then[\s\S]*?connect_login_sessions[\s\S]*?connect_user_pins/);
  assert.match(sql, /where id = p_login_session_id and revoked_at is null/);
  assert.match(sql, /profile_edit_review_pending boolean not null default false/);
  assert.match(sql, /review_pending_after_commit := manual_review_required[\s\S]*?profile_edit_review_pending/);
  assert.match(sql, /payload = '\{\}'::jsonb,[\s\S]*?before_values = '\{\}'::jsonb/);
  const editTypeConstraint = "profile_type text not null check (profile_type in ('employee', 'workforce', 'contractor', 'vendor'))";
  assert.equal(sql.split(editTypeConstraint).length - 1, 2);
});

test("profile-edit identity checks bind name matching to the immutable server profile", () => {
  const verificationRoute = fs.readFileSync(
    new URL("../../../../src/app/api/connect/verification/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    verificationRoute,
    /const profileEdit = payload\.profileEdit === true;[\s\S]*?const registeredName = profileEdit\s*\? account\.fullName\s*:\s*compact\(payload\.fullName\) \|\| account\.fullName/
  );
  assert.match(verificationRoute, /connect_profile_edit_verifications"\)\.upsert\(\{[\s\S]*?request_id: null/);
  assert.doesNotMatch(verificationRoute, /saveVerifiedIfsc|Bank verification succeeded but IFSC could not be saved/);

  const editRoute = fs.readFileSync(
    new URL("../../app/api/connect/profile-edit/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(editRoute, /const employeeSelect = \[[\s\S]*?"full_name"/);
  assert.match(editRoute, /const nonEmployeeBaseSelect = \[[\s\S]*?"full_name"/);
  assert.match(
    editRoute,
    /function identityNameHash\(value: unknown\) \{[\s\S]*?trim\(\)\.replace\(\/\\s\+\/g, " "\)\.toUpperCase\(\)[\s\S]*?createHash\("sha256"\)/
  );
  assert.match(
    editRoute,
    /\.rpc\("connect_reserve_profile_edit_request", \{[\s\S]*?p_source_updated_at: String\(profile\.updated_at\),[\s\S]*?p_identity_name_hash: identityNameHash\(profile\.full_name\)/
  );
  const migration = fs.readFileSync(
    new URL("../../../../supabase/migrations/20261015220000_connect_profile_edit_otp.sql", import.meta.url),
    "utf8"
  );
  assert.match(
    migration,
    /update public\.connect_profile_edit_verifications[\s\S]*?set request_id = p_request_id[\s\S]*?profile_updated_at = p_source_updated_at[\s\S]*?identity_name_hash = p_identity_name_hash/
  );

  const rootAuth = fs.readFileSync(
    new URL("../../../../src/lib/connect-auth.ts", import.meta.url),
    "utf8"
  );
  const rootCountries = fs.readFileSync(
    new URL("../../../../src/lib/country-codes.ts", import.meta.url),
    "utf8"
  );
  assert.match(rootAuth, /normalizeStoredConnectMobile[\s\S]*?from "@\/lib\/country-codes"/);
  assert.match(rootCountries, /export function normalizeStoredConnectMobile\([\s\S]*?storageFormat === "canonical"/);
  assert.match(verificationRoute, /mobile_number_format[\s\S]*?normalizeStoredConnectMobile\([\s\S]*?session\.mobile_number_format/);
});

test("completed profiles cannot mutate the profile photo outside the OTP edit boundary", () => {
  const photoRoute = fs.readFileSync(
    new URL("../../app/api/connect/profile-photo/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(photoRoute, /function assertRegistrationPhotoUpdate/);
  assert.match(photoRoute, /\["pending", "returned"\]\.includes\(status\)/);
  assert.equal((photoRoute.match(/assertRegistrationPhotoUpdate\(account\)/g) ?? []).length, 2);

  const profileApp = fs.readFileSync(
    new URL("../components/connect-profile-app.tsx", import.meta.url),
    "utf8"
  );
  assert.equal((profileApp.match(/<VerifiedProfilePhotoUpdate/g) ?? []).length, 1);
  assert.match(profileApp, /!readOnly && !account\.activationOnly && !editing \? <VerifiedProfilePhotoUpdate/);
});

test("profile serializers use the authenticated canonical session to disambiguate international mobiles", () => {
  for (const routeUrl of [
    "../../app/api/connect/profile/route.ts",
    "../../app/api/connect/field-executive-profile/route.ts"
  ]) {
    const route = fs.readFileSync(new URL(routeUrl, import.meta.url), "utf8");
    assert.match(route, /normalizeStoredConnectMobile\([\s\S]*?session\.mobile_number_format/);
    assert.match(route, /profileEditLocalMobile\(row\.mobile, mobileCountryCode, sessionMobile\?\.mobile\)/);
  }
});

test("all Connect session writers use credential-bound RPCs that mark canonical mobiles", () => {
  const issuance = fs.readFileSync(
    new URL("../../../../src/lib/connect-session-issuance.ts", import.meta.url),
    "utf8"
  );
  assert.match(issuance, /issueCredentialBoundSession\("connect_authenticate_pin_and_create_session"/);
  assert.match(issuance, /issueCredentialBoundSession\("connect_set_pin_and_create_session"/);

  for (const authUrl of [
    "./connect-auth.ts",
    "../../../../src/lib/connect-auth.ts"
  ]) {
    const auth = fs.readFileSync(new URL(authUrl, import.meta.url), "utf8");
    assert.match(auth, /authenticateConnectPin/);
    assert.match(auth, /setConnectPinWithOtp/);
    assert.doesNotMatch(auth, /export async function createConnectSession/);
  }

  const sql = fs.readFileSync(
    new URL("../../../../supabase/migrations/20261015220000_connect_profile_edit_otp.sql", import.meta.url),
    "utf8"
  );
  assert.equal(
    (sql.match(/p_session_id, p_country_code, p_mobile_number, 'canonical', p_session_hash/g) ?? []).length,
    2
  );

  for (const routeUrl of [
    "../../app/api/connect/auth/verify-pin/route.ts",
    "../../../../src/app/api/connect/auth/verify-pin/route.ts"
  ]) {
    const route = fs.readFileSync(new URL(routeUrl, import.meta.url), "utf8");
    assert.match(route, /authenticateConnectPin\(\{ countryCode, mobile, pin, request \}\)/);
    assert.doesNotMatch(route, /\.from\("connect_user_pins"\)/);
  }
  for (const routeUrl of [
    "../../app/api/connect/auth/set-pin/route.ts",
    "../../../../src/app/api/connect/auth/set-pin/route.ts"
  ]) {
    const route = fs.readFileSync(new URL(routeUrl, import.meta.url), "utf8");
    assert.match(route, /setConnectPinWithOtp\(\{ countryCode, mobile, otp, pin, request \}\)/);
    assert.doesNotMatch(route, /\.from\("connect_whatsapp_otp_requests"\)/);
  }

  for (const readerUrl of [
    "../../../../src/lib/connect-attendance-auth.ts",
    "../../../../src/app/api/connect/attendance/route.ts",
    "../../../../src/app/api/connect/advances/route.ts",
    "../../../../src/app/api/connect/auth/session/route.ts",
    "../../../../src/app/api/connect/event-log/route.ts",
    "../../../../src/app/api/connect/verification/route.ts"
  ]) {
    const reader = fs.readFileSync(new URL(readerUrl, import.meta.url), "utf8");
    assert.match(reader, /\.select\("[^"]*mobile_number_format[^"]*"\)/);
    assert.match(
      reader,
      /normalizeStoredConnectMobile\(\s*session\.mobile_number,\s*session\.country_code,\s*session\.mobile_number_format\s*\)/
    );
  }
});

test("returned profile edits remain visible and can only use the OTP edit flow", () => {
  for (const routeUrl of [
    "../../app/api/connect/profile/route.ts",
    "../../app/api/connect/field-executive-profile/route.ts"
  ]) {
    const route = fs.readFileSync(new URL(routeUrl, import.meta.url), "utf8");
    assert.match(
      route,
      /const fallbackResult = await supabaseAdmin[\s\S]*?\.select\("[^"]*profile_return_remarks, profile_edit_review_pending,[^"]*"\)[\s\S]*?\.maybeSingle\(\)/
    );
    assert.match(route, /profileEditReviewPending: row\.profile_edit_review_pending === true/);
    assert.match(
      route,
      /if \(current(?:Employee|Executive)\.profile_edit_review_pending === true\) \{[\s\S]*?Returned profile edits must be corrected with Edit profile and WhatsApp OTP\./
    );
  }

  const profileApp = fs.readFileSync(
    new URL("../components/connect-profile-app.tsx", import.meta.url),
    "utf8"
  );
  assert.match(
    profileApp,
    /const returnedSelfEdit = String\(profile\?\.status \?\? ""\)\.trim\(\)\.toLowerCase\(\) === "under_review"[\s\S]*?profile\?\.profileEditReviewPending === true[\s\S]*?Boolean\(profile\?\.returnRemarks\?\.trim\(\)\)/
  );
  assert.match(
    profileApp,
    /const canEditProfile =[\s\S]*?=== "active" \|\| returnedSelfEdit/
  );
});

test("mobile-change completion preserves a success message across forced reauthentication", () => {
  const profileApp = fs.readFileSync(
    new URL("../components/connect-profile-app.tsx", import.meta.url),
    "utf8"
  );
  const loginFlow = fs.readFileSync(
    new URL("../components/connect-login-flow.tsx", import.meta.url),
    "utf8"
  );
  assert.match(profileApp, /window\.location\.assign\("\/\?profileUpdated=1"\)/);
  assert.match(loginFlow, /searchParams\.get\("profileUpdated"\) !== "1"/);
  assert.match(loginFlow, /Profile updated successfully\. Sign in again with your new mobile number\./);
  assert.match(loginFlow, /nextParams\.delete\("profileUpdated"\)/);
});

test("OTP verification cannot consume a code replaced by a concurrent resend", () => {
  const route = fs.readFileSync(
    new URL("../../app/api/connect/profile-edit/route.ts", import.meta.url),
    "utf8"
  );
  const otpHashCas = /\.eq\(isCurrent \? "current_otp_hmac" : "new_otp_hmac", hmac\)/g;
  assert.equal(route.match(otpHashCas)?.length, 2);
});

test("profile edit migration deploys over the supported production schema boundary", async () => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create function digest(value text, algorithm text) returns bytea
      language sql immutable as $$ select decode(md5(value) || md5(value), 'hex') $$;
    create table companies(id uuid primary key);
    create table profiles(id uuid primary key, company_id uuid, mobile_country_code text, mobile text, is_active boolean);
    create table employees(
      id uuid primary key, company_id uuid, full_name text, mobile text, profile_completion_status text, is_active boolean,
      updated_at timestamptz, gender text, date_of_birth date, aadhaar_number text, pan_number text,
      address text, state text, pincode text, landmark text, state_code text, father_name text,
      blood_group text, bank_account_no text, ifsc text, emergency_contact_name text,
      emergency_contact_number text, emergency_contact_relation text, profile_return_remarks text,
      profile_returned_at timestamptz
    );
    create table workforce(
      id uuid primary key, company_id uuid, mobile text, onboarding_status text, is_active boolean,
      deleted_at timestamptz, updated_at timestamptz, designation text, gender text, date_of_birth date,
      aadhaar_number text, pan_number text, is_handicapped boolean, address text, postal_pin text,
      landmark text, state_code text, father_name text, blood_group text, bank_account_no text,
      ifsc_code text, driving_license_no text, driving_license_exp_date date, vehicle_reg_no text,
      vehicle_reg_exp_date date, vehicle_insurance_exp_date date, vehicle_pollution_exp_date date,
      emergency_contact_name text, emergency_contact_number text, emergency_contact_relation text
    );
    create table contractors(like workforce including all);
    create table vendors(like workforce including all);
    alter table vendors drop column deleted_at;
    create table connect_login_sessions(
      id uuid primary key, country_code text, mobile_number text, session_hash text unique, expires_at timestamptz,
      revoked_at timestamptz, request_ip text, user_agent text
    );
    create table connect_user_pins(
      id uuid primary key default gen_random_uuid(), country_code text, mobile_number text, pin_hash text, attempt_count integer,
      locked_until timestamptz, reset_required boolean, updated_at timestamptz,
      unique(country_code, mobile_number)
    );
    create table connect_whatsapp_otp_requests(
      id uuid primary key default gen_random_uuid(), country_code text, mobile_number text, purpose text,
      otp_hash text, status text, expires_at timestamptz, used_at timestamptz,
      attempt_count integer not null default 0, max_attempts integer not null default 5,
      request_ip text, user_agent text, created_at timestamptz not null default now(), updated_at timestamptz
    );
    create table connect_sms_otp_requests(
      id uuid primary key, country_code text, mobile_number text, purpose text, status text, updated_at timestamptz
    );
    create table connect_account_devices(
      id uuid primary key, account_id uuid, company_id uuid, profile_type text, country_code text,
      mobile_number text, reset_at timestamptz, updated_at timestamptz
    );
    create table connect_profile_verifications(
      id uuid primary key default gen_random_uuid(), company_id uuid not null, profile_type text not null,
      account_id uuid not null, kind text not null, input_key text not null, verified boolean not null default false,
      manual_review boolean not null default false, block_submit boolean not null default false,
      display_name text, message text, details jsonb not null default '{}'::jsonb, verified_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      constraint connect_profile_verifications_profile_type_check check (profile_type in ('employee','field_executive')),
      unique(company_id, profile_type, account_id, kind)
    );
  `);
  const sql = fs.readFileSync(new URL("../../../../supabase/migrations/20261015220000_connect_profile_edit_otp.sql", import.meta.url), "utf8")
    // Supabase includes pgcrypto; the lightweight PGlite test runtime does not
    // ship its extension control file, while gen_random_uuid itself is built in.
    .replace("create extension if not exists pgcrypto;", "");
  await db.exec(sql);
  const functions = await db.query(`
    select proname from pg_proc
    where proname in (
      'connect_authenticate_pin_and_create_session',
      'connect_commit_profile_edit',
      'connect_redact_expired_profile_edits',
      'connect_reserve_profile_edit_request',
      'connect_set_pin_and_create_session'
    )
    order by proname
  `);
  assert.deepEqual(functions.rows.map((row) => row.proname), [
    "connect_authenticate_pin_and_create_session",
    "connect_commit_profile_edit",
    "connect_redact_expired_profile_edits",
    "connect_reserve_profile_edit_request",
    "connect_set_pin_and_create_session"
  ]);
  assert.equal((await db.query("select connect_redact_expired_profile_edits() as count")).rows[0].count, 0);

  await db.exec(`
    insert into companies(id) values ('00000000-0000-0000-0000-000000000001');
    insert into employees(
      id, company_id, full_name, mobile_country_code, mobile,
      profile_completion_status, is_active, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000001',
      'Legacy Session Owner', '91', '9876543210', 'active', true,
      '2026-10-15T00:00:00Z'
    );
    insert into connect_login_sessions(
      id, country_code, mobile_number, mobile_number_format, session_hash,
      expires_at, revoked_at
    ) values
      (
        '00000000-0000-0000-0000-000000000003', '91', '919876543210',
        'canonical', 'current-session', now() + interval '1 day', null
      ),
      (
        '00000000-0000-0000-0000-000000000004', '65', '91234567',
        'legacy', 'stale-target-session', now() + interval '1 day', null
      ),
      (
        '00000000-0000-0000-0000-000000000030', '91', '919876543210',
        'canonical', 'other-source-session', now() + interval '1 day', null
      );
    insert into connect_user_pins(
      id, country_code, mobile_number, pin_hash, attempt_count,
      locked_until, reset_required, updated_at
    ) values
      (
        '00000000-0000-0000-0000-000000000006', '65', '91234567',
        'pin-salt:' || encode(digest('pin-salt:123456', 'sha256'), 'hex'),
        2, null, false, now()
      ),
      (
        '00000000-0000-0000-0000-000000000012', '65', '6591234567',
        'canonical-pin-salt:' || encode(digest('canonical-pin-salt:123456', 'sha256'), 'hex'),
        0, null, false, now()
      ),
      (
        '00000000-0000-0000-0000-000000000031', '91', '919876543210',
        'source-pin-salt:' || encode(digest('source-pin-salt:123456', 'sha256'), 'hex'),
        1, null, false, now()
      );
    insert into connect_whatsapp_otp_requests(
      id, country_code, mobile_number, purpose, otp_hash, status,
      expires_at, attempt_count, max_attempts, created_at, updated_at
    ) values
      (
        '00000000-0000-0000-0000-000000000010', '65', '91234567',
        'connect_login',
        'otp-salt:' || encode(digest('otp-salt:654321', 'sha256'), 'hex'),
        'pending', now() + interval '10 minutes', 0, 5, now(), now()
      ),
      (
        '00000000-0000-0000-0000-000000000012', '65', '6591234567',
        'connect_pin_reset',
        'canonical-otp-salt:' || encode(digest('canonical-otp-salt:654321', 'sha256'), 'hex'),
        'pending', now() + interval '10 minutes', 0, 5, now(), now()
      ),
      (
        '00000000-0000-0000-0000-000000000032', '91', '919876543210',
        'connect_login',
        'source-otp-salt:' || encode(digest('source-otp-salt:654321', 'sha256'), 'hex'),
        'pending', now() + interval '10 minutes', 0, 5, now(), now()
      );
    insert into connect_sms_otp_requests(
      id, country_code, mobile_number, purpose, status, updated_at
    ) values
      (
        '00000000-0000-0000-0000-000000000011', '65', '6591234567',
        'connect_pin_reset', 'pending', now()
      ),
      (
        '00000000-0000-0000-0000-000000000033', '91', '919876543210',
        'connect_pin_reset', 'pending', now()
      );
    insert into connect_profile_edit_requests(
      id, company_id, account_id, profile_type, login_session_id,
      source_updated_at, current_mobile_country_code, current_mobile_value,
      current_mobile_number, current_mobile_hash, new_mobile_country_code,
      new_mobile_value, new_mobile_number, new_mobile_hash, mobile_changed,
      payload, before_values, payload_hash, status, current_otp_verified_at,
      new_otp_verified_at, request_expires_at
    ) values (
      '00000000-0000-0000-0000-000000000005',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002', 'employee',
      '00000000-0000-0000-0000-000000000003',
      '2026-10-15T00:00:00Z', '91', '9876543210', '919876543210',
      'current-hash', '65', '91234567', '6591234567', 'new-hash', true,
      '{}'::jsonb, '{}'::jsonb, 'payload-hash', 'verified', now(), now(),
      now() + interval '30 minutes'
    );
    insert into workforce(
      id, company_id, mobile_country_code, mobile,
      onboarding_status, is_active, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000009',
      '00000000-0000-0000-0000-000000000001',
      '65', '91234567', 'pending', false, now()
    );
  `);

  await db.exec(`
    insert into employees(
      id, company_id, full_name, mobile_country_code, mobile,
      profile_completion_status, is_active, updated_at
    ) values
      (
        '00000000-0000-0000-0000-000000000020',
        '00000000-0000-0000-0000-000000000001',
        'Parallel Reservation', '91', '8888888888', 'active', true,
        '2026-10-15T02:00:00Z'
      ),
      (
        '00000000-0000-0000-0000-000000000023',
        '00000000-0000-0000-0000-000000000001',
        'Rejected Reservation', '91', '7777777777', 'active', true,
        '2026-10-15T03:00:00Z'
      );
    insert into connect_login_sessions(
      id, country_code, mobile_number, mobile_number_format, session_hash,
      expires_at, revoked_at
    ) values
      (
        '00000000-0000-0000-0000-000000000021', '91', '918888888888',
        'canonical', 'parallel-reservation-session', now() + interval '1 day', null
      ),
      (
        '00000000-0000-0000-0000-000000000024', '91', '917777777777',
        'canonical', 'rejected-reservation-session', now() + interval '1 day', null
      );
  `);

  const reserveParallelRequest = (requestId) => db.query(`
    select connect_reserve_profile_edit_request(
      '${requestId}',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000020', 'employee',
      '00000000-0000-0000-0000-000000000021',
      '2026-10-15T02:00:00Z',
      repeat('2', 64),
      '91', '8888888888', '918888888888', 'parallel-current-hash',
      '91', '8888888888', '918888888888', 'parallel-target-hash', false,
      '{"address":"New address"}'::jsonb, '{"address":"Old address"}'::jsonb,
      'parallel-payload-hash', now() + interval '30 minutes',
      '203.0.113.20', 'fixture', 1, 1, 1
    ) as result
  `);
  const parallelReservations = await Promise.all([
    reserveParallelRequest("00000000-0000-0000-0000-000000000022"),
    reserveParallelRequest("00000000-0000-0000-0000-000000000027")
  ]);
  assert.deepEqual(
    parallelReservations
      .map((reservation) => reservation.rows[0].result.ok ? "ok" : reservation.rows[0].result.code)
      .sort(),
    ["ok", "rate_limited"]
  );
  const parallelRequestCount = await db.query(`
    select count(*)::integer as count
    from connect_profile_edit_requests
    where account_id = '00000000-0000-0000-0000-000000000020'
  `);
  assert.equal(parallelRequestCount.rows[0].count, 1);

  const unavailableTarget = await db.query(`
    select connect_reserve_profile_edit_request(
      '00000000-0000-0000-0000-000000000025',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000023', 'employee',
      '00000000-0000-0000-0000-000000000024',
      '2026-10-15T03:00:00Z',
      repeat('3', 64),
      '91', '7777777777', '917777777777', 'rejected-current-hash',
      '91', '9876543210', '919876543210', 'occupied-target-hash', true,
      '{"address":"Secret change"}'::jsonb, '{"address":"Secret old"}'::jsonb,
      'rejected-payload-hash', now() + interval '30 minutes',
      '203.0.113.23', 'fixture', 1, 1, 1
    ) as result
  `);
  assert.deepEqual(unavailableTarget.rows[0].result, {
    ok: false,
    code: "target_unavailable"
  });

  const rejectedProbeHitsLimit = await db.query(`
    select connect_reserve_profile_edit_request(
      '00000000-0000-0000-0000-000000000026',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000023', 'employee',
      '00000000-0000-0000-0000-000000000024',
      '2026-10-15T03:00:00Z',
      repeat('3', 64),
      '91', '7777777777', '917777777777', 'rejected-current-hash',
      '91', '9876543210', '919876543210', 'occupied-target-hash', true,
      '{"address":"Another secret"}'::jsonb, '{"address":"Secret old"}'::jsonb,
      'rejected-payload-hash-2', now() + interval '30 minutes',
      '203.0.113.23', 'fixture', 1, 1, 1
    ) as result
  `);
  assert.deepEqual(rejectedProbeHitsLimit.rows[0].result, {
    ok: false,
    code: "rate_limited"
  });
  const rejectedReservation = await db.query(`
    select status, current_mobile_country_code, current_mobile_value,
      current_mobile_number, new_mobile_country_code, new_mobile_value,
      new_mobile_number, new_mobile_hash, payload, before_values,
      redacted_at is not null as redacted
    from connect_profile_edit_requests
    where account_id = '00000000-0000-0000-0000-000000000023'
  `);
  assert.deepEqual(rejectedReservation.rows, [{
    status: "failed",
    current_mobile_country_code: "",
    current_mobile_value: "",
    current_mobile_number: "",
    new_mobile_country_code: "",
    new_mobile_value: "",
    new_mobile_number: "",
    new_mobile_hash: "occupied-target-hash",
    payload: {},
    before_values: {},
    redacted: true
  }]);
  const rejectedAudit = await db.query(`
    select event_code, metadata
    from connect_profile_edit_audit
    where request_id = '00000000-0000-0000-0000-000000000025'
  `);
  assert.deepEqual(rejectedAudit.rows, [{
    event_code: "start_rejected",
    metadata: { reason: "target_unavailable" }
  }]);

  await assert.rejects(
    db.exec(`select connect_commit_profile_edit(
      '00000000-0000-0000-0000-000000000005',
      '00000000-0000-0000-0000-000000000003'
    )`),
    /cannot be used for self-service profile editing/
  );
  const credentialsAfterRejectedMove = await db.query(`
    select
      (select revoked_at is null from connect_login_sessions where id = '00000000-0000-0000-0000-000000000004') as session_active,
      (select reset_required from connect_user_pins where id = '00000000-0000-0000-0000-000000000006') as pin_reset,
      (select status from connect_whatsapp_otp_requests where id = '00000000-0000-0000-0000-000000000010') as whatsapp_status
  `);
  assert.deepEqual(credentialsAfterRejectedMove.rows[0], {
    session_active: true,
    pin_reset: false,
    whatsapp_status: "pending"
  });

  const pinSessionBeforeMove = await db.query(`
    select connect_authenticate_pin_and_create_session(
      '65', '6591234567', '123456',
      '00000000-0000-0000-0000-000000000014', repeat('a', 64),
      now() + interval '1 day', '127.0.0.1', 'fixture'
    ) as result
  `);
  assert.deepEqual(pinSessionBeforeMove.rows[0].result, { ok: true });

  await db.exec(`
    delete from workforce where id = '00000000-0000-0000-0000-000000000009';
    select connect_commit_profile_edit(
      '00000000-0000-0000-0000-000000000005',
      '00000000-0000-0000-0000-000000000003'
    );
  `);
  const sessions = await db.query(`
    select id, revoked_at from connect_login_sessions
    where id in (
      '00000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000004',
      '00000000-0000-0000-0000-000000000014'
    ) order by id
  `);
  assert.ok(sessions.rows[0].revoked_at, "the initiating session must be revoked");
  assert.ok(sessions.rows[1].revoked_at, "a recycled destination session must be revoked");
  assert.ok(sessions.rows[2].revoked_at, "a credential-bound session issued before the move must be revoked");
  const retiredSourceCredentials = await db.query(`
    select
      (select revoked_at is not null from connect_login_sessions
        where id = '00000000-0000-0000-0000-000000000030') as session_revoked,
      (select reset_required from connect_user_pins
        where id = '00000000-0000-0000-0000-000000000031') as pin_reset,
      (select status from connect_whatsapp_otp_requests
        where id = '00000000-0000-0000-0000-000000000032') as whatsapp_status,
      (select status from connect_sms_otp_requests
        where id = '00000000-0000-0000-0000-000000000033') as sms_status
  `);
  assert.deepEqual(retiredSourceCredentials.rows[0], {
    session_revoked: true,
    pin_reset: true,
    whatsapp_status: "expired",
    sms_status: "expired"
  });
  const recycledPin = await db.query(`
    select attempt_count, reset_required from connect_user_pins
    where id = '00000000-0000-0000-0000-000000000006'
  `);
  assert.deepEqual(recycledPin.rows[0], { attempt_count: 0, reset_required: true });
  const expiredTargetOtps = await db.query(`
    select id, status from (
      select id, status from connect_whatsapp_otp_requests
      union all
      select id, status from connect_sms_otp_requests
    ) target_otps order by id
  `);
  assert.deepEqual(expiredTargetOtps.rows, [
    { id: "00000000-0000-0000-0000-000000000010", status: "expired" },
    { id: "00000000-0000-0000-0000-000000000011", status: "expired" },
    { id: "00000000-0000-0000-0000-000000000012", status: "expired" },
    { id: "00000000-0000-0000-0000-000000000032", status: "expired" },
    { id: "00000000-0000-0000-0000-000000000033", status: "expired" }
  ]);

  const stalePinResult = await db.query(`
    select connect_authenticate_pin_and_create_session(
      '65', '6591234567', '123456',
      '00000000-0000-0000-0000-000000000015', repeat('b', 64),
      now() + interval '1 day', '127.0.0.1', 'fixture'
    ) as result
  `);
  assert.deepEqual(stalePinResult.rows[0].result, { ok: false, code: "pin_setup_required" });

  const staleOtpResult = await db.query(`
    select connect_set_pin_and_create_session(
      '65', '6591234567', '654321',
      'fresh-pin-salt:' || encode(digest('fresh-pin-salt:111111', 'sha256'), 'hex'),
      '00000000-0000-0000-0000-000000000016', repeat('c', 64),
      now() + interval '1 day', '127.0.0.1', 'fixture'
    ) as result
  `);
  assert.deepEqual(staleOtpResult.rows[0].result, { ok: false, code: "otp_missing" });
  const staleSessions = await db.query(`
    select
      (select count(*)::integer from connect_login_sessions
        where id in (
          '00000000-0000-0000-0000-000000000015',
          '00000000-0000-0000-0000-000000000016'
        )) as count,
      (select reset_required from connect_user_pins
        where country_code = '65' and mobile_number = '6591234567') as pin_reset
  `);
  assert.deepEqual(staleSessions.rows[0], { count: 0, pin_reset: true });

  await db.exec(`
    insert into connect_whatsapp_otp_requests(
      id, country_code, mobile_number, purpose, otp_hash, status,
      expires_at, attempt_count, max_attempts, created_at, updated_at
    ) values
      (
        '00000000-0000-0000-0000-000000000019', '44', '447700900123',
        'connect_pin_reset',
        'superseded-otp-salt:' || encode(digest('superseded-otp-salt:998877', 'sha256'), 'hex'),
        'pending', now() + interval '10 minutes', 0, 5,
        now() - interval '1 minute', now() - interval '1 minute'
      ),
      (
        '00000000-0000-0000-0000-000000000017', '44', '447700900123',
        'connect_login',
        'positive-otp-salt:' || encode(digest('positive-otp-salt:112233', 'sha256'), 'hex'),
        'pending', now() + interval '10 minutes', 0, 5, now(), now()
      )
  `);
  const setPinSuccess = await db.query(`
    select connect_set_pin_and_create_session(
      '44', '447700900123', '112233',
      'positive-pin-salt:' || encode(digest('positive-pin-salt:445566', 'sha256'), 'hex'),
      '00000000-0000-0000-0000-000000000018', repeat('d', 64),
      now() + interval '1 day', '127.0.0.1', 'fixture'
    ) as result
  `);
  assert.deepEqual(setPinSuccess.rows[0].result, { ok: true });
  const positiveCredentialState = await db.query(`
    select
      (select status from connect_whatsapp_otp_requests
        where id = '00000000-0000-0000-0000-000000000017') as otp_status,
      (select used_at is not null from connect_whatsapp_otp_requests
        where id = '00000000-0000-0000-0000-000000000017') as otp_used,
      (select status from connect_whatsapp_otp_requests
        where id = '00000000-0000-0000-0000-000000000019') as superseded_otp_status,
      (select reset_required from connect_user_pins
        where country_code = '44' and mobile_number = '447700900123') as pin_reset,
      (select mobile_number_format from connect_login_sessions
        where id = '00000000-0000-0000-0000-000000000018') as session_format
  `);
  assert.deepEqual(positiveCredentialState.rows[0], {
    otp_status: "verified",
    otp_used: true,
    superseded_otp_status: "cancelled",
    pin_reset: false,
    session_format: "canonical"
  });

  await db.exec(`
    insert into employees(
      id, company_id, full_name, mobile_country_code, mobile, pan_number,
      address, profile_completion_status, is_active, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000007',
      '00000000-0000-0000-0000-000000000001',
      'Review User', '91', '9999999999', null, 'Old address', 'active', true,
      '2026-10-15T01:00:00Z'
    );
    insert into connect_login_sessions(
      id, country_code, mobile_number, mobile_number_format, session_hash,
      expires_at, revoked_at
    ) values (
      '00000000-0000-0000-0000-000000000008', '91', '919999999999',
      'canonical', 'review-session', now() + interval '1 day', null
    );
    insert into connect_profile_edit_requests(
      id, company_id, account_id, profile_type, login_session_id,
      source_updated_at, current_mobile_country_code, current_mobile_value,
      current_mobile_number, current_mobile_hash, new_mobile_country_code,
      new_mobile_value, new_mobile_number, new_mobile_hash, mobile_changed,
      payload, before_values, payload_hash, status, current_otp_verified_at,
      request_expires_at
    ) values (
      '00000000-0000-0000-0000-000000000009',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000007', 'employee',
      '00000000-0000-0000-0000-000000000008',
      '2026-10-15T01:00:00Z', '91', '9999999999', '919999999999',
      'current-hash', '91', '9999999999', '919999999999', 'new-hash', false,
      '{"pan_number":" abcde1234f "}'::jsonb, '{"pan_number":null}'::jsonb,
      'payload-hash', 'verified', now(), now() + interval '30 minutes'
    );
    insert into connect_profile_edit_verifications(
      request_id, login_session_id, company_id, account_id, profile_type,
      kind, profile_updated_at, identity_name_hash, input_key, verified,
      manual_review, block_submit, details, expires_at
    ) values (
      '00000000-0000-0000-0000-000000000009',
      '00000000-0000-0000-0000-000000000008',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000007', 'employee', 'pan',
      '2026-10-15T01:00:00Z', encode(digest('REVIEW USER', 'sha256'), 'hex'),
      'ABCDE1234F', false, true, false,
      '{"kind":"pan","inputKey":"ABCDE1234F","manualReview":true}'::jsonb,
      now() + interval '30 minutes'
    );
    select connect_commit_profile_edit(
      '00000000-0000-0000-0000-000000000009',
      '00000000-0000-0000-0000-000000000008'
    );
    update employees set
      profile_return_remarks = 'Correct PAN details',
      profile_returned_at = now(),
      updated_at = now() + interval '1 second'
    where id = '00000000-0000-0000-0000-000000000007';
    insert into connect_profile_edit_requests(
      id, company_id, account_id, profile_type, login_session_id,
      source_updated_at, current_mobile_country_code, current_mobile_value,
      current_mobile_number, current_mobile_hash, new_mobile_country_code,
      new_mobile_value, new_mobile_number, new_mobile_hash, mobile_changed,
      payload, before_values, payload_hash, status, current_otp_verified_at,
      request_expires_at
    ) select
      '00000000-0000-0000-0000-000000000011', company_id, id, 'employee',
      '00000000-0000-0000-0000-000000000008', updated_at,
      mobile_country_code, mobile, '919999999999', 'current-hash',
      mobile_country_code, mobile, '919999999999', 'new-hash', false,
      '{"address":"Corrected address"}'::jsonb,
      jsonb_build_object('address', address), 'payload-hash-2', 'verified', now(),
      now() + interval '30 minutes'
    from employees
    where id = '00000000-0000-0000-0000-000000000007';
    select connect_commit_profile_edit(
      '00000000-0000-0000-0000-000000000011',
      '00000000-0000-0000-0000-000000000008'
    );
  `);
  const correctionState = await db.query(`
    select profile_completion_status, profile_edit_review_pending,
      profile_return_remarks, address
    from employees
    where id = '00000000-0000-0000-0000-000000000007'
  `);
  assert.deepEqual(correctionState.rows[0], {
    profile_completion_status: "active",
    profile_edit_review_pending: true,
    profile_return_remarks: null,
    address: "Corrected address"
  });

  await db.exec(`
    insert into employees(
      id, company_id, full_name, mobile_country_code, mobile, aadhaar_number,
      pan_number, bank_account_no, ifsc, address, profile_completion_status,
      is_active, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000034',
      '00000000-0000-0000-0000-000000000001',
      'Legacy Blank User', '91', '6666666666', '   ', null, ' ', null,
      'Old legacy address', 'active', true, '2026-10-15T04:00:00Z'
    );
    insert into connect_login_sessions(
      id, country_code, mobile_number, mobile_number_format, session_hash,
      expires_at, revoked_at
    ) values (
      '00000000-0000-0000-0000-000000000035', '91', '916666666666',
      'canonical', 'legacy-blank-session', now() + interval '1 day', null
    );
    insert into connect_profile_edit_requests(
      id, company_id, account_id, profile_type, login_session_id,
      source_updated_at, current_mobile_country_code, current_mobile_value,
      current_mobile_number, current_mobile_hash, new_mobile_country_code,
      new_mobile_value, new_mobile_number, new_mobile_hash, mobile_changed,
      payload, before_values, payload_hash, status, current_otp_verified_at,
      request_expires_at
    ) values (
      '00000000-0000-0000-0000-000000000036',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000034', 'employee',
      '00000000-0000-0000-0000-000000000035',
      '2026-10-15T04:00:00Z', '91', '6666666666', '916666666666',
      'legacy-current-hash', '91', '6666666666', '916666666666',
      'legacy-new-hash', false,
      '{"address":"New legacy-compatible address"}'::jsonb,
      '{"address":"Old legacy address"}'::jsonb,
      'legacy-payload-hash', 'verified', now(), now() + interval '30 minutes'
    );
    select connect_commit_profile_edit(
      '00000000-0000-0000-0000-000000000036',
      '00000000-0000-0000-0000-000000000035'
    );
  `);
  const legacyBlankState = await db.query(`
    select address from employees
    where id = '00000000-0000-0000-0000-000000000034'
  `);
  assert.deepEqual(legacyBlankState.rows[0], {
    address: "New legacy-compatible address"
  });
  await db.close();
});

test("profile edit retention is authenticated and scheduled", () => {
  const route = fs.readFileSync(
    new URL("../../../../src/app/api/cron/connect-profile-edit-retention/route.ts", import.meta.url),
    "utf8"
  );
  const vercel = JSON.parse(fs.readFileSync(
    new URL("../../../../vercel.json", import.meta.url),
    "utf8"
  ));
  assert.match(route, /process\.env\.CRON_SECRET/);
  assert.match(route, /authorization[\s\S]*?Bearer \$\{secret\}/);
  assert.match(route, /connect_redact_expired_profile_edits/);
  assert.deepEqual(
    vercel.crons.find((cron) => cron.path === "/api/cron/connect-profile-edit-retention"),
    { path: "/api/cron/connect-profile-edit-retention", schedule: "17 * * * *" }
  );
});
