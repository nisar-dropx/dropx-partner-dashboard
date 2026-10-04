"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import * as XLSX from "xlsx";
import { isCompanyOwner, requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { currentAccessSurface } from "@/lib/access-surface";
import { syncBiometricEnrolment } from "@/lib/biometric/enrolments";
import { generateBiometricEnrolmentId } from "@/lib/biometric/ids";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { cleanCountryCode } from "@/lib/country-codes";
import { assertWorkerDesignationMappedToIdSeries, generateConfiguredBiometricId, generateConfiguredWorkerId } from "@/lib/dropx-id-generation";
import { requireDesignationOnboardingAccess } from "@/lib/designation-onboarding-access";
import { requireDesignationPortalAccess } from "@/lib/designation-portal-access";
import { assertDesignationRegister, targetRegisterForWorkforceRoute } from "@/lib/designation-register-routing";
import { moveProfileDocumentToTrash, uploadProfileDocument } from "@/lib/profile-document-storage";
import { saveProfileVerifications } from "@/lib/profile-verifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createAppNotification } from "@/lib/app-notifications";
import { assertOnboardingIdentityAllowed, evaluateOnboardingIdentity, identityExceptionEventMetadata } from "@/lib/onboarding-identity";
import { biometricBelongsToPeople, peopleIdentityForDualRole } from "@/lib/workforce-dual-role";
import { assertWorkforceContactsAvailable } from "@/lib/workforce-contact-availability";
import { dashboardDateInputValue } from "@/lib/date-format";
import { loadClientIdMappings, needsClientId, providerMappingFor, type ClientIdWorker } from "@/lib/workforce-client-id-queue";
import { loadClientIdPartnerStates } from "@/lib/workforce-client-id-partner";
import { callWorkforceAmazonWorker } from "@/lib/workforce-amazon-worker";
import { loadWorkforceCategoryDirectActivate, loadWorkforceCategoryRules } from "@/lib/workforce-category-rules";
import { loadOpsWorkforceLocations } from "@/lib/ops-workforce-locations";
import { workforceStationPolicy, workforceStationEmailError } from "@/lib/workforce-register-policy";
import { filterOnboardingLocations } from "@/lib/onboarding-location-access";
import { sendFieldExecutiveOnboardingWhatsApp } from "@/lib/whatsapp";
import {
  nonEmployeeConfigForRoute,
  type NonEmployeeRoute
} from "@/lib/workforce-profiles";

function required(value: FormDataEntryValue | null, field: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function optional(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

const onboardingSources = new Set(["recruit_portal", "referral", "walk_in", "agency", "other"]);

function onboardingSource(formData: FormData, fallback: string) {
  const source = optional(formData.get("onboarding_source"));
  if (!source) return { source: fallback, detail: null };
  if (!onboardingSources.has(source)) throw new Error("Choose a valid onboarding source.");
  const detail = optional(formData.get("onboarding_source_detail"));
  if (detail && detail.length > 160) throw new Error("Onboarding source detail must be 160 characters or fewer.");
  if (source === "other" && !detail) throw new Error("Add a short detail when the onboarding source is Other.");
  return { source, detail };
}

async function scopedWorkforceLocationIds(companyId: string, authorization: AuthorizationContext) {
  if (currentAccessSurface() === "ops") return new Set((await loadOpsWorkforceLocations(companyId, authorization)).map(location => location.id));
  if (authorization.hasAllLocationAccess || !supabaseAdmin) return null;
  const locations = await supabaseAdmin
    .from("stations")
    .select("id, hide_from_location_list, parent_station_id")
    .eq("company_id", companyId)
    .limit(500);
  if (locations.error) throw new Error(locations.error.message);
  return new Set(filterOnboardingLocations(locations.data ?? [], authorization).map((location) => location.id));
}

function normalizeFullName(value: FormDataEntryValue | null) {
  const text = required(value, "Full name")
    .replace(/[^A-Za-z ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  if (!text || !/^[A-Z]+(?: [A-Z]+)*$/.test(text)) {
    throw new Error("Full name can contain only letters and spaces.");
  }
  return text;
}

function normalizeEmail(value: FormDataEntryValue | null) {
  const email = required(value, "Email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  return email;
}

function normalizeMobileNumber(value: FormDataEntryValue | null) {
  const mobile = required(value, "Mobile number").replace(/\D/g, "");
  if (!/^\d{10}$/.test(mobile)) {
    throw new Error("Mobile number must be exactly 10 digits.");
  }
  return mobile;
}

type FieldExecutiveReturnPath = NonEmployeeRoute;

function safeReturnPath(formData?: FormData): FieldExecutiveReturnPath {
  return nonEmployeeConfigForRoute(formData?.get("return_path")).route;
}

function pageCodeForReturnPath(returnPath: FieldExecutiveReturnPath) {
  return nonEmployeeConfigForRoute(returnPath).pageCode;
}

function entityLabelForReturnPath(returnPath: FieldExecutiveReturnPath) {
  return nonEmployeeConfigForRoute(returnPath).label;
}

function tableForReturnPath(returnPath: FieldExecutiveReturnPath) {
  return nonEmployeeConfigForRoute(returnPath).table;
}

function fieldExecutiveRedirect(params?: Record<string, string>, returnPath: FieldExecutiveReturnPath = "/workforce"): never {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  redirect(`${returnPath}${query}`);
}

function addFormParams(formData: FormData) {
  return {
    full_name: String(formData.get("full_name") ?? "").replace(/[^A-Za-z ]+/g, "").replace(/\s+/g, " ").trim().toUpperCase(),
    mobile_country_code: cleanCountryCode(formData.get("mobile_country_code")),
    mobile: String(formData.get("mobile") ?? "").replace(/\D/g, ""),
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    date_of_join: String(formData.get("date_of_join") ?? ""),
    reported_on: String(formData.get("reported_on") ?? ""),
    location_id: String(formData.get("location_id") ?? ""),
    designation: String(formData.get("designation") ?? ""),
    onboarding_source: String(formData.get("onboarding_source") ?? ""),
    onboarding_source_detail: String(formData.get("onboarding_source_detail") ?? "")
  };
}

function friendlyFieldExecutiveError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("operation_mode_id")) {
    return "Database migration pending: remove operation_mode_id from workforce in Supabase.";
  }
  return message;
}

function isNextRedirectError(error: unknown) {
  return typeof (error as { digest?: unknown })?.digest === "string" &&
    String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
}

function generatedDropxId(category: "field_executive" | "contractor" | "vendor" | "worker") {
  const prefix = category === "field_executive"
    ? "FE"
    : category === "contractor"
      ? "IC"
      : category === "vendor"
        ? "VEN"
        : "WRK";
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

/** Canonical Workforce rows must self-identify; DB rejects null source_profile_type. */
function workforceIdentityFields() {
  const id = randomUUID();
  return {
    id,
    source_profile_type: "canonical" as const,
    source_profile_id: id,
    compatibility_mode: false,
    migration_state: "canonical",
    synced_at: new Date().toISOString()
  };
}

const fieldExecutiveDocumentFields = [
  { ruleKey: "aadhaar_front", formKey: "aadhaar_front_file", pathKey: "aadhaar_front_path", label: "Aadhaar front" },
  { ruleKey: "aadhaar_back", formKey: "aadhaar_back_file", pathKey: "aadhaar_back_path", label: "Aadhaar back" },
  { ruleKey: "pan_upload", formKey: "pan_upload_file", pathKey: "pan_upload_path", label: "PAN upload" },
  { ruleKey: "dl_front", formKey: "dl_front_file", pathKey: "dl_front_path", label: "DL front" },
  { ruleKey: "dl_back", formKey: "dl_back_file", pathKey: "dl_back_path", label: "DL back" },
  { ruleKey: "profile_photo", formKey: "profile_photo_file", pathKey: "profile_photo_path", label: "Profile photo" }
] as const;

function normalizeFieldExecutivePayload(formData: FormData, requireId = false) {
  const id = requireId ? required(formData.get("id"), "Field executive") : null;
  const fullName = normalizeFullName(formData.get("full_name"));
  const mobileCountryCode = cleanCountryCode(formData.get("mobile_country_code"));
  const mobile = normalizeMobileNumber(formData.get("mobile"));
  const email = normalizeEmail(formData.get("email"));
  const dateOfJoin = required(formData.get("date_of_join"), "Date of join");
  const locationId = required(formData.get("location_id"), "Location");
  const designation = required(formData.get("designation"), "Designation");
  const gender = optional(formData.get("gender"));
  const dateOfBirth = optional(formData.get("date_of_birth"));
  const aadhaarNumber = optional(formData.get("aadhaar_number"))?.replace(/\D/g, "") ?? null;
  const panNumber = optional(formData.get("pan_number"))?.toUpperCase() ?? null;
  const eshramUan = optional(formData.get("eshram_uan"))?.replace(/\D/g, "") ?? null;
  const address = optional(formData.get("address"));
  const postalPin = optional(formData.get("postal_pin"))?.replace(/\D/g, "") ?? null;
  const landmark = optional(formData.get("landmark"));
  const stateCode = optional(formData.get("state_code"));
  const fatherName = optional(formData.get("father_name"));
  const bloodGroup = optional(formData.get("blood_group"));
  const isHandicappedValue = optional(formData.get("is_handicapped"));
  const isHandicapped = isHandicappedValue === null ? null : isHandicappedValue === "true";
  const bankAccountNo = optional(formData.get("bank_account_no"))?.toUpperCase() ?? null;
  const ifscCode = optional(formData.get("ifsc_code"))?.toUpperCase() ?? null;
  const pfUan = optional(formData.get("pf_uan"))?.replace(/\D/g, "") ?? null;
  const pfAccountNo = optional(formData.get("pf_account_no"))?.toUpperCase() ?? null;
  const esiNo = optional(formData.get("esi_no"))?.toUpperCase() ?? null;
  const drivingLicenseNo = optional(formData.get("driving_license_no"))?.toUpperCase() ?? null;
  const drivingLicenseExpDate = optional(formData.get("driving_license_exp_date"));
  const vehicleRegNo = optional(formData.get("vehicle_reg_no"))?.toUpperCase() ?? null;
  const vehicleRegExpDate = optional(formData.get("vehicle_reg_exp_date"));
  const vehicleInsuranceExpDate = optional(formData.get("vehicle_insurance_exp_date"));
  const vehiclePollutionExpDate = optional(formData.get("vehicle_pollution_exp_date"));
  const biometricId = optional(formData.get("biometric_id"));
  const emergencyContactName = optional(formData.get("emergency_contact_name"));
  const emergencyContactNumber = optional(formData.get("emergency_contact_number"))?.replace(/\D/g, "") ?? null;
  const emergencyContactRelation = optional(formData.get("emergency_contact_relation"));
  const isActive = optional(formData.get("is_active")) !== "false";
  const statutoryApplicability = formData.getAll("statutory_applicability").map(String).filter(Boolean);

  if (biometricId && !/^\d{1,20}$/.test(biometricId)) throw new Error("Biometric enrolment ID must be numeric.");
  if (emergencyContactNumber && !/^\d{10}$/.test(emergencyContactNumber)) throw new Error("Emergency contact number must contain exactly 10 digits.");
  if (aadhaarNumber && !/^\d{12}$/.test(aadhaarNumber)) throw new Error("Aadhaar number must contain exactly 12 digits.");
  if (postalPin && !/^\d{6}$/.test(postalPin)) throw new Error("Postal PIN must contain exactly 6 digits.");
  if (eshramUan && !/^\d{12}$/.test(eshramUan)) throw new Error("eShram UAN must contain exactly 12 digits.");
  if (panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber)) throw new Error("PAN number format is invalid.");
  if (ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) throw new Error("IFSC format is invalid.");
  if (bankAccountNo && !/^[A-Z0-9]+$/.test(bankAccountNo)) throw new Error("Bank account number can contain only letters and numbers.");
  if (pfUan && !/^\d{12}$/.test(pfUan)) throw new Error("PF UAN must contain exactly 12 digits.");
  if (pfAccountNo && !/^[A-Z0-9]+$/.test(pfAccountNo)) throw new Error("PF Account No can contain only letters and numbers.");
  if (esiNo && !/^[A-Z0-9]+$/.test(esiNo)) throw new Error("ESI No can contain only letters and numbers.");

  [
    ["Date of join", dateOfJoin],
    ["Date of birth", dateOfBirth],
    ["Driving license expiry date", drivingLicenseExpDate],
    ["Vehicle registration expiry date", vehicleRegExpDate],
    ["Vehicle Insurance expiry", vehicleInsuranceExpDate],
    ["Vehicle pollution expiry date", vehiclePollutionExpDate]
  ].forEach(([label, value]) => {
    if (value && Number.isNaN(Date.parse(value))) throw new Error(`Enter a valid ${String(label).toLowerCase()}.`);
  });

  return {
    id,
    payload: {
      full_name: fullName,
      mobile_country_code: mobileCountryCode,
      mobile,
      email,
      date_of_join: dateOfJoin,
      location_id: locationId,
      designation,
      gender,
      date_of_birth: dateOfBirth,
      aadhaar_number: aadhaarNumber,
      pan_number: panNumber,
      eshram_uan: eshramUan,
      address,
      postal_pin: postalPin,
      landmark,
      state_code: stateCode,
      father_name: fatherName,
      blood_group: bloodGroup,
      is_handicapped: isHandicapped,
      bank_account_no: bankAccountNo,
      ifsc_code: ifscCode,
      pf_uan: pfUan,
      pf_account_no: pfAccountNo,
      esi_no: esiNo,
      driving_license_no: drivingLicenseNo,
      driving_license_exp_date: drivingLicenseExpDate,
      vehicle_reg_no: vehicleRegNo,
      vehicle_reg_exp_date: vehicleRegExpDate,
      vehicle_insurance_exp_date: vehicleInsuranceExpDate,
      vehicle_pollution_exp_date: vehiclePollutionExpDate,
      biometric_id: biometricId,
      emergency_contact_name: emergencyContactName,
      emergency_contact_number: emergencyContactNumber,
      emergency_contact_relation: emergencyContactRelation,
      statutory_applicability: statutoryApplicability.length ? statutoryApplicability : ["not_applicable"],
      is_active: isActive
    }
  };
}

export async function createFieldExecutive(formData: FormData) {
  const returnPath = safeReturnPath(formData);
  const config = nonEmployeeConfigForRoute(returnPath);
  const table = config.table;
  const entityLabel = entityLabelForReturnPath(returnPath);
  const authorization = await requirePagePermission(pageCodeForReturnPath(returnPath), "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) fieldExecutiveRedirect({ error: "Supabase service role key is not configured." }, returnPath);
  let reportingNotice = "";
  const redirectTab = optional(formData.get("redirect_tab"));

  try {
    const fullName = normalizeFullName(formData.get("full_name"));
    const mobileCountryCode = cleanCountryCode(formData.get("mobile_country_code"));
    const mobile = normalizeMobileNumber(formData.get("mobile"));
    const email = normalizeEmail(formData.get("email"));
    const dateOfJoin = required(formData.get("date_of_join"), "Date of join");
    const reportedOn = optional(formData.get("reported_on"));
    const recruitmentLeadId = optional(formData.get("recruitment_lead_id"));
    const locationId = required(formData.get("location_id"), "Location");
    const designation = required(formData.get("designation"), "Designation");
    const configuredDirectActivate = await loadWorkforceCategoryDirectActivate(companyId, config.designationCategory);
    // Delivery-associate / field-executive profiles always pass through the HO
    // Workforce Lifecycle queue. Direct activation remains available only for
    // the other independently configured workforce categories.
    const directActivate = config.profileType !== "field_executive" && configuredDirectActivate;
    const directPayload = directActivate ? normalizeFieldExecutivePayload(formData).payload : null;
    const designationRuleResult = await supabaseAdmin.from("designations")
      .select("id, code, profile_field_rules, onboarding_role_ids, portal_permissions")
      .eq("company_id", companyId)
      .eq("name", designation)
      .eq("is_active", true)
      .maybeSingle();
    if (designationRuleResult.error) throw new Error(designationRuleResult.error.message);
    if (!designationRuleResult.data) throw new Error("Selected designation is not available.");
    await assertDesignationRegister({
      companyId,
      designationId: designationRuleResult.data.id,
      expectedTables: [targetRegisterForWorkforceRoute(returnPath)]
    });
    requireDesignationOnboardingAccess(designationRuleResult.data, authorization);
    const accessSurface = currentAccessSurface();
    requireDesignationPortalAccess(designationRuleResult.data, accessSurface, "add", { isOwner: accessSurface === "dashboard" && isCompanyOwner(authorization) });
    const dashboardRules = directActivate
      ? (await loadWorkforceCategoryRules(
        companyId,
        config.designationCategory
      )).dashboard
      : { enabled: [] as string[], required: [] as string[] };

    if (directPayload) {
      const payloadKeys: Record<string, keyof typeof directPayload> = {
        gender: "gender", date_of_birth: "date_of_birth", aadhaar_number: "aadhaar_number", pan_number: "pan_number",
        eshram_uan: "eshram_uan", father_name: "father_name", blood_group: "blood_group", is_handicapped: "is_handicapped",
        address: "address", state_code: "state_code", pincode: "postal_pin", landmark: "landmark",
        bank_account_no: "bank_account_no", ifsc: "ifsc_code", pf_uan: "pf_uan", pf_account_no: "pf_account_no",
        esi_no: "esi_no", driving_license_no: "driving_license_no", driving_license_exp_date: "driving_license_exp_date",
        vehicle_reg_no: "vehicle_reg_no", vehicle_reg_exp_date: "vehicle_reg_exp_date",
        vehicle_insurance_exp_date: "vehicle_insurance_exp_date", vehicle_pollution_exp_date: "vehicle_pollution_exp_date",
        emergency_contact_name: "emergency_contact_name", emergency_contact_number: "emergency_contact_number",
        emergency_contact_relation: "emergency_contact_relation"
      };
      for (const key of dashboardRules.required) {
        const documentField = fieldExecutiveDocumentFields.find((field) => field.ruleKey === key);
        if (documentField) {
          const file = formData.get(documentField.formKey);
          if (!(file instanceof File) || file.size === 0) throw new Error(`${documentField.label} is required.`);
          continue;
        }
        const payloadKey = payloadKeys[key];
        if (payloadKey && !String(directPayload[payloadKey] ?? "").trim()) throw new Error(`${key.replaceAll("_", " ")} is required.`);
      }
    }

    if (Number.isNaN(Date.parse(dateOfJoin))) throw new Error("Enter a valid date of join.");
    if (reportedOn && Number.isNaN(Date.parse(reportedOn))) throw new Error("Enter a valid training or reporting date.");
    const allowedLocationIds = await scopedWorkforceLocationIds(companyId, authorization);
    if (allowedLocationIds && !allowedLocationIds.has(locationId)) {
      throw new Error("You do not have access to the selected location.");
    }
    const { data: location, error: locationError } = await supabaseAdmin
      .from("stations")
      .select("id, station_code, is_active, hide_from_location_list, providers(name), location_models(code,name)")
      .eq("id", locationId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (locationError) throw new Error(locationError.message);
    if (!location) throw new Error("Selected location is not available for this company.");
    if (accessSurface === "ops") {
      if (!location.is_active || location.hide_from_location_list || workforceStationPolicy(location).excluded) throw new Error("This location is not available for workforce onboarding.");
      const emailError = workforceStationEmailError(email, location.station_code, workforceStationPolicy(location).requiresStationEmail);
      if (emailError) throw new Error(emailError);
    }
    if (recruitmentLeadId) {
      if (table !== "workforce") throw new Error("Recruit candidates can only be invited to the Workforce Register.");
      const leadResult = await supabaseAdmin.from("leads")
        .select("id, station_code, status")
        .eq("company_id", companyId)
        .eq("id", recruitmentLeadId)
        .is("archived_at", null)
        .maybeSingle();
      if (leadResult.error) throw new Error(leadResult.error.message);
      if (!leadResult.data) throw new Error("Recruit candidate was not found.");
      if (String(leadResult.data.status ?? "").toLowerCase() !== "interview_reported") {
        throw new Error("Mark the candidate as reported before sending the DropX ID invitation.");
      }
      if (String(leadResult.data.station_code ?? "").trim().toUpperCase() !== String(location.station_code ?? "").trim().toUpperCase()) {
        throw new Error("The selected location must match the candidate's Recruit station.");
      }
    }
    await assertWorkforceContactsAvailable({
      companyId,
      mobile,
      email,
      excludeRegister: table,
      allowDuplicateMobile: table === "workforce"
    });
    const identityEvaluation = await evaluateOnboardingIdentity({
      client: supabaseAdmin,
      companyId,
      mobile,
      designationId: designationRuleResult.data.id,
      designationName: designation
    });
    assertOnboardingIdentityAllowed(identityEvaluation, {
      allowDifferentWorkforceDesignation: table === "workforce",
      allowDuplicateMobile: table === "workforce"
    });
    // Second role for someone already in People (e.g. an SSA who also works as
    // a DA): the Workforce record reuses their People DropX ID and biometric ID.
    const peopleIdentity = table === "workforce" ? await peopleIdentityForDualRole(companyId, identityEvaluation) : null;
    const workerCategory = config.category;
    const biometricId = peopleIdentity?.biometricId ?? await generateConfiguredBiometricId({
      category: workerCategory,
      companyId,
      designationName: designation,
      fallback: () => generateBiometricEnrolmentId(companyId),
      locationId
    });
    if (biometricId && !/^\d{1,20}$/.test(biometricId)) throw new Error("Biometric enrolment ID must be numeric.");

    const dropxId = peopleIdentity?.dropxId ?? await generateConfiguredWorkerId({
      category: workerCategory,
      companyId,
      designationName: designation,
      fallback: () => generatedDropxId(workerCategory),
      locationId
    });
    const registrationToken = randomBytes(32).toString("base64url");
    const registrationTokenHash = createHash("sha256").update(registrationToken).digest("hex");
    const requestHost = headers().get("host")?.split(":")[0].toLowerCase() ?? "";
    const applicationSource = requestHost === "ops.dropxlogistics.com" || requestHost.startsWith("ops-")
      ? "ops"
      : "dashboard";
    const selectedOnboardingSource = onboardingSource(formData, applicationSource);
    const lifecyclePayload = config.profileType === "field_executive" ? {
      approval_required: true,
      onboarding_application_source: selectedOnboardingSource.source,
      onboarding_source_detail: selectedOnboardingSource.detail,
      onboarding_submitted_at: null,
      provider_id_status: "pending",
      lifecycle_status: "onboarding"
    } : {};
    const basePayload: Record<string, unknown> = withCompany({
      ...(directPayload ?? {}),
      ...lifecyclePayload,
      full_name: fullName,
      mobile_country_code: mobileCountryCode,
      mobile,
      email,
      date_of_join: dateOfJoin,
      location_id: locationId,
      designation,
      ...(table === "workforce" ? { designation_id: designationRuleResult.data.id, recruitment_lead_id: recruitmentLeadId, ...workforceIdentityFields() } : {}),
      biometric_id: biometricId,
      dropx_id: dropxId,
      created_by: authorization.userId,
      statutory_applicability: formData.getAll("statutory_applicability").map(String).filter(Boolean).length
        ? formData.getAll("statutory_applicability").map(String).filter(Boolean)
        : ["not_applicable"],
      is_active: config.profileType === "field_executive" ? false : true
    }, companyId);
    const executiveSelect = "id, stations (station_code, station_name, providers (name))";
    let insertResult = await supabaseAdmin.from(table).insert({
      ...basePayload,
      onboarding_token_hash: registrationTokenHash,
      onboarding_token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      onboarding_status: directActivate ? "active" : "pending"
    }).select(executiveSelect).single();

    const whatsappMigrationMissing = Boolean(insertResult.error?.message.toLowerCase().includes("onboarding_token"));
    if (whatsappMigrationMissing) {
      insertResult = await supabaseAdmin.from(table).insert(basePayload).select(executiveSelect).single();
    }
    const { data: executive, error } = insertResult;

    if (error) {
      const message = error.message.toLowerCase();
      if ((message.includes("unique") || message.includes("duplicate")) && !message.includes("mobile number")) {
        throw new Error("Field Executive ID is already registered.");
      }
      throw new Error(friendlyFieldExecutiveError(error.message));
    }


    if (directActivate) {
      const documentPayload: Record<string, string> = {};
      const enabled = new Set(dashboardRules.enabled);
      for (const field of fieldExecutiveDocumentFields) {
        if (!enabled.has(field.ruleKey)) continue;
        const uploaded = await uploadProfileDocument({
          companyId,
          documentKey: field.pathKey.replace("_path", ""),
          fileValue: formData.get(field.formKey),
          ownerId: executive.id,
          ownerType: config.profileType
        });
        if (uploaded) documentPayload[field.pathKey] = uploaded.storagePath;
      }
      if (Object.keys(documentPayload).length) {
        const documentUpdate = await supabaseAdmin.from(table).update(documentPayload).eq("id", executive.id).eq("company_id", companyId);
        if (documentUpdate.error) throw new Error(documentUpdate.error.message);
      }
    }

    if (config.profileType !== "field_executive" && !(peopleIdentity && await biometricBelongsToPeople(companyId, biometricId))) {
      await syncBiometricEnrolment({
        companyId,
        createdBy: authorization.userId,
        effectiveFrom: dateOfJoin,
        enrolmentId: biometricId,
        accountId: executive.id,
        isActive: true,
        locationId,
        profileType: config.profileType,
        workerType: "individual_contract"
      });
    }

    if (config.profileType === "field_executive") {
      await supabaseAdmin.from("workforce_onboarding_events").insert({
        company_id: companyId,
        field_executive_id: table === "workforce" ? null : executive.id,
        workforce_id: table === "workforce" ? executive.id : null,
        event_code: "onboarding_requested",
        from_status: null,
        to_status: "pending",
        actor_user_id: authorization.userId,
        source_portal: applicationSource,
        metadata: { designation, location_id: locationId, onboarding_source: selectedOnboardingSource.source, onboarding_source_detail: selectedOnboardingSource.detail, ...identityExceptionEventMetadata(identityEvaluation), ...(peopleIdentity ? { dual_role_people_profile: { source_type: peopleIdentity.sourceType, source_id: peopleIdentity.sourceId, designation: peopleIdentity.designation, shared_dropx_id: peopleIdentity.dropxId, shared_biometric_id: peopleIdentity.biometricId } } : {}) }
      });
      if (reportedOn && table === "workforce") {
        const progressResult = await supabaseAdmin.rpc("workforce_record_partner_progress", {
          p_company: companyId,
          p_actor: authorization.userId,
          p_workforce: executive.id,
          p_locations: authorization.hasAllLocationAccess ? null : authorization.locationScopeIds,
          p_reported: reportedOn,
          p_invited: null,
          p_portal: applicationSource === "ops" ? "ops_pulse" : "workforce"
        });
        if (progressResult.error) {
          // The associate was created successfully. Keep the invitation usable
          // even when the selected station has no partner workflow yet.
          reportingNotice = " The first reporting date could not be recorded because this station's partner workflow is not configured.";
        }
      }
      if (recruitmentLeadId && table === "workforce") {
        const acceptedAt = new Date().toISOString();
        const leadUpdate = await supabaseAdmin.from("leads").update({
          status: "registration_invited",
          final_status: "DropX ID pending",
          last_status_at: acceptedAt,
          last_updated_by: authorization.userId,
          updated_at: acceptedAt
        }).eq("company_id", companyId).eq("id", recruitmentLeadId);
        if (leadUpdate.error) throw new Error(leadUpdate.error.message);
        const handoffEvent = await supabaseAdmin.from("workforce_recruitment_events").insert({
          company_id: companyId,
          lead_id: recruitmentLeadId,
          workforce_id: executive.id,
          event_code: "dropx_id_invited",
          event_at: acceptedAt,
          actor_user_id: authorization.userId,
          metadata: { location_id: locationId, designation }
        });
        if (handoffEvent.error) throw new Error(handoffEvent.error.message);
      }
    }

    const stationRelation = executive.stations as unknown as { station_code?: string; station_name?: string | null; providers?: { name?: string } | Array<{ name?: string }> | null } | null;
    const providerRelation = Array.isArray(stationRelation?.providers) ? stationRelation?.providers[0] : stationRelation?.providers;
    if (!whatsappMigrationMissing && !directActivate) {
      waitUntil(sendFieldExecutiveOnboardingWhatsApp({
        companyId,
        fieldExecutiveId: executive.id,
        fullName,
        mobile: `${mobileCountryCode}${mobile}`,
        dropxId,
        biometricId: biometricId ?? "",
        workforceCategoryCode: config.designationCategory,
        dateOfJoin,
        locationCode: stationRelation?.station_code ?? "",
        locationName: stationRelation?.station_name ?? "",
        providerName: providerRelation?.name ?? "",
        registrationToken,
        triggeredBy: authorization.userId
      }));
    }

    revalidatePath(returnPath);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    fieldExecutiveRedirect({
      ...addFormParams(formData),
      error: error instanceof Error ? friendlyFieldExecutiveError(error.message) : "Unable to add field executive."
    }, returnPath);
  }

  fieldExecutiveRedirect({
    ...(redirectTab ? { tab: redirectTab } : {}),
    notice: config.profileType === "field_executive"
      ? `${entityLabel} onboarding request created. The applicant must submit the profile and agreement before HO activation.${reportingNotice}`
      : `${entityLabel} added successfully.`
  }, returnPath);
}

export async function updateFieldExecutive(formData: FormData) {
  const returnPath = safeReturnPath(formData);
  const config = nonEmployeeConfigForRoute(returnPath);
  const table = config.table;
  const entityLabel = entityLabelForReturnPath(returnPath);
  const authorization = await requirePagePermission(pageCodeForReturnPath(returnPath), "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) fieldExecutiveRedirect({ error: "Supabase service role key is not configured." }, returnPath);

  try {
    const { id, payload } = normalizeFieldExecutivePayload(formData, true);
    if (!id) throw new Error("Field executive is required.");
    const executiveId = id;
    const existingResult = await supabaseAdmin
      .from(table)
      .select("location_id, email, biometric_id, aadhaar_front_path, aadhaar_back_path, pan_upload_path, dl_front_path, dl_back_path, profile_photo_path")
      .eq("id", executiveId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (existingResult.error) throw new Error(existingResult.error.message);
    if (!existingResult.data) throw new Error("Associate was not found.");
    const allowedLocationIds = await scopedWorkforceLocationIds(companyId, authorization);
    if (allowedLocationIds && (!allowedLocationIds.has(existingResult.data.location_id) || !allowedLocationIds.has(payload.location_id))) throw new Error("Associate or selected location is outside your station scope.");
    payload.biometric_id = String((existingResult.data as { biometric_id?: string | null } | null)?.biometric_id ?? "").replace(/\D/g, "") || null;

    if (allowedLocationIds && !allowedLocationIds.has(payload.location_id)) {
      throw new Error("You do not have access to the selected location.");
    }
    const { data: location, error: locationError } = await supabaseAdmin
      .from("stations")
      .select("id, station_code, providers(name), location_models(code,name)")
      .eq("id", payload.location_id)
      .eq("company_id", companyId)
      .maybeSingle();
    if (locationError) throw new Error(locationError.message);
    if (!location) throw new Error("Selected location is not available for this company.");

    if (currentAccessSurface() === "ops" && (payload.email !== existingResult.data.email || payload.location_id !== existingResult.data.location_id)) {
      const emailError = workforceStationEmailError(payload.email, location.station_code, workforceStationPolicy(location).requiresStationEmail);
      if (emailError) throw new Error(emailError);
    }
    const designationResult = await supabaseAdmin
      .from("designations")
      .select("id, code, profile_field_rules, portal_permissions")
      .eq("company_id", companyId)
      .eq("name", payload.designation)
      .eq("is_active", true)
      .maybeSingle();
    if (designationResult.error) throw new Error(designationResult.error.message);
    if (!designationResult.data) throw new Error("Selected designation is not available.");
    if (table === "workforce") {
      await assertDesignationRegister({
        companyId,
        designationId: designationResult.data.id,
        expectedTables: [targetRegisterForWorkforceRoute(returnPath)]
      });
    }
    const accessSurface = currentAccessSurface();
    requireDesignationPortalAccess(designationResult.data, accessSurface, "edit", { isOwner: accessSurface === "dashboard" && isCompanyOwner(authorization) });
    const dashboardRules = (await loadWorkforceCategoryRules(
      companyId,
      config.designationCategory,
      designationResult.data?.profile_field_rules,
      config.designationCategory
    )).dashboard;
    const dashboardEnabled = new Set(dashboardRules.enabled);
    const profilePayloadKeys: Record<string, keyof typeof payload> = {
      gender: "gender",
      date_of_birth: "date_of_birth",
      aadhaar_number: "aadhaar_number",
      pan_number: "pan_number",
      eshram_uan: "eshram_uan",
      father_name: "father_name",
      blood_group: "blood_group",
      is_handicapped: "is_handicapped",
      address: "address",
      state_code: "state_code",
      pincode: "postal_pin",
      landmark: "landmark",
      bank_account_no: "bank_account_no",
      ifsc: "ifsc_code",
      pf_uan: "pf_uan",
      pf_account_no: "pf_account_no",
      esi_no: "esi_no",
      driving_license_no: "driving_license_no",
      driving_license_exp_date: "driving_license_exp_date",
      vehicle_reg_no: "vehicle_reg_no",
      vehicle_reg_exp_date: "vehicle_reg_exp_date",
      vehicle_insurance_exp_date: "vehicle_insurance_exp_date",
      vehicle_pollution_exp_date: "vehicle_pollution_exp_date",
      emergency_contact_name: "emergency_contact_name",
      emergency_contact_number: "emergency_contact_number",
      emergency_contact_relation: "emergency_contact_relation"
    };
    if (config.profileType !== "field_executive" && config.profileType !== "contractor") {
      for (const key of dashboardRules.required) {
        const payloadKey = profilePayloadKeys[key];
        if (payloadKey && !String(payload[payloadKey] ?? "").trim()) {
          throw new Error(`${key.replaceAll("_", " ")} is required.`);
        }
      }
    }
    const profilePayload = Object.fromEntries(
      dashboardRules.enabled
        .map((key) => profilePayloadKeys[key])
        .filter((key): key is keyof typeof payload => Boolean(key))
        .map((key) => [key, payload[key]])
    );
    await assertWorkforceContactsAvailable({
      companyId,
      mobile: payload.mobile,
      email: payload.email,
      excludeId: executiveId,
      excludeRegister: table,
      allowDuplicateMobile: table === "workforce"
    });
    const corePayload = {
      full_name: payload.full_name,
      mobile_country_code: payload.mobile_country_code,
      mobile: payload.mobile,
      email: payload.email,
      date_of_join: payload.date_of_join,
      location_id: payload.location_id,
      designation: payload.designation,
      ...(table === "workforce" ? { designation_id: designationResult.data.id } : {}),
      biometric_id: payload.biometric_id,
      is_active: payload.is_active,
      statutory_applicability: payload.statutory_applicability
    };

    const documentPayload: Record<string, string> = {};
    const existingPaths = existingResult.data as Record<string, string | null> | null;
    for (const field of fieldExecutiveDocumentFields) {
      if (!dashboardEnabled.has(field.ruleKey)) continue;
      const uploaded = await uploadProfileDocument({
        companyId,
        documentKey: field.pathKey.replace("_path", ""),
        fileValue: formData.get(field.formKey),
        ownerId: executiveId,
        ownerType: config.profileType
      });
      if (!uploaded) continue;
      const oldPath = existingPaths?.[field.pathKey] ?? null;
      if (oldPath) {
        await moveProfileDocumentToTrash({
          companyId,
          ownerId: executiveId,
          ownerType: config.profileType,
          documentLabel: field.label,
          fileName: oldPath.split("/").pop(),
          storagePath: oldPath,
          replacedBy: authorization.userId
        });
      }
      documentPayload[field.pathKey] = uploaded.storagePath;
    }

    const { error } = await supabaseAdmin
      .from(table)
      .update({
        ...corePayload,
        ...profilePayload,
        ...documentPayload,
        updated_at: new Date().toISOString()
      })
      .eq("id", executiveId)
      .eq("company_id", companyId);

    if (error) {
      const message = error.message.toLowerCase();
      if (message.includes("unique") || message.includes("duplicate")) {
        throw new Error("Field Executive ID is already registered.");
      }
      throw new Error(friendlyFieldExecutiveError(error.message));
    }

    await saveProfileVerifications({
      accountId: executiveId,
      companyId,
      profileType: config.profileType,
      values: formData.getAll("profile_verification_results")
    });

    await syncBiometricEnrolment({
      companyId,
      createdBy: authorization.userId,
      effectiveFrom: payload.date_of_join,
      enrolmentId: payload.biometric_id,
      accountId: executiveId,
      isActive: Boolean(payload.is_active),
      locationId: payload.location_id,
      profileType: config.profileType,
      workerType: "individual_contract"
    });

    revalidatePath(returnPath);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    fieldExecutiveRedirect({ edit: String(formData.get("id") ?? ""), error: error instanceof Error ? friendlyFieldExecutiveError(error.message) : "Unable to update field executive." }, returnPath);
  }

  fieldExecutiveRedirect({ notice: `${entityLabel} updated successfully.` }, returnPath);
}

export async function reviewFieldExecutiveProfile(formData: FormData) {
  const returnPath = safeReturnPath(formData);
  const table = tableForReturnPath(returnPath);
  const entityLabel = entityLabelForReturnPath(returnPath);
  const authorization = await requirePagePermission(pageCodeForReturnPath(returnPath), "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) fieldExecutiveRedirect({ error: "Supabase service role key is not configured." }, returnPath);

  if (nonEmployeeConfigForRoute(returnPath).profileType === "field_executive") {
    fieldExecutiveRedirect({
      error: "Delivery Associate activation is controlled in People → Workforce Lifecycle so the agreement, provider ID and HO checklist cannot be bypassed."
    }, returnPath);
  }

  const id = String(formData.get("id") ?? "").trim();
  const action = String(formData.get("review_action") ?? "").trim().toLowerCase();
  const remarks = String(formData.get("return_remarks") ?? "").trim();

  try {
    if (!id) throw new Error(`${entityLabel} is required.`);
    if (!["approve", "return"].includes(action)) throw new Error("Choose a valid review action.");
    if (action === "return" && !remarks) throw new Error("Return remarks are required.");

    const current = await supabaseAdmin
      .from(table)
      .select("onboarding_status, designation")
      .eq("id", id)
      .eq("company_id", companyId)
      .maybeSingle();
    if (current.error) throw new Error(current.error.message);
    if (!current.data) throw new Error(`${entityLabel} was not found.`);
    const reviewDesignation = await supabaseAdmin
      .from("designations")
      .select("portal_permissions")
      .eq("company_id", companyId)
      .eq("name", String(current.data.designation ?? ""))
      .eq("is_active", true)
      .maybeSingle();
    if (reviewDesignation.error) throw new Error(reviewDesignation.error.message);
    if (!reviewDesignation.data) throw new Error("Selected designation is not available.");
    const accessSurface = currentAccessSurface();
    requireDesignationPortalAccess(reviewDesignation.data, accessSurface, "edit", { isOwner: accessSurface === "dashboard" && isCompanyOwner(authorization) });
    if (String(current.data.onboarding_status ?? "").toLowerCase() !== "under_review") {
      throw new Error("Only profiles under review can be approved or returned.");
    }

    const reviewedAt = new Date().toISOString();
    // A Workforce second role for an existing person (e.g. an SSA also working
    // as a DA) needs its identity exception approved to activate.
    const exceptionFlag = action === "approve" && table === "workforce"
      ? await supabaseAdmin.from("workforce").select("identity_exception_required").eq("id", id).eq("company_id", companyId).maybeSingle()
      : null;
    const update = action === "approve"
      ? {
          onboarding_status: "active",
          profile_return_remarks: null,
          profile_returned_at: null,
          ...(exceptionFlag?.data?.identity_exception_required ? { identity_exception_approved_at: reviewedAt, identity_exception_approved_by: authorization.userId } : {}),
          updated_at: reviewedAt
        }
      : {
          onboarding_status: "returned",
          profile_return_remarks: remarks,
          profile_returned_at: reviewedAt,
          updated_at: reviewedAt
        };
    const result = await supabaseAdmin
      .from(table)
      .update(update)
      .eq("id", id)
      .eq("company_id", companyId);
    if (result.error) throw new Error(result.error.message);
    const profileType = nonEmployeeConfigForRoute(returnPath).profileType;
    await createAppNotification({
      accountId: id,
      companyId,
      data: action === "return" ? { remarks } : {},
      eventCode: action === "approve" ? "profile_approved" : "profile_returned",
      profileType,
      sourceKey: `${id}:${action}:${reviewedAt}`,
      variables: { remarks }
    });

    revalidatePath(returnPath);
    fieldExecutiveRedirect({
      notice: action === "approve"
        ? `${entityLabel} profile approved.`
        : `${entityLabel} profile returned for correction.`
    }, returnPath);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    fieldExecutiveRedirect({
      edit: id,
      error: error instanceof Error ? error.message : `Unable to review ${entityLabel.toLowerCase()} profile.`
    }, returnPath);
  }
}

type BulkImportRow = {
  dropxId: string | null;
  biometricId: string | null;
  fullName: string;
  mobileCountryCode: string;
  mobile: string;
  email: string;
  dateOfJoin: string;
  locationCode: string;
  designationCode: string;
};

function normalizeHeader(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function cellText(row: Record<string, unknown>, aliases: string[]) {
  const value = cellValue(row, aliases);
  return String(value ?? "").trim();
}

function cellValue(row: Record<string, unknown>, aliases: string[]) {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  const entry = Object.entries(row).find(([key]) => normalizedAliases.has(normalizeHeader(key)));
  return entry?.[1] ?? "";
}

function parseExcelDate(value: unknown, rowNumber: number) {
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      const date = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
      return date.toISOString().slice(0, 10);
    }
  }
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) throw new Error(`Row ${rowNumber}: Date of join must be DD/MM/YYYY.`);
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Row ${rowNumber}: Date of join is invalid.`);
  }
  return date.toISOString().slice(0, 10);
}

async function parseBulkWorkbook(fileValue: FormDataEntryValue | null) {
  if (!(fileValue instanceof File) || fileValue.size === 0) throw new Error("Choose an Excel file to upload.");
  const bytes = Buffer.from(await fileValue.arrayBuffer());
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The Excel file does not contain a worksheet.");
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (!rawRows.length) throw new Error("The Excel file does not contain any rows.");

  return rawRows.map((row, index) => {
    const rowNumber = index + 2;
    const fullName = cellText(row, ["Full name", "Full Name"]).replace(/[^A-Za-z ]+/g, "").replace(/\s+/g, " ").trim().toUpperCase();
    const mobile = cellText(row, ["Mob no", "Mobile", "Mobile number", "Mob number"]).replace(/\D/g, "");
    const locationCode = cellText(row, ["Location", "Location code"]).toUpperCase();
    const designationCode = cellText(row, ["Designation code", "Delisignation code", "Designation"]).toUpperCase();
    if (!fullName || !/^[A-Z]+(?: [A-Z]+)*$/.test(fullName)) throw new Error(`Row ${rowNumber}: Full name is required and must contain letters only.`);
    if (!/^\d{6,15}$/.test(mobile)) throw new Error(`Row ${rowNumber}: Mobile number must contain 6 to 15 digits.`);
    if (!locationCode) throw new Error(`Row ${rowNumber}: Location is required.`);
    if (!designationCode) throw new Error(`Row ${rowNumber}: Designation code is required.`);

    const biometricId = cellText(row, ["Biometric ID", "Biometric enrolment ID", "Bio ID"]).replace(/\D/g, "") || null;
    if (biometricId && !/^\d{1,20}$/.test(biometricId)) throw new Error(`Row ${rowNumber}: Biometric ID must be numeric.`);

    return {
      dropxId: cellText(row, ["Dropx ID", "DropX ID", "Field executive ID", "ID"]).toUpperCase() || null,
      biometricId,
      fullName,
      mobileCountryCode: cleanCountryCode(cellText(row, ["Mob country code", "Mobile country code", "Country code"]) || "91"),
      mobile,
      email: required(cellText(row, ["Email", "Email ID"]), `Row ${rowNumber}: Email`).toLowerCase(),
      dateOfJoin: parseExcelDate(cellValue(row, ["Date of join", "Date of join (DD/MM/YYYY)", "Date of join (DD/MM/YYY)", "DOJ"]), rowNumber),
      locationCode,
      designationCode
    } satisfies BulkImportRow;
  });
}

export async function bulkImportFieldExecutives(formData: FormData) {
  const returnPath = safeReturnPath(formData);
  const config = nonEmployeeConfigForRoute(returnPath);
  const table = config.table;
  const entityLabel = entityLabelForReturnPath(returnPath);
  const authorization = await requirePagePermission(pageCodeForReturnPath(returnPath), "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) fieldExecutiveRedirect({ error: "Supabase service role key is not configured." }, returnPath);
  const inserted: { id: string; locationId: string; biometricId: string | null; dateOfJoin: string; identityExceptionMetadata: Record<string, unknown> }[] = [];
  const requestHost = headers().get("host")?.split(":")[0].toLowerCase() ?? "";
  const applicationSource = requestHost === "ops.dropxlogistics.com" || requestHost.startsWith("ops-")
    ? "ops"
    : "dashboard";

  try {
    if (currentAccessSurface() === "ops") {
      throw new Error("Bulk workforce onboarding is not available in OpsPulse. Submit one onboarding request at a time.");
    }
    const rows = await parseBulkWorkbook(formData.get("bulk_file"));
    const explicitDropxIds = new Map<string, number>();
    for (const [index, row] of rows.entries()) {
      if (!row.dropxId) continue;
      const previousRow = explicitDropxIds.get(row.dropxId);
      if (previousRow) {
        throw new Error(`Rows ${previousRow} and ${index + 2}: DropX ID ${row.dropxId} is duplicated in the Excel file.`);
      }
      explicitDropxIds.set(row.dropxId, index + 2);
    }
    if (explicitDropxIds.size) {
      const existingIds = await supabaseAdmin
        .from(table)
        .select("dropx_id")
        .eq("company_id", companyId)
        .in("dropx_id", Array.from(explicitDropxIds.keys()));
      if (existingIds.error) throw new Error(existingIds.error.message);
      const existingId = String(existingIds.data?.[0]?.dropx_id ?? "");
      if (existingId) {
        throw new Error(`Row ${explicitDropxIds.get(existingId)}: DropX ID ${existingId} is already registered.`);
      }
    }

    const locationCodes = Array.from(new Set(rows.map((row) => row.locationCode)));
    const designationCodes = Array.from(new Set(rows.map((row) => row.designationCode)));
    const [locationsResult, designationsResult] = await Promise.all([
      supabaseAdmin.from("stations").select("id, station_code").eq("company_id", companyId).in("station_code", locationCodes),
      supabaseAdmin.from("designations").select("id, code, name, onboarding_categories, onboarding_role_ids, portal_permissions").eq("company_id", companyId).eq("is_active", true).in("code", designationCodes)
    ]);
    if (locationsResult.error) throw new Error(locationsResult.error.message);
    if (designationsResult.error) throw new Error(designationsResult.error.message);

    const locations = new Map((locationsResult.data ?? []).map((location) => [String(location.station_code).toUpperCase(), String(location.id)]));
    const designations = new Map((designationsResult.data ?? []).map((designation) => [String(designation.code).toUpperCase(), {
      id: String(designation.id),
      name: String(designation.name),
      onboarding_role_ids: designation.onboarding_role_ids,
      portal_permissions: designation.portal_permissions,
      workerCategory: config.category
    }]));

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      const locationId = locations.get(row.locationCode);
      const designation = designations.get(row.designationCode);
      if (!locationId) throw new Error(`Row ${rowNumber}: Location ${row.locationCode} not found.`);
      if (!designation) throw new Error(`Row ${rowNumber}: Designation code ${row.designationCode} not found.`);
      await assertDesignationRegister({
        companyId,
        designationId: designation.id,
        expectedTables: [targetRegisterForWorkforceRoute(returnPath)]
      });
      requireDesignationOnboardingAccess(designation, authorization);
      const accessSurface = currentAccessSurface();
      requireDesignationPortalAccess(designation, accessSurface, "add", { isOwner: accessSurface === "dashboard" && isCompanyOwner(authorization) });
      await assertWorkerDesignationMappedToIdSeries({ companyId, designationId: designation.id });
      if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(locationId)) {
        throw new Error(`Row ${rowNumber}: You do not have access to location ${row.locationCode}.`);
      }

      const identityEvaluation = await evaluateOnboardingIdentity({
        client: supabaseAdmin,
        companyId,
        mobile: row.mobile,
        designationId: designation.id,
        designationName: designation.name
      });
      try {
        assertOnboardingIdentityAllowed(identityEvaluation, {
          allowDifferentWorkforceDesignation: table === "workforce",
          allowDuplicateMobile: table === "workforce"
        });
      } catch (error) {
        throw new Error(`Row ${rowNumber}: ${error instanceof Error ? error.message : "Mobile identity conflict."}`);
      }

      const dropxId = row.dropxId || await generateConfiguredWorkerId({
        category: designation.workerCategory,
        companyId,
        designationId: designation.id,
        fallback: () => generatedDropxId(config.category),
        locationId
      });
      const biometricId = row.biometricId || await generateConfiguredBiometricId({
        category: designation.workerCategory,
        companyId,
        designationId: designation.id,
        fallback: () => generateBiometricEnrolmentId(companyId),
        locationId
      });

      const insertResult = await supabaseAdmin.from(table).insert(withCompany({
        dropx_id: dropxId,
        biometric_id: biometricId,
        full_name: row.fullName,
        mobile_country_code: row.mobileCountryCode,
        mobile: row.mobile,
        email: row.email,
        date_of_join: row.dateOfJoin,
        location_id: locationId,
        designation: designation.name,
        ...(table === "workforce" ? { designation_id: designation.id, ...workforceIdentityFields() } : {}),
        created_by: authorization.userId,
        onboarding_status: "pending",
        ...(config.profileType === "field_executive" ? {
          approval_required: true,
          onboarding_application_source: applicationSource,
          provider_id_status: "pending",
          lifecycle_status: "onboarding"
        } : {}),
        is_active: config.profileType === "field_executive" ? false : true
      }, companyId)).select("id").single();
      if (insertResult.error) throw new Error(`Row ${rowNumber}: ${friendlyFieldExecutiveError(insertResult.error.message)}`);
      inserted.push({ id: insertResult.data.id, locationId, biometricId, dateOfJoin: row.dateOfJoin, identityExceptionMetadata: identityExceptionEventMetadata(identityEvaluation) });
    }

    for (const row of inserted) {
      if (config.profileType === "field_executive") {
        await supabaseAdmin.from("workforce_onboarding_events").insert({
          company_id: companyId,
          field_executive_id: table === "workforce" ? null : row.id,
          workforce_id: table === "workforce" ? row.id : null,
          event_code: "onboarding_requested",
          to_status: "pending",
          actor_user_id: authorization.userId,
          source_portal: applicationSource,
          metadata: { bulk_import: true, location_id: row.locationId, ...row.identityExceptionMetadata }
        });
        continue;
      }
      await syncBiometricEnrolment({
        companyId,
        createdBy: authorization.userId,
        effectiveFrom: row.dateOfJoin,
        enrolmentId: row.biometricId,
        accountId: row.id,
        isActive: true,
        locationId: row.locationId,
        profileType: config.profileType,
        workerType: "individual_contract"
      });
    }

    revalidatePath(returnPath);
    fieldExecutiveRedirect({
      notice: config.profileType === "field_executive"
        ? `${inserted.length} workforce onboarding requests imported. Activation remains pending candidate submission and HO approval.`
        : `${inserted.length} ${entityLabel.toLowerCase()} records imported successfully.`
    }, returnPath);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    if (inserted.length) {
      const insertedIds = inserted.map((row) => row.id);
      await supabaseAdmin.from("biometric_enrolments").delete().in("field_executive_id", insertedIds);
      await supabaseAdmin.from(table).delete().eq("company_id", companyId).in("id", insertedIds);
    }
    fieldExecutiveRedirect({ error: error instanceof Error ? friendlyFieldExecutiveError(error.message) : "Unable to import field executives." }, returnPath);
  }
}

export async function queueAmazonInvitationFromOpsPulse(formData: FormData) {
  const authorization = await requirePagePermission("delivery_associates", "edit");
  const requestedStatus = String(formData.get("return_status") ?? "").trim().toLowerCase();
  const destination = formData.get("return_path") ? `${safeReturnPath(formData)}?` : `/work-force-register?tab=${["interviews", "dropx-id", "amazon-id", "da-onboarding", "mapping", "attention"].includes(requestedStatus) ? requestedStatus : "amazon-id"}`;
  try {
    if (authorization.readOnly || !supabaseAdmin) throw new Error("Amazon invitation queue is unavailable.");
    const companyId = requireCompanyId(authorization);
    const allowedLocationIds = await scopedWorkforceLocationIds(companyId, authorization);
    const workforceId = required(formData.get("workforce_id"), "Associate");
    const workforce = await supabaseAdmin.from("workforce")
      .select("id,email,full_name,source_profile_type,source_profile_id,lifecycle_status,migration_state,location_id,onboarding_status,stations(station_code,provider_id),designations(provider_mapping_required)")
      .eq("company_id", companyId)
      .eq("id", workforceId)
      .is("deleted_at", null)
      .maybeSingle();
    if (workforce.error) throw new Error(workforce.error.message);
    if (!workforce.data) throw new Error("Associate was not found.");
    if (allowedLocationIds && !allowedLocationIds.has(workforce.data.location_id)) {
      throw new Error("Associate is outside your station scope.");
    }
    if (!["under_review", "approved", "active"].includes(String(workforce.data.onboarding_status ?? ""))) {
      throw new Error("Complete registration before creating the partner ID.");
    }
    const clientWorker = workforce.data as unknown as ClientIdWorker;
    if (!needsClientId(clientWorker)) {
      throw new Error("This associate does not require a client ID invitation under the current master or lifecycle status.");
    }
    const mapping = providerMappingFor(clientWorker, await loadClientIdMappings(supabaseAdmin, companyId), dashboardDateInputValue());
    if (mapping.current) {
      revalidatePath("/work-force-register");
      redirect(`/work-force-register?tab=amazon-id&notice=${encodeURIComponent("This associate already has a valid provider ID mapping in Dashboard. No invitation is needed.")}`);
    }
    if (mapping.known) {
      throw new Error("This associate already has a provider ID. Review its station and effective dates in Dashboard mapping before requesting another invitation.");
    }
    const existingPartner = (await loadClientIdPartnerStates(supabaseAdmin, companyId, [workforceId])).get(workforceId);
    if (existingPartner) {
      revalidatePath("/work-force-register");
      const tab = existingPartner.queue === "mapping" ? "mapping" : existingPartner.queue === "progress" ? "da-onboarding" : "attention";
      redirect(`/work-force-register?tab=${tab}&notice=${encodeURIComponent(existingPartner.instruction)}`);
    }
    const latest = await supabaseAdmin.from("workforce_amazon_invitation_requests")
      .select("id,status")
      .eq("company_id", companyId)
      .eq("workforce_id", workforceId)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest.error) throw new Error(latest.error.message);
    let requestId = latest.data?.id ?? null;
    if (latest.data?.status === "failed") {
      const retried = await supabaseAdmin.rpc("workforce_retry_amazon_invitation", {
        p_company: companyId,
        p_actor: authorization.userId,
        p_request: latest.data.id,
        p_locations: allowedLocationIds ? [...allowedLocationIds] : null
      });
      if (retried.error) throw new Error(retried.error.message);
    }
    if (latest.data?.status === "sent") {
      redirect(`${destination}&notice=${encodeURIComponent(`Amazon ID invitation is already ${latest.data.status}.`)}`);
    }
    if (latest.data?.status === "processing") {
      redirect(`${destination}&notice=${encodeURIComponent("Amazon LSC invitation is already being processed.")}`);
    }
    if (!requestId) {
      const queued = await supabaseAdmin.rpc("workforce_queue_amazon_invitation", {
        p_company: companyId,
        p_actor: authorization.userId,
        p_actor_name: authorization.fullName || authorization.email || "OpsPulse",
        p_workforce: workforceId,
        p_email: workforce.data.email,
        p_source_portal: "ops_pulse",
        p_locations: allowedLocationIds ? [...allowedLocationIds] : null
      });
      if (queued.error) throw new Error(queued.error.message);
      requestId = String(queued.data);
    }
    console.info("[workforce-amazon-invite] queued", {
      companyId,
      requestId,
      stationId: workforce.data.location_id,
      workforceId
    });

    await callWorkforceAmazonWorker<{ processed: number }>("/api/admin/amazon/invitation/tick", {
      method: "POST",
      body: "{}"
    });
    const completed = await supabaseAdmin.from("workforce_amazon_invitation_requests")
      .select("status,external_reference,error_message")
      .eq("company_id", companyId)
      .eq("id", requestId)
      .maybeSingle();
    if (completed.error) throw new Error(completed.error.message);
    if (completed.data?.status === "failed") {
      throw new Error(completed.data.error_message || "Amazon LSC rejected the invitation.");
    }
    revalidatePath("/work-force-register");
    const notice = completed.data?.status === "sent"
      ? `Amazon LSC invitation sent${completed.data.external_reference ? ` · ${completed.data.external_reference}` : ""}.`
      : "Amazon LSC invitation submitted to the shared worker and is processing.";
    redirect(`${destination}&notice=${encodeURIComponent(notice)}`);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    console.error("[workforce-amazon-invite] rejected", {
      error: error instanceof Error ? error.message : "Unknown queue error",
      requestedStatus
    });
    redirect(`${destination}&error=${encodeURIComponent(error instanceof Error ? error.message : "Unable to queue the Amazon invitation.")}`);
  }
}

export async function recordPartnerProgress(form:FormData){
 const auth=await requirePagePermission("delivery_associates","edit");
 const requestedStatus=String(form.get("return_status")??"").trim().toLowerCase();
 const destination=form.get("return_path") ? `${safeReturnPath(form)}?` : "/work-force-register?tab="+(["interviews","dropx-id","amazon-id","da-onboarding","attention"].includes(requestedStatus)?requestedStatus:"dropx-id");
 try{
  if(!supabaseAdmin||auth.readOnly)throw new Error("Editing is unavailable.");
  const value=(key:string)=>String(form.get(key)||"").trim();
  const allowedLocations = await scopedWorkforceLocationIds(requireCompanyId(auth), auth);
  const result=await supabaseAdmin.rpc("workforce_record_partner_progress",{p_company:requireCompanyId(auth),p_actor:auth.userId,p_workforce:value("workforce_id"),p_locations:allowedLocations?[...allowedLocations]:null,p_reported:value("reported_on"),p_invited:value("manual_invited_on")||null,p_portal:"ops_pulse"});
  if(result.error)throw new Error(result.error.message);revalidatePath("/work-force-register");redirect(destination+"&notice="+encodeURIComponent("Reporting date and partner progress saved."));
 }catch(error){if(error&&typeof error==="object"&&"digest"in error)throw error;redirect(destination+"&error="+encodeURIComponent(error instanceof Error?error.message:"Unable to record progress."));}
}
