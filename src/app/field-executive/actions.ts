"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createHash, randomBytes } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { requirePagePermission } from "@/lib/authorization";
import { syncBiometricEnrolment } from "@/lib/biometric/enrolments";
import { generateBiometricEnrolmentId } from "@/lib/biometric/ids";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { cleanCountryCode } from "@/lib/country-codes";
import { moveProfileDocumentToTrash, uploadProfileDocument } from "@/lib/profile-document-storage";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { sendFieldExecutiveOnboardingWhatsApp } from "@/lib/whatsapp";

function required(value: FormDataEntryValue | null, field: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function optional(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function fieldExecutiveRedirect(params?: Record<string, string>): never {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  redirect(`/field-executive${query}`);
}

function addFormParams(formData: FormData) {
  return {
    full_name: String(formData.get("full_name") ?? ""),
    mobile_country_code: cleanCountryCode(formData.get("mobile_country_code")),
    mobile: String(formData.get("mobile") ?? "").replace(/\D/g, ""),
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    date_of_join: String(formData.get("date_of_join") ?? ""),
    location_id: String(formData.get("location_id") ?? ""),
    biometric_id: String(formData.get("biometric_id") ?? "").replace(/\D/g, "")
  };
}

function friendlyFieldExecutiveError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("operation_mode_id")) {
    return "Database migration pending: remove operation_mode_id from field_executives in Supabase.";
  }
  return message;
}

function generatedDropxId() {
  return `FE-${Date.now().toString(36).toUpperCase()}`;
}

const fieldExecutiveDocumentFields = [
  { formKey: "aadhaar_front_file", pathKey: "aadhaar_front_path", label: "Aadhaar front" },
  { formKey: "aadhaar_back_file", pathKey: "aadhaar_back_path", label: "Aadhaar back" },
  { formKey: "dl_front_file", pathKey: "dl_front_path", label: "DL front" },
  { formKey: "dl_back_file", pathKey: "dl_back_path", label: "DL back" },
  { formKey: "profile_photo_file", pathKey: "profile_photo_path", label: "Profile photo" }
] as const;

function normalizeFieldExecutivePayload(formData: FormData, requireId = false) {
  const id = requireId ? required(formData.get("id"), "Field executive") : null;
  const fullName = required(formData.get("full_name"), "Full name");
  const mobileCountryCode = cleanCountryCode(formData.get("mobile_country_code"));
  const mobile = required(formData.get("mobile"), "Mobile number").replace(/\D/g, "");
  const email = required(formData.get("email"), "Email").toLowerCase();
  const dateOfJoin = required(formData.get("date_of_join"), "Date of join");
  const locationId = required(formData.get("location_id"), "Location");
  const designation = required(formData.get("designation"), "Designation");
  const gender = required(formData.get("gender"), "Gender");
  const dateOfBirth = required(formData.get("date_of_birth"), "Date of birth");
  const aadhaarNumber = required(formData.get("aadhaar_number"), "Aadhaar number").replace(/\D/g, "");
  const panNumber = required(formData.get("pan_number"), "PAN number").toUpperCase();
  const address = required(formData.get("address"), "Address");
  const postalPin = required(formData.get("postal_pin"), "Postal PIN").replace(/\D/g, "");
  const landmark = required(formData.get("landmark"), "Land mark");
  const stateCode = required(formData.get("state_code"), "State");
  const fatherName = required(formData.get("father_name"), "Father name");
  const bloodGroup = required(formData.get("blood_group"), "Blood group");
  const isHandicapped = required(formData.get("is_handicapped"), "Handicapped") === "true";
  const bankAccountNo = required(formData.get("bank_account_no"), "Bank account number").replace(/\D/g, "");
  const ifscCode = required(formData.get("ifsc_code"), "IFSC").toUpperCase();
  const drivingLicenseNo = required(formData.get("driving_license_no"), "Driving license number").toUpperCase();
  const drivingLicenseExpDate = required(formData.get("driving_license_exp_date"), "Driving license expiry date");
  const vehicleRegNo = required(formData.get("vehicle_reg_no"), "Vehicle registration number").toUpperCase();
  const vehicleRegExpDate = required(formData.get("vehicle_reg_exp_date"), "Vehicle registration expiry date");
  const vehicleInsuranceExpDate = required(formData.get("vehicle_insurance_exp_date"), "Vehicle insurance expiry date");
  const vehiclePollutionExpDate = required(formData.get("vehicle_pollution_exp_date"), "Vehicle pollution expiry date");
  const biometricId = required(formData.get("biometric_id"), "Biometric enrolment ID");
  const emergencyContactName = required(formData.get("emergency_contact_name"), "Emergency contact name");
  const emergencyContactNumber = required(formData.get("emergency_contact_number"), "Emergency contact number").replace(/\D/g, "");
  const emergencyContactRelation = required(formData.get("emergency_contact_relation"), "Emergency contact relation");
  const isActive = optional(formData.get("is_active")) !== "false";

  if (!/^\d{6,15}$/.test(mobile)) throw new Error("Mobile number must contain 6 to 15 digits.");
  if (!/^\d{10}$/.test(emergencyContactNumber)) throw new Error("Emergency contact number must contain exactly 10 digits.");
  if (!/^\d{12}$/.test(aadhaarNumber)) throw new Error("Aadhaar number must contain exactly 12 digits.");
  if (!/^\d{6}$/.test(postalPin)) throw new Error("Postal PIN must contain exactly 6 digits.");
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber)) throw new Error("PAN number format is invalid.");
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) throw new Error("IFSC format is invalid.");

  [
    ["Date of join", dateOfJoin],
    ["Date of birth", dateOfBirth],
    ["Driving license expiry date", drivingLicenseExpDate],
    ["Vehicle registration expiry date", vehicleRegExpDate],
    ["Vehicle insurance expiry date", vehicleInsuranceExpDate],
    ["Vehicle pollution expiry date", vehiclePollutionExpDate]
  ].forEach(([label, value]) => {
    if (Number.isNaN(Date.parse(value))) throw new Error(`Enter a valid ${String(label).toLowerCase()}.`);
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
      address,
      postal_pin: postalPin,
      landmark,
      state_code: stateCode,
      father_name: fatherName,
      blood_group: bloodGroup,
      is_handicapped: isHandicapped,
      bank_account_no: bankAccountNo,
      ifsc_code: ifscCode,
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
      is_active: isActive
    }
  };
}

export async function createFieldExecutive(formData: FormData) {
  const authorization = await requirePagePermission("delivery_associates", "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) fieldExecutiveRedirect({ error: "Supabase service role key is not configured." });

  try {
    const fullName = required(formData.get("full_name"), "Full name");
    const submittedBiometricId = optional(formData.get("biometric_id"))?.replace(/\D/g, "") ?? null;
    const biometricId = submittedBiometricId ?? await generateBiometricEnrolmentId(companyId);
    const mobileCountryCode = cleanCountryCode(formData.get("mobile_country_code"));
    const mobile = required(formData.get("mobile"), "Mobile number").replace(/\D/g, "");
    const email = required(formData.get("email"), "Email").toLowerCase();
    const dateOfJoin = required(formData.get("date_of_join"), "Date of join");
    const locationId = required(formData.get("location_id"), "Location");

    if (!/^\d{6,15}$/.test(mobile)) throw new Error("Mobile number must contain 6 to 15 digits.");
    if (biometricId && !/^\d{1,20}$/.test(biometricId)) throw new Error("Biometric enrolment ID must be numeric.");
    if (Number.isNaN(Date.parse(dateOfJoin))) throw new Error("Enter a valid date of join.");
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(locationId)) {
      throw new Error("You do not have access to the selected location.");
    }
    const { data: location, error: locationError } = await supabaseAdmin
      .from("stations")
      .select("id")
      .eq("id", locationId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (locationError) throw new Error(locationError.message);
    if (!location) throw new Error("Selected location is not available for this company.");

    const dropxId = generatedDropxId();
    const registrationToken = randomBytes(32).toString("base64url");
    const registrationTokenHash = createHash("sha256").update(registrationToken).digest("hex");
    const basePayload = withCompany({
      full_name: fullName,
      mobile_country_code: mobileCountryCode,
      mobile,
      email,
      date_of_join: dateOfJoin,
      location_id: locationId,
      biometric_id: biometricId,
      dropx_id: dropxId,
      created_by: authorization.userId,
      is_active: true
    }, companyId);
    const executiveSelect = "id, stations (station_code, station_name, providers (name))";
    let insertResult = await supabaseAdmin.from("field_executives").insert({
      ...basePayload,
      onboarding_token_hash: registrationTokenHash,
      onboarding_token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      onboarding_status: "pending"
    }).select(executiveSelect).single();

    const whatsappMigrationMissing = Boolean(insertResult.error?.message.toLowerCase().includes("onboarding_token"));
    if (whatsappMigrationMissing) {
      insertResult = await supabaseAdmin.from("field_executives").insert(basePayload).select(executiveSelect).single();
    }
    const { data: executive, error } = insertResult;

    if (error) {
      const message = error.message.toLowerCase();
      if (message.includes("unique") || message.includes("duplicate")) {
        throw new Error("Field Executive ID is already registered.");
      }
      throw new Error(friendlyFieldExecutiveError(error.message));
    }

    await syncBiometricEnrolment({
      companyId,
      createdBy: authorization.userId,
      effectiveFrom: dateOfJoin,
      enrolmentId: biometricId,
      fieldExecutiveId: executive.id,
      isActive: true,
      locationId,
      workerType: "individual_contract"
    });

    const stationRelation = executive.stations as unknown as { station_code?: string; station_name?: string | null; providers?: { name?: string } | Array<{ name?: string }> | null } | null;
    const providerRelation = Array.isArray(stationRelation?.providers) ? stationRelation?.providers[0] : stationRelation?.providers;
    if (!whatsappMigrationMissing) {
      waitUntil(sendFieldExecutiveOnboardingWhatsApp({
        companyId,
        fieldExecutiveId: executive.id,
        fullName,
        mobile: `${mobileCountryCode}${mobile}`,
        dropxId,
        dateOfJoin,
        locationCode: stationRelation?.station_code ?? "",
        locationName: stationRelation?.station_name ?? "",
        providerName: providerRelation?.name ?? "",
        registrationToken,
        triggeredBy: authorization.userId
      }));
    }

    revalidatePath("/field-executive");
  } catch (error) {
    fieldExecutiveRedirect({
      ...addFormParams(formData),
      error: error instanceof Error ? friendlyFieldExecutiveError(error.message) : "Unable to add field executive."
    });
  }

  fieldExecutiveRedirect({ notice: "Field executive added successfully." });
}

export async function updateFieldExecutive(formData: FormData) {
  const authorization = await requirePagePermission("delivery_associates", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) fieldExecutiveRedirect({ error: "Supabase service role key is not configured." });

  try {
    const { id, payload } = normalizeFieldExecutivePayload(formData, true);
    if (!id) throw new Error("Field executive is required.");
    const executiveId = id;
    const existingResult = await supabaseAdmin
      .from("field_executives")
      .select("aadhaar_front_path, aadhaar_back_path, dl_front_path, dl_back_path, profile_photo_path")
      .eq("id", executiveId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (existingResult.error) throw new Error(existingResult.error.message);

    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(payload.location_id)) {
      throw new Error("You do not have access to the selected location.");
    }
    const { data: location, error: locationError } = await supabaseAdmin
      .from("stations")
      .select("id")
      .eq("id", payload.location_id)
      .eq("company_id", companyId)
      .maybeSingle();
    if (locationError) throw new Error(locationError.message);
    if (!location) throw new Error("Selected location is not available for this company.");

    const documentPayload: Record<string, string> = {};
    const existingPaths = existingResult.data as Record<string, string | null> | null;
    for (const field of fieldExecutiveDocumentFields) {
      const uploaded = await uploadProfileDocument({
        companyId,
        documentKey: field.pathKey.replace("_path", ""),
        fileValue: formData.get(field.formKey),
        ownerId: executiveId,
        ownerType: "field_executive"
      });
      if (!uploaded) continue;
      const oldPath = existingPaths?.[field.pathKey] ?? null;
      if (oldPath) {
        await moveProfileDocumentToTrash({
          companyId,
          ownerId: executiveId,
          ownerType: "field_executive",
          documentLabel: field.label,
          fileName: oldPath.split("/").pop(),
          storagePath: oldPath,
          replacedBy: authorization.userId
        });
      }
      documentPayload[field.pathKey] = uploaded.storagePath;
    }

    const { error } = await supabaseAdmin
      .from("field_executives")
      .update({
        ...payload,
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

    await syncBiometricEnrolment({
      companyId,
      createdBy: authorization.userId,
      effectiveFrom: payload.date_of_join,
      enrolmentId: payload.biometric_id,
      fieldExecutiveId: executiveId,
      isActive: Boolean(payload.is_active),
      locationId: payload.location_id,
      workerType: "individual_contract"
    });

    revalidatePath("/field-executive");
  } catch (error) {
    fieldExecutiveRedirect({ edit: String(formData.get("id") ?? ""), error: error instanceof Error ? friendlyFieldExecutiveError(error.message) : "Unable to update field executive." });
  }

  fieldExecutiveRedirect({ notice: "Field executive updated successfully." });
}
