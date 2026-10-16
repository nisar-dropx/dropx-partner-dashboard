import { createHash, createHmac, randomUUID } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  connectSessionCookieName,
  findConnectAccounts,
  requestIp,
  type ConnectAccount
} from "@/lib/connect-auth";
import { generateOtp } from "@/lib/connect-otp";
import {
  canonicalProfileEditType,
  changedProfileEditPayload,
  createProfileEditOtpHmac,
  maskProfileEditMobile,
  normalizeProfileEditPayload,
  profileEditLocalMobile,
  profileEditMobileHash,
  profileEditOtpSecret,
  verifyProfileEditOtpHmac,
  type ProfileEditPayload,
  type ProfileEditProfileType
} from "@/lib/connect-profile-edit";
import { resolveConnectPreview } from "@/lib/connect-preview";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { sendCompanyConnectOtp } from "@/lib/connect-whatsapp-otp";
import { loadTrustedVehicleFuel } from "@/lib/trusted-vehicle-verification";
import { isPureElectricFuel } from "@/lib/vehicle-fuel";
import { loadWorkforceCategoryRules } from "@/lib/workforce-category-rules";
import { profileFieldRuleCategory, type NonEmployeeProfileType } from "@/lib/workforce-profiles";
import {
  ConnectMobileValidationError,
  normalizeProfileEditMobile,
  normalizeStoredConnectMobile,
  normalizeSupportedCountryCode
} from "@/lib/country-codes";

export const maxDuration = 30;

const REQUEST_EXPIRY_MINUTES = 30;
const OTP_RESEND_COOLDOWN_SECONDS = 30;
const MAX_OTP_SENDS_PER_LEG = 4;
const MAX_STARTS_PER_ACCOUNT_PER_HOUR = 5;
const MAX_STARTS_PER_IP_PER_HOUR = 20;
const MAX_STARTS_PER_TARGET_PER_HOUR = 5;

type ActiveSession = {
  id: string;
  country_code: string;
  mobile_number: string;
  expires_at: string;
  revoked_at: string | null;
};

type EditRequestRow = {
  id: string;
  company_id: string;
  account_id: string;
  profile_type: ProfileEditProfileType;
  login_session_id: string;
  source_updated_at: string;
  current_mobile_number: string;
  new_mobile_number: string;
  mobile_changed: boolean;
  status: string;
  current_otp_hmac: string | null;
  current_otp_expires_at: string | null;
  current_otp_attempt_count: number;
  current_otp_max_attempts: number;
  current_otp_verified_at: string | null;
  current_otp_sent_at: string | null;
  current_otp_send_count: number;
  new_otp_hmac: string | null;
  new_otp_expires_at: string | null;
  new_otp_attempt_count: number;
  new_otp_max_attempts: number;
  new_otp_verified_at: string | null;
  new_otp_sent_at: string | null;
  new_otp_send_count: number;
  request_expires_at: string;
  request_ip: string | null;
  user_agent: string | null;
};

type ProfileRow = Record<string, unknown> & {
  id: string;
  company_id: string;
  full_name: string | null;
  mobile_country_code: string | null;
  mobile: string;
};

class ProfileEditError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
function editTable(profileType: ProfileEditProfileType) {
  if (profileType === "employee") return "employees";
  if (profileType === "workforce") return "workforce";
  if (profileType === "contractor") return "contractors";
  return "vendors";
}

const employeeSelect = [
  "id", "company_id", "full_name", "mobile_country_code", "mobile", "profile_completion_status", "is_active", "updated_at", "designation_id",
  "gender", "date_of_birth", "aadhaar_number", "pan_number", "eshram_uan", "is_handicapped",
  "address", "state", "pincode", "landmark", "state_code", "father_name", "blood_group",
  "bank_account_no", "ifsc", "pf_uan", "pf_account_no", "esi_no", "driving_license_no",
  "driving_license_exp_date", "vehicle_reg_no", "vehicle_reg_exp_date", "vehicle_insurance_exp_date",
  "vehicle_pollution_exp_date", "emergency_contact_name", "emergency_contact_number",
  "emergency_contact_relation"
].join(",");

const nonEmployeeBaseSelect = [
  "id", "company_id", "full_name", "mobile_country_code", "mobile", "onboarding_status", "is_active", "deleted_at", "updated_at", "designation",
  "gender", "date_of_birth", "aadhaar_number", "pan_number", "eshram_uan", "is_handicapped",
  "address", "postal_pin", "landmark", "state_code", "father_name", "blood_group",
  "bank_account_no", "ifsc_code", "pf_uan", "pf_account_no", "esi_no", "driving_license_no",
  "driving_license_exp_date", "vehicle_reg_no", "vehicle_reg_exp_date", "vehicle_insurance_exp_date",
  "vehicle_pollution_exp_date", "emergency_contact_name", "emergency_contact_number",
  "emergency_contact_relation"
].join(",");

function nonEmployeeSelect(profileType: ProfileEditProfileType) {
  // Vendors inherit the older field-executive shape and have no deleted_at.
  // Workforce and contractors use that soft-delete boundary.
  return profileType === "vendor"
    ? nonEmployeeBaseSelect.split(",").filter((field) => field !== "deleted_at").join(",")
    : nonEmployeeBaseSelect;
}

function currentPayloadValues(row: ProfileRow, profileType: ProfileEditProfileType): Record<string, unknown> {
  return {
    gender: row.gender ?? null,
    date_of_birth: row.date_of_birth ?? null,
    aadhaar_number: row.aadhaar_number ?? null,
    pan_number: row.pan_number ?? null,
    eshram_uan: row.eshram_uan ?? null,
    is_handicapped: row.is_handicapped ?? null,
    address: row.address ?? null,
    ...(profileType === "employee" ? { state: row.state ?? null } : {}),
    pincode: profileType === "employee" ? row.pincode ?? null : row.postal_pin ?? null,
    landmark: row.landmark ?? null,
    state_code: row.state_code ?? null,
    father_name: row.father_name ?? null,
    blood_group: row.blood_group ?? null,
    bank_account_no: row.bank_account_no ?? null,
    ifsc: profileType === "employee" ? row.ifsc ?? null : row.ifsc_code ?? null,
    pf_uan: row.pf_uan ?? null,
    pf_account_no: row.pf_account_no ?? null,
    esi_no: row.esi_no ?? null,
    driving_license_no: row.driving_license_no ?? null,
    driving_license_exp_date: row.driving_license_exp_date ?? null,
    vehicle_reg_no: row.vehicle_reg_no ?? null,
    vehicle_reg_exp_date: row.vehicle_reg_exp_date ?? null,
    vehicle_insurance_exp_date: row.vehicle_insurance_exp_date ?? null,
    vehicle_pollution_exp_date: row.vehicle_pollution_exp_date ?? null,
    emergency_contact_name: row.emergency_contact_name ?? null,
    emergency_contact_number: row.emergency_contact_number ?? null,
    emergency_contact_relation: row.emergency_contact_relation ?? null
  };
}

function displayDate(value: unknown) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : text;
}

function profileEditBootstrapValues(
  row: ProfileRow,
  profileType: ProfileEditProfileType
): Record<string, string | boolean | null> {
  return {
    gender: String(row.gender ?? ""),
    dateOfBirth: displayDate(row.date_of_birth),
    aadhaarNumber: String(row.aadhaar_number ?? ""),
    panNumber: String(row.pan_number ?? ""),
    eshramUan: String(row.eshram_uan ?? ""),
    isHandicapped: typeof row.is_handicapped === "boolean" ? row.is_handicapped : null,
    address: String(row.address ?? ""),
    ...(profileType === "employee" ? { state: String(row.state ?? "") } : {}),
    pincode: String(profileType === "employee" ? row.pincode ?? "" : row.postal_pin ?? ""),
    landmark: String(row.landmark ?? ""),
    stateCode: String(row.state_code ?? ""),
    fatherName: String(row.father_name ?? ""),
    bloodGroup: String(row.blood_group ?? ""),
    bankAccountNo: String(row.bank_account_no ?? ""),
    ifsc: String(profileType === "employee" ? row.ifsc ?? "" : row.ifsc_code ?? ""),
    pfUan: String(row.pf_uan ?? ""),
    pfAccountNo: String(row.pf_account_no ?? ""),
    esiNo: String(row.esi_no ?? ""),
    drivingLicenseNo: String(row.driving_license_no ?? ""),
    drivingLicenseExpiry: displayDate(row.driving_license_exp_date),
    vehicleRegistrationNo: String(row.vehicle_reg_no ?? ""),
    registrationExpiry: displayDate(row.vehicle_reg_exp_date),
    insuranceExpiry: displayDate(row.vehicle_insurance_exp_date),
    pollutionExpiry: displayDate(row.vehicle_pollution_exp_date),
    emergencyContactName: String(row.emergency_contact_name ?? ""),
    emergencyContactNumber: String(row.emergency_contact_number ?? ""),
    emergencyContactRelation: String(row.emergency_contact_relation ?? "")
  };
}

function parseSessionMobile(value: unknown, countryCode: unknown) {
  try {
    return normalizeStoredConnectMobile(value, countryCode, null);
  } catch (error) {
    if (error instanceof ConnectMobileValidationError) throw new ProfileEditError(error.message);
    throw error;
  }
}

function parseSubmittedMobile(value: unknown, countryCode: unknown) {
  try {
    return normalizeProfileEditMobile(value, countryCode);
  } catch (error) {
    if (error instanceof ConnectMobileValidationError) throw new ProfileEditError(error.message);
    throw error;
  }
}

function identityNameHash(value: unknown) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return createHash("sha256").update(normalized).digest("hex");
}

async function activeSession() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  if (await resolveConnectPreview()) {
    throw new ProfileEditError("Profile editing is unavailable in preview mode.", 403);
  }
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) throw new ProfileEditError("Connect session expired. Please log in again.", 401);
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const result = await supabaseAdmin
    .from("connect_login_sessions")
    .select("id,country_code,mobile_number,expires_at,revoked_at")
    .eq("session_hash", sessionHash)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const session = result.data as ActiveSession | null;
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    cookies().delete(connectSessionCookieName);
    throw new ProfileEditError("Connect session expired. Please log in again.", 401);
  }
  return session;
}

async function authenticatedAccount(
  session: ActiveSession,
  accountId: string,
  profileType: ProfileEditProfileType
) {
  const sessionMobile = parseSessionMobile(
    session.mobile_number,
    session.country_code
  );
  const accounts = await findConnectAccounts(sessionMobile.countryCode, sessionMobile.mobile);
  const account = accounts.find((candidate) =>
    candidate.id === accountId && canonicalProfileEditType(candidate.profileType) === profileType
  );
  if (!account) throw new ProfileEditError("This profile is not available for the current login.", 403);
  if (account.profileType === "user" || account.activationOnly || account.onboardingBeta) {
    throw new ProfileEditError("This profile type cannot be edited here.", 403);
  }
  return account;
}

async function loadProfile(account: ConnectAccount, profileType: ProfileEditProfileType) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const result = await supabaseAdmin
    .from(editTable(profileType))
    .select(profileType === "employee" ? employeeSelect : nonEmployeeSelect(profileType))
    .eq("id", account.id)
    .eq("company_id", account.companyId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as ProfileRow | null;
  if (!row) throw new ProfileEditError("Profile was not found.", 404);
  const status = String(
    profileType === "employee" ? row.profile_completion_status : row.onboarding_status
  ).trim().toLowerCase();
  if (status !== "active" || row.is_active !== true || row.deleted_at) {
    throw new ProfileEditError("Profile editing is available only for an active profile.", 409);
  }
  return row;
}

function authenticatedProfileMobile(profile: ProfileRow, session: ActiveSession) {
  const sessionMobile = parseSessionMobile(session.mobile_number, session.country_code);
  let profileCountryCode: string;
  try {
    profileCountryCode = normalizeSupportedCountryCode(profile.mobile_country_code ?? "91");
  } catch (error) {
    if (error instanceof ConnectMobileValidationError) throw new ProfileEditError(error.message, 409);
    throw error;
  }
  const profileMobileDigits = String(profile.mobile ?? "").replace(/\D/g, "");
  if (
    profileCountryCode !== sessionMobile.countryCode ||
    (profileMobileDigits !== sessionMobile.mobile && profileMobileDigits !== sessionMobile.localMobile)
  ) {
    throw new ProfileEditError("The current login no longer matches this profile. Sign in again.", 409);
  }
  return {
    sessionMobile,
    mobileCountryCode: profileCountryCode,
    mobileNumber: profileEditLocalMobile(profile.mobile, profileCountryCode, sessionMobile.mobile)
  };
}

export async function GET(request: Request) {
  try {
    const session = await activeSession();
    const url = new URL(request.url);
    const accountId = String(url.searchParams.get("accountId") ?? "").trim();
    const profileType = canonicalProfileEditType(url.searchParams.get("profileType"));
    if (!accountId || !profileType) throw new ProfileEditError("A supported profile is required.");
    const account = await authenticatedAccount(session, accountId, profileType);
    const profile = await loadProfile(account, profileType);
    const { mobileCountryCode, mobileNumber } = authenticatedProfileMobile(profile, session);
    return NextResponse.json({
      values: profileEditBootstrapValues(profile, profileType),
      mobileCountryCode,
      mobileNumber
    });
  } catch (error) {
    const status = error instanceof ProfileEditError ? error.status : 500;
    if (!(error instanceof ProfileEditError)) console.error("[connect/profile-edit] bootstrap failed", error);
    return NextResponse.json({
      error: error instanceof ProfileEditError ? error.message : "Unable to load profile details. Please try again."
    }, { status });
  }
}

async function loadEditFieldRules(
  account: ConnectAccount,
  profile: ProfileRow,
  profileType: ProfileEditProfileType
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const designation = profileType === "employee"
    ? profile.designation_id
      ? await supabaseAdmin
        .from("designations")
        .select("profile_field_rules")
        .eq("company_id", account.companyId)
        .eq("id", String(profile.designation_id))
        .maybeSingle()
      : null
    : profile.designation
      ? await supabaseAdmin
        .from("designations")
        .select("profile_field_rules")
        .eq("company_id", account.companyId)
        .eq("name", String(profile.designation))
        .maybeSingle()
      : null;
  if (designation?.error) throw new Error(designation.error.message);
  const category = profileType === "employee"
    ? "employees"
    : profileFieldRuleCategory(profileType as NonEmployeeProfileType);
  return (await loadWorkforceCategoryRules(
    account.companyId,
    category,
    designation?.data?.profile_field_rules,
    category
  )).dropx_one;
}

function ruleKeyForPayloadKey(key: string) {
  // State name is legacy employee data; its editable control is governed by
  // the same designation rule as the canonical state-code selector.
  return key === "state" ? "state_code" : key;
}

async function enforceEditFieldRules({
  account,
  profile,
  profileType,
  normalized,
  current
}: {
  account: ConnectAccount;
  profile: ProfileRow;
  profileType: ProfileEditProfileType;
  normalized: ProfileEditPayload;
  current: Record<string, unknown>;
}) {
  const rules = await loadEditFieldRules(account, profile, profileType);
  if (!rules.enabled.length && Object.keys(normalized).length) {
    throw new ProfileEditError("Profile fields are not configured for this designation. Contact an administrator.", 409);
  }
  const enabled = new Set(rules.enabled);
  for (const key of Object.keys(normalized)) {
    if (!enabled.has(ruleKeyForPayloadKey(key))) {
      throw new ProfileEditError(`This profile field is not enabled for editing: ${key}.`, 403);
    }
  }

  const finalValues: Record<string, unknown> = { ...current, ...normalized };
  const vehicleRegistration = String(finalValues.vehicle_reg_no ?? "").trim();
  const fuelType = vehicleRegistration
    ? await loadTrustedVehicleFuel({
      accountId: account.id,
      companyId: account.companyId,
      profileType,
      registrationNumber: vehicleRegistration
    })
    : "";
  const pureElectric = isPureElectricFuel(fuelType);
  if (pureElectric) {
    // A Pure EV never carries forward a stale PUCC expiry from its old vehicle.
    normalized.vehicle_pollution_exp_date = null;
    finalValues.vehicle_pollution_exp_date = null;
  }

  for (const key of rules.required) {
    if (!(key in finalValues)) continue; // Existing uploads are outside this JSON-only edit flow.
    if (key === "vehicle_pollution_exp_date" && pureElectric) continue;
    const value = finalValues[key];
    const present = typeof value === "boolean" ? true : String(value ?? "").trim().length > 0;
    if (!present) throw new ProfileEditError(`${key.replaceAll("_", " ")} is required.`);
  }
  return { pureElectric };
}

async function audit(row: EditRequestRow, eventCode: string, metadata: Record<string, unknown> = {}, leg?: "current" | "new") {
  if (!supabaseAdmin) return;
  const result = await supabaseAdmin.from("connect_profile_edit_audit").insert({
    request_id: row.id,
    company_id: row.company_id,
    account_id: row.account_id,
    profile_type: row.profile_type,
    login_session_id: row.login_session_id,
    event_code: eventCode,
    otp_leg: leg ?? null,
    metadata,
    request_ip: row.request_ip,
    user_agent: row.user_agent
  });
  if (result.error) throw new Error(result.error.message);
}

async function loadBoundRequest(requestId: string, session: ActiveSession) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const result = await supabaseAdmin
    .from("connect_profile_edit_requests")
    .select("*")
    .eq("id", requestId)
    .eq("login_session_id", session.id)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as EditRequestRow | null;
  if (!row) throw new ProfileEditError("Profile edit request was not found.", 404);
  if (new Date(row.request_expires_at).getTime() <= Date.now()) {
    await supabaseAdmin.from("connect_profile_edit_requests")
      .update({
        status: "expired",
        payload: {},
        before_values: {},
        current_mobile_country_code: "",
        current_mobile_value: "",
        current_mobile_number: "",
        new_mobile_country_code: "",
        new_mobile_value: "",
        new_mobile_number: "",
        current_otp_hmac: null,
        new_otp_hmac: null,
        redacted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", row.id)
      .in("status", ["created", "pending_current", "pending_new", "verified"]);
    throw new ProfileEditError("Profile edit verification expired. Start again.", 410);
  }
  return row;
}

async function reserveAndSendOtp(row: EditRequestRow, leg: "current" | "new") {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const isCurrent = leg === "current";
  const status = isCurrent ? "pending_current" : "pending_new";
  const sentAt = isCurrent ? row.current_otp_sent_at : row.new_otp_sent_at;
  const sendCount = isCurrent ? row.current_otp_send_count : row.new_otp_send_count;
  if (row.status !== (isCurrent && row.status === "created" ? "created" : status)) {
    throw new ProfileEditError("This OTP step is no longer pending.", 409);
  }
  if (!isCurrent && (!row.mobile_changed || !row.current_otp_verified_at)) {
    throw new ProfileEditError("Verify the current mobile number first.", 409);
  }
  if (sendCount >= MAX_OTP_SENDS_PER_LEG) {
    throw new ProfileEditError("OTP resend limit reached. Start the profile edit again.", 429);
  }
  const elapsed = sentAt ? (Date.now() - new Date(sentAt).getTime()) / 1_000 : Infinity;
  if (elapsed < OTP_RESEND_COOLDOWN_SECONDS) {
    throw new ProfileEditError(
      `Wait ${Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsed)} seconds before resending OTP.`,
      429
    );
  }

  const otp = generateOtp();
  const hmac = createProfileEditOtpHmac({ requestId: row.id, leg, otp, secret: profileEditOtpSecret() });
  const now = new Date();
  const provisionalExpiry = new Date(now.getTime() + 10 * 60_000);
  const update = isCurrent
    ? {
        status,
        current_otp_hmac: hmac,
        current_otp_expires_at: provisionalExpiry.toISOString(),
        current_otp_sent_at: now.toISOString(),
        current_otp_send_count: sendCount + 1,
        updated_at: now.toISOString()
      }
    : {
        status,
        new_otp_hmac: hmac,
        new_otp_expires_at: provisionalExpiry.toISOString(),
        new_otp_sent_at: now.toISOString(),
        new_otp_send_count: sendCount + 1,
        updated_at: now.toISOString()
      };
  const reservation = await supabaseAdmin
    .from("connect_profile_edit_requests")
    .update(update)
    .eq("id", row.id)
    .eq("status", row.status)
    .eq(isCurrent ? "current_otp_send_count" : "new_otp_send_count", sendCount)
    .select("*")
    .maybeSingle();
  if (reservation.error) throw new Error(reservation.error.message);
  if (!reservation.data) throw new ProfileEditError("Another OTP request is already in progress.", 409);
  const reserved = reservation.data as EditRequestRow;

  const hmacColumn = isCurrent ? "current_otp_hmac" : "new_otp_hmac";
  const expiryColumn = isCurrent ? "current_otp_expires_at" : "new_otp_expires_at";
  const sentAtColumn = isCurrent ? "current_otp_sent_at" : "new_otp_sent_at";
  const sendCountColumn = isCurrent ? "current_otp_send_count" : "new_otp_send_count";
  let provider: Awaited<ReturnType<typeof sendCompanyConnectOtp>>;
  try {
    provider = await sendCompanyConnectOtp({
      companyId: row.company_id,
      to: isCurrent ? row.current_mobile_number : row.new_mobile_number,
      otp
    });
  } catch {
    // Persist only a bounded outcome code. Provider errors can contain request
    // bodies, credentials, or upstream diagnostics and must never enter the
    // long-lived profile-edit row or audit stream.
    const failedUpdate = isCurrent
      ? {
          current_otp_hmac: null,
          current_otp_expires_at: null,
          current_otp_sent_at: null,
          status: row.status === "created" ? "failed" : "pending_current",
          ...(row.status === "created" ? {
            payload: {},
            before_values: {},
            current_mobile_country_code: "",
            current_mobile_value: "",
            current_mobile_number: "",
            new_mobile_country_code: "",
            new_mobile_value: "",
            new_mobile_number: "",
            redacted_at: new Date().toISOString()
          } : {}),
          current_provider_metadata: { outcome: "otp_provider_request_failed" },
          updated_at: new Date().toISOString()
        }
      : {
          new_otp_hmac: null,
          new_otp_expires_at: null,
          new_otp_sent_at: null,
          status: "pending_new",
          new_provider_metadata: { outcome: "otp_provider_request_failed" },
          updated_at: new Date().toISOString()
        };
    const failed = await supabaseAdmin
      .from("connect_profile_edit_requests")
      .update(failedUpdate)
      .eq("id", row.id)
      .eq("status", status)
      .eq(hmacColumn, hmac)
      .eq(expiryColumn, provisionalExpiry.toISOString())
      .eq(sentAtColumn, now.toISOString())
      .eq(sendCountColumn, sendCount + 1)
      .select("id")
      .maybeSingle();
    if (failed.error) throw new Error(failed.error.message);
    if (failed.data && isCurrent && row.status === "created") {
      await supabaseAdmin.from("connect_profile_edit_verifications").delete().eq("request_id", row.id);
    }
    if (failed.data) await audit(reserved, "otp_send_failed", {}, leg).catch(() => undefined);
    if (!failed.data) {
      throw new ProfileEditError("This OTP request was replaced. Use the newest code.", 409);
    }
    throw new ProfileEditError("Unable to send WhatsApp OTP. Please try again.", 502);
  }

  const expiresAt = new Date(Math.min(
    Date.now() + provider.expiryMinutes * 60_000,
    new Date(row.request_expires_at).getTime()
  )).toISOString();
  const providerMetadata = {
    providerMessageId: provider.providerMessageId,
    whatsappProfileId: provider.whatsappProfileId,
    templateId: provider.templateId,
    templateName: provider.templateName,
    templateLanguage: provider.templateLanguage
  };
  const sentUpdate = isCurrent
    ? { current_otp_expires_at: expiresAt, current_provider_metadata: providerMetadata, updated_at: new Date().toISOString() }
    : { new_otp_expires_at: expiresAt, new_provider_metadata: providerMetadata, updated_at: new Date().toISOString() };
  const saved = await supabaseAdmin
    .from("connect_profile_edit_requests")
    .update(sentUpdate)
    .eq("id", row.id)
    .eq("status", status)
    .eq(hmacColumn, hmac)
    .eq(expiryColumn, provisionalExpiry.toISOString())
    .eq(sentAtColumn, now.toISOString())
    .eq(sendCountColumn, sendCount + 1)
    .select("id")
    .maybeSingle();
  if (saved.error) throw new Error(saved.error.message);
  if (!saved.data) {
    // The provider may already have accepted this code, but another request
    // replaced it before metadata was saved. Never overwrite the newer OTP.
    throw new ProfileEditError("This OTP request was replaced. Use the newest code.", 409);
  }
  await audit(reserved, "otp_sent", { sendCount: sendCount + 1 }, leg).catch(() => undefined);
  return { expiryMinutes: provider.expiryMinutes };
}

async function start(request: Request, body: Record<string, unknown>, session: ActiveSession) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const accountId = String(body.accountId ?? "").trim();
  const profileType = canonicalProfileEditType(body.profileType);
  if (!accountId || !profileType) throw new ProfileEditError("A supported profile is required.");
  const account = await authenticatedAccount(session, accountId, profileType);
  const profile = await loadProfile(account, profileType);
  if (!profile.updated_at) {
    throw new ProfileEditError("This profile cannot be edited until its update timestamp is repaired.", 409);
  }
  const { sessionMobile, mobileCountryCode, mobileNumber } = authenticatedProfileMobile(profile, session);
  // The authenticated session is the authoritative current OTP destination.
  // Profile tables legitimately contain either local or digit-only E.164 values.
  const currentMobile = sessionMobile;
  const targetMobile = parseSubmittedMobile(
    body.mobileNumber ?? mobileNumber,
    body.mobileCountryCode ?? mobileCountryCode
  );
  const mobileChanged = currentMobile.mobile !== targetMobile.mobile;
  const currentValues = currentPayloadValues(profile, profileType);
  let normalized: ProfileEditPayload;
  try {
    normalized = normalizeProfileEditPayload(body.payload, profileType);
  } catch (error) {
    throw new ProfileEditError(error instanceof Error ? error.message : "Invalid profile details.");
  }
  await enforceEditFieldRules({ account, profile, profileType, normalized, current: currentValues });
  const payload = changedProfileEditPayload(normalized, currentValues);
  if (!Object.keys(payload).length && !mobileChanged) {
    throw new ProfileEditError("No profile changes were found.");
  }

  const ip = requestIp(request);
  const otpSecret = profileEditOtpSecret();
  const currentMobileHash = profileEditMobileHash(currentMobile.mobile, otpSecret);
  const newMobileHash = profileEditMobileHash(targetMobile.mobile, otpSecret);
  const id = randomUUID();
  const requestExpiresAt = new Date(Date.now() + REQUEST_EXPIRY_MINUTES * 60_000).toISOString();
  const beforeValues = Object.fromEntries(Object.keys(payload).map((key) => [key, currentValues[key] ?? null]));
  const payloadHash = createHmac("sha256", otpSecret).update(JSON.stringify({
    payload: Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))),
    mobileCountryCode: targetMobile.countryCode,
    mobileNumber: targetMobile.mobile
  })).digest("hex");
  const reserved = await supabaseAdmin.rpc("connect_reserve_profile_edit_request", {
    p_request_id: id,
    p_company_id: account.companyId,
    p_account_id: account.id,
    p_profile_type: profileType,
    p_login_session_id: session.id,
    p_source_updated_at: String(profile.updated_at),
    p_identity_name_hash: identityNameHash(profile.full_name),
    p_current_mobile_country_code: String(profile.mobile_country_code ?? "91"),
    p_current_mobile_value: String(profile.mobile),
    p_current_mobile_number: currentMobile.mobile,
    p_current_mobile_hash: currentMobileHash,
    p_new_mobile_country_code: targetMobile.countryCode,
    p_new_mobile_value: targetMobile.localMobile,
    p_new_mobile_number: targetMobile.mobile,
    p_new_mobile_hash: newMobileHash,
    p_mobile_changed: mobileChanged,
    p_payload: payload,
    p_before_values: beforeValues,
    p_payload_hash: payloadHash,
    p_request_expires_at: requestExpiresAt,
    p_request_ip: ip,
    p_user_agent: request.headers.get("user-agent"),
    p_account_limit: MAX_STARTS_PER_ACCOUNT_PER_HOUR,
    p_target_limit: MAX_STARTS_PER_TARGET_PER_HOUR,
    p_ip_limit: MAX_STARTS_PER_IP_PER_HOUR
  });
  if (reserved.error) throw new Error(reserved.error.message);
  const reservation = reserved.data as {
    ok?: boolean;
    code?: string;
    request?: EditRequestRow;
  } | null;
  if (!reservation?.ok) {
    if (reservation?.code === "rate_limited") {
      throw new ProfileEditError("Too many profile edit OTP requests. Try again later.", 429);
    }
    if (reservation?.code === "target_unavailable") {
      throw new ProfileEditError(
        "This mobile number cannot be used for self-service profile editing. Contact an administrator.",
        409
      );
    }
    throw new Error("Profile edit request could not be reserved.");
  }
  if (!reservation.request) throw new Error("Reserved profile edit request was not returned.");
  const editRequest = reservation.request;
  await audit(editRequest, "started", {
    mobileChanged,
    changedFields: [...Object.keys(payload), ...(mobileChanged ? ["mobile"] : [])]
  });
  const sent = await reserveAndSendOtp(editRequest, "current");
  return NextResponse.json({
    ok: true,
    requestId: id,
    mobileChanged,
    currentMasked: maskProfileEditMobile(currentMobile.mobile),
    ...(mobileChanged ? { newMasked: maskProfileEditMobile(targetMobile.mobile) } : {}),
    expiresInMinutes: sent.expiryMinutes,
    nextLeg: "current"
  });
}

async function verify(body: Record<string, unknown>, session: ActiveSession) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const requestId = String(body.requestId ?? "").trim();
  const leg = body.leg === "new" ? "new" : body.leg === "current" ? "current" : null;
  const otp = String(body.otp ?? "").replace(/\D/g, "");
  if (!requestId || !leg) throw new ProfileEditError("OTP request and verification step are required.");
  if (!/^\d{6}$/.test(otp)) throw new ProfileEditError("Enter the 6 digit OTP.");
  const row = await loadBoundRequest(requestId, session);
  const isCurrent = leg === "current";
  if (
    row.status === "verified" &&
    row.current_otp_verified_at &&
    (!row.mobile_changed || row.new_otp_verified_at)
  ) {
    return NextResponse.json({ ok: true, verified: true, nextLeg: "commit" });
  }
  if (
    isCurrent &&
    row.mobile_changed &&
    row.current_otp_verified_at &&
    row.status === "pending_new"
  ) {
    const otpSent = Boolean(
      row.new_otp_hmac &&
      row.new_otp_expires_at &&
      new Date(row.new_otp_expires_at).getTime() > Date.now()
    );
    return NextResponse.json({
      ok: true,
      verified: true,
      nextLeg: "new",
      otpSent,
      newMasked: maskProfileEditMobile(row.new_mobile_number),
      ...(!otpSent ? { warning: "Current number is verified. Send a new-number OTP to continue." } : {})
    });
  }
  if (isCurrent && (row.status !== "pending_current" || row.current_otp_verified_at)) {
    throw new ProfileEditError("Current mobile OTP is no longer pending.", 409);
  }
  if (!isCurrent && (
    !row.mobile_changed || !row.current_otp_verified_at || row.status !== "pending_new" || row.new_otp_verified_at
  )) {
    throw new ProfileEditError("Verify the current mobile number before the new number.", 409);
  }
  const hmac = isCurrent ? row.current_otp_hmac : row.new_otp_hmac;
  const expiresAt = isCurrent ? row.current_otp_expires_at : row.new_otp_expires_at;
  const attempts = isCurrent ? row.current_otp_attempt_count : row.new_otp_attempt_count;
  const maxAttempts = isCurrent ? row.current_otp_max_attempts : row.new_otp_max_attempts;
  if (!hmac || !expiresAt) throw new ProfileEditError("OTP was not sent. Resend OTP.", 409);
  if (new Date(expiresAt).getTime() <= Date.now()) {
    throw new ProfileEditError("OTP expired. Resend OTP.", 410);
  }
  if (attempts >= maxAttempts) throw new ProfileEditError("Too many OTP attempts. Start again.", 429);
  const valid = verifyProfileEditOtpHmac({
    requestId: row.id,
    leg,
    otp,
    secret: profileEditOtpSecret(),
    expected: hmac
  });
  if (!valid) {
    const nextAttempts = attempts + 1;
    const failed = nextAttempts >= maxAttempts;
    const update = isCurrent
      ? {
          current_otp_attempt_count: nextAttempts,
          ...(failed ? {
            current_otp_hmac: null,
            status: "failed",
            payload: {},
            before_values: {},
            current_mobile_country_code: "",
            current_mobile_value: "",
            current_mobile_number: "",
            new_mobile_country_code: "",
            new_mobile_value: "",
            new_mobile_number: "",
            redacted_at: new Date().toISOString()
          } : {}),
          updated_at: new Date().toISOString()
        }
      : {
          new_otp_attempt_count: nextAttempts,
          ...(failed ? {
            new_otp_hmac: null,
            status: "failed",
            payload: {},
            before_values: {},
            current_mobile_country_code: "",
            current_mobile_value: "",
            current_mobile_number: "",
            new_mobile_country_code: "",
            new_mobile_value: "",
            new_mobile_number: "",
            redacted_at: new Date().toISOString()
          } : {}),
          updated_at: new Date().toISOString()
        };
    const changed = await supabaseAdmin.from("connect_profile_edit_requests")
      .update(update)
      .eq("id", row.id)
      .eq(isCurrent ? "current_otp_hmac" : "new_otp_hmac", hmac)
      .eq(isCurrent ? "current_otp_expires_at" : "new_otp_expires_at", expiresAt)
      .eq(isCurrent ? "current_otp_attempt_count" : "new_otp_attempt_count", attempts)
      .select("id")
      .maybeSingle();
    if (changed.error) throw new Error(changed.error.message);
    if (!changed.data) throw new ProfileEditError("OTP state changed. Try again.", 409);
    if (failed) await supabaseAdmin.from("connect_profile_edit_verifications").delete().eq("request_id", row.id);
    await audit(row, failed ? "otp_attempts_exhausted" : "otp_rejected", { attempt: nextAttempts }, leg);
    throw new ProfileEditError(failed ? "Too many OTP attempts. Start again." : "Invalid OTP.", failed ? 429 : 400);
  }

  const verifiedAt = new Date().toISOString();
  const nextStatus = isCurrent && row.mobile_changed ? "pending_new" : "verified";
  const update = isCurrent
    ? {
        current_otp_hmac: null,
        current_otp_verified_at: verifiedAt,
        current_otp_attempt_count: attempts + 1,
        status: nextStatus,
        updated_at: verifiedAt
      }
    : {
        new_otp_hmac: null,
        new_otp_verified_at: verifiedAt,
        new_otp_attempt_count: attempts + 1,
        status: "verified",
        updated_at: verifiedAt
      };
  const saved = await supabaseAdmin.from("connect_profile_edit_requests")
    .update(update)
    .eq("id", row.id)
    .eq("status", row.status)
    .eq(isCurrent ? "current_otp_hmac" : "new_otp_hmac", hmac)
    .eq(isCurrent ? "current_otp_expires_at" : "new_otp_expires_at", expiresAt)
    .eq(isCurrent ? "current_otp_attempt_count" : "new_otp_attempt_count", attempts)
    .select("*")
    .maybeSingle();
  if (saved.error) throw new Error(saved.error.message);
  if (!saved.data) throw new ProfileEditError("OTP state changed. Try again.", 409);
  const verifiedRow = saved.data as EditRequestRow;
  await audit(verifiedRow, "otp_verified", {}, leg);
  if (isCurrent && row.mobile_changed) {
    try {
      const sent = await reserveAndSendOtp(verifiedRow, "new");
      return NextResponse.json({
        ok: true,
        verified: true,
        nextLeg: "new",
        otpSent: true,
        newMasked: maskProfileEditMobile(row.new_mobile_number),
        expiresInMinutes: sent.expiryMinutes
      });
    } catch (error) {
      if (!(error instanceof ProfileEditError) || error.status !== 502) throw error;
      // Current-number ownership is already proven. Keep the durable request at
      // pending_new and let the user resend instead of trapping the UI on the
      // completed current-number step.
      return NextResponse.json({
        ok: true,
        verified: true,
        nextLeg: "new",
        otpSent: false,
        newMasked: maskProfileEditMobile(row.new_mobile_number),
        warning: "Current number verified, but the new-number OTP could not be sent. Tap resend."
      });
    }
  }
  return NextResponse.json({ ok: true, verified: true, nextLeg: "commit" });
}

async function resend(body: Record<string, unknown>, session: ActiveSession) {
  const requestId = String(body.requestId ?? "").trim();
  const leg = body.leg === "new" ? "new" : body.leg === "current" ? "current" : null;
  if (!requestId || !leg) throw new ProfileEditError("OTP request and verification step are required.");
  const row = await loadBoundRequest(requestId, session);
  if (leg === "current" && (row.status !== "pending_current" || row.current_otp_verified_at)) {
    throw new ProfileEditError("Current mobile verification is already complete.", 409);
  }
  if (leg === "new" && (row.status !== "pending_new" || !row.current_otp_verified_at || row.new_otp_verified_at)) {
    throw new ProfileEditError("New mobile OTP is not available yet.", 409);
  }
  const sent = await reserveAndSendOtp(row, leg);
  return NextResponse.json({
    ok: true,
    expiresInMinutes: sent.expiryMinutes,
    cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS
  });
}

async function commit(body: Record<string, unknown>, session: ActiveSession) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const requestId = String(body.requestId ?? "").trim();
  if (!requestId) throw new ProfileEditError("Profile edit request is required.");
  const row = await loadBoundRequest(requestId, session);
  if (row.status !== "verified") throw new ProfileEditError("Verify the required WhatsApp OTP before saving.", 409);
  const result = await supabaseAdmin.rpc("connect_commit_profile_edit", {
    p_request_id: row.id,
    p_login_session_id: session.id
  });
  if (result.error) throw new ProfileEditError(result.error.message, 400);
  const response = result.data as { ok?: boolean; sessionRevoked?: boolean; notice?: string } | null;
  if (!response?.ok) throw new Error("Profile edit could not be committed.");
  if (response.sessionRevoked) cookies().delete(connectSessionCookieName);
  return NextResponse.json({
    ok: true,
    sessionRevoked: response.sessionRevoked === true,
    notice: response.notice || "Profile saved successfully."
  });
}

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 64 * 1024) throw new ProfileEditError("Profile edit request is too large.", 413);
    if (!String(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      throw new ProfileEditError("Profile edits must be submitted as JSON.", 415);
    }
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ProfileEditError("Invalid profile edit request.");
    }
    const session = await activeSession();
    const action = String(body.action ?? "");
    // Global retention is handled by the authenticated hourly cron. Keep the
    // user request path bounded to this account and this edit request.
    if (action === "start") return start(request, body, session);
    if (action === "verify") return verify(body, session);
    if (action === "resend") return resend(body, session);
    if (action === "commit") return commit(body, session);
    throw new ProfileEditError("Unsupported profile edit action.");
  } catch (error) {
    const status = error instanceof ProfileEditError ? error.status : 500;
    if (!(error instanceof ProfileEditError)) console.error("[connect/profile-edit] request failed", error);
    return NextResponse.json({
      error: error instanceof ProfileEditError ? error.message : "Unable to update profile. Please try again."
    }, { status });
  }
}
