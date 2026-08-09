"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { cleanCountryCode } from "@/lib/country-codes";
import { dynamicWorkforceTable, isCustomWorkforceCategoryCode, normalizeWorkforceCategoryCode, workforceCategoryPageCode } from "@/lib/dynamic-workforce";
import { generateConfiguredBiometricId, generateConfiguredWorkerId } from "@/lib/dropx-id-generation";
import { moveProfileDocumentToTrash, uploadProfileDocument } from "@/lib/profile-document-storage";
import { normalizePersonName } from "@/lib/person-name";
import { normalizeCategoryProfileFieldRules } from "@/lib/profile-field-rules";
import { supabaseAdmin } from "@/lib/supabase-admin";

function required(value: FormDataEntryValue | null, label: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function optional(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

const documentFields = [
  { ruleKey: "aadhaar_front", formKey: "aadhaar_front_file", pathKey: "aadhaar_front_path", label: "Aadhaar front" },
  { ruleKey: "aadhaar_back", formKey: "aadhaar_back_file", pathKey: "aadhaar_back_path", label: "Aadhaar back" },
  { ruleKey: "pan_upload", formKey: "pan_upload_file", pathKey: "pan_upload_path", label: "PAN upload" },
  { ruleKey: "dl_front", formKey: "dl_front_file", pathKey: "dl_front_path", label: "DL front" },
  { ruleKey: "dl_back", formKey: "dl_back_file", pathKey: "dl_back_path", label: "DL back" },
  { ruleKey: "profile_photo", formKey: "profile_photo_file", pathKey: "profile_photo_path", label: "Profile photo" }
] as const;

function directProfilePayload(formData: FormData) {
  return {
    gender: optional(formData.get("gender")), date_of_birth: optional(formData.get("date_of_birth")),
    aadhaar_number: optional(formData.get("aadhaar_number"))?.replace(/\D/g, "") ?? null,
    pan_number: optional(formData.get("pan_number"))?.toUpperCase() ?? null,
    eshram_uan: optional(formData.get("eshram_uan"))?.replace(/\D/g, "") ?? null,
    father_name: optional(formData.get("father_name")), blood_group: optional(formData.get("blood_group")),
    is_handicapped: optional(formData.get("is_handicapped")) === null ? null : optional(formData.get("is_handicapped")) === "true",
    address: optional(formData.get("address")), state_code: optional(formData.get("state_code"))?.toUpperCase() ?? null,
    postal_pin: optional(formData.get("postal_pin"))?.replace(/\D/g, "") ?? null, landmark: optional(formData.get("landmark")),
    bank_account_no: optional(formData.get("bank_account_no"))?.toUpperCase() ?? null, ifsc_code: optional(formData.get("ifsc_code"))?.toUpperCase() ?? null,
    pf_uan: optional(formData.get("pf_uan"))?.replace(/\D/g, "") ?? null, pf_account_no: optional(formData.get("pf_account_no"))?.toUpperCase() ?? null,
    esi_no: optional(formData.get("esi_no"))?.toUpperCase() ?? null, driving_license_no: optional(formData.get("driving_license_no"))?.toUpperCase() ?? null,
    driving_license_exp_date: optional(formData.get("driving_license_exp_date")), vehicle_reg_no: optional(formData.get("vehicle_reg_no"))?.toUpperCase() ?? null,
    vehicle_reg_exp_date: optional(formData.get("vehicle_reg_exp_date")), vehicle_insurance_exp_date: optional(formData.get("vehicle_insurance_exp_date")),
    vehicle_pollution_exp_date: optional(formData.get("vehicle_pollution_exp_date")), emergency_contact_name: optional(formData.get("emergency_contact_name")),
    emergency_contact_number: optional(formData.get("emergency_contact_number"))?.replace(/\D/g, "") ?? null,
    emergency_contact_relation: optional(formData.get("emergency_contact_relation"))
  };
}

function categoryPath(code: string, params?: Record<string, string>) {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  return `/people/category/${encodeURIComponent(code)}${query}`;
}

function fallbackDropxId(code: string) {
  const prefix = code.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() || "WRK";
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

export async function createDynamicWorkforceProfile(formData: FormData) {
  const code = normalizeWorkforceCategoryCode(formData.get("category_code"));
  if (!isCustomWorkforceCategoryCode(code)) redirect("/people/all");
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const pageCode = workforceCategoryPageCode(code);
  if (!hasPermission(authorization, pageCode, "add")) redirect(`/unauthorized?page=${encodeURIComponent(pageCode)}&action=add`);
  const companyId = requireCompanyId(authorization);

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const categoryResult = await supabaseAdmin
      .from("workforce_categories")
      .select("id, code, name, statutory_enabled, direct_activate, profile_field_rules")
      .eq("company_id", companyId)
      .eq("code", code)
      .eq("is_active", true)
      .maybeSingle();
    if (categoryResult.error) throw new Error(categoryResult.error.message);
    if (!categoryResult.data) throw new Error("Workforce category was not found.");

    const provisionResult = await supabaseAdmin.rpc("provision_workforce_category_table", {
      p_category_code: code,
      p_company_id: companyId
    });
    if (provisionResult.error) {
      throw new Error(`${provisionResult.error.message} Run scripts/workforce_dynamic_category_tables_v1.sql in Supabase SQL Editor.`);
    }

    const fullName = normalizePersonName(formData.get("full_name"));
    const mobileCountryCode = cleanCountryCode(formData.get("mobile_country_code"));
    const mobile = required(formData.get("mobile"), "Mobile number").replace(/\D/g, "");
    const email = required(formData.get("email"), "Email").toLowerCase();
    const dateOfJoin = required(formData.get("date_of_join"), "Date of join");
    const locationId = required(formData.get("location_id"), "Location");
    const designation = required(formData.get("designation"), "Designation");
    const directActivate = Boolean(categoryResult.data.direct_activate);
    const dashboardRules = normalizeCategoryProfileFieldRules(categoryResult.data.profile_field_rules).dashboard;
    const profilePayload = directActivate ? directProfilePayload(formData) : {};
    if (directActivate) {
      const profileValues = profilePayload as Record<string, unknown>;
      const aliases: Record<string, string> = { pincode: "postal_pin", ifsc: "ifsc_code" };
      for (const key of dashboardRules.required) {
        const documentField = documentFields.find((field) => field.ruleKey === key);
        if (documentField) {
          const file = formData.get(documentField.formKey);
          if (!(file instanceof File) || file.size === 0) throw new Error(`${documentField.label} is required.`);
        } else if (!String(profileValues[aliases[key] ?? key] ?? "").trim()) throw new Error(`${key.replaceAll("_", " ")} is required.`);
      }
    }
    if (!/^\d{6,15}$/.test(mobile)) throw new Error("Mobile number must contain 6 to 15 digits.");
    if (Number.isNaN(Date.parse(dateOfJoin))) throw new Error("Enter a valid date of join.");
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(locationId)) {
      throw new Error("You do not have access to the selected location.");
    }

    const [locationResult, designationResult] = await Promise.all([
      supabaseAdmin.from("stations").select("id").eq("company_id", companyId).eq("id", locationId).eq("is_active", true).maybeSingle(),
      supabaseAdmin.from("designations").select("id, onboarding_categories").eq("company_id", companyId).eq("name", designation).eq("is_active", true).maybeSingle()
    ]);
    if (locationResult.error) throw new Error(locationResult.error.message);
    if (!locationResult.data) throw new Error("Selected location is unavailable.");
    if (designationResult.error) throw new Error(designationResult.error.message);
    if (!designationResult.data || !((designationResult.data.onboarding_categories ?? []) as string[]).includes(code)) {
      throw new Error("Selected designation is unavailable for this category.");
    }

    const [dropxId, biometricId] = await Promise.all([
      generateConfiguredWorkerId({
        category: code,
        companyId,
        designationId: designationResult.data.id,
        designationName: designation,
        fallback: () => fallbackDropxId(code),
        locationId
      }),
      generateConfiguredBiometricId({
        category: code,
        companyId,
        designationId: designationResult.data.id,
        designationName: designation,
        fallback: () => String(Date.now()).slice(-8),
        locationId
      })
    ]);
    const registrationToken = randomBytes(32).toString("base64url");
    const registrationTokenHash = createHash("sha256").update(registrationToken).digest("hex");
    const statutory = formData.getAll("statutory_applicability").map(String).filter(Boolean);
    const payload = withCompany({
      full_name: fullName,
      mobile_country_code: mobileCountryCode,
      mobile,
      email,
      date_of_join: dateOfJoin,
      location_id: locationId,
      designation,
      biometric_id: biometricId,
      dropx_id: dropxId,
      created_by: authorization.userId,
      ...profilePayload,
      statutory_applicability: categoryResult.data.statutory_enabled && statutory.length ? statutory : ["not_applicable"],
      onboarding_token_hash: registrationTokenHash,
      onboarding_token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      onboarding_status: directActivate ? "active" : "pending",
      is_active: true
    }, companyId);
    const insertResult = await supabaseAdmin.from(dynamicWorkforceTable(code)).insert(payload).select("id").single();
    if (insertResult.error) {
      const message = insertResult.error.message.toLowerCase();
      if (message.includes("duplicate") || message.includes("unique")) throw new Error("DropX ID, biometric ID, mobile, or email is already registered in this category.");
      throw new Error(insertResult.error.message);
    }
    if (directActivate && insertResult.data) {
      const documentPayload: Record<string, string> = {};
      const enabled = new Set(dashboardRules.enabled);
      for (const field of documentFields) {
        if (!enabled.has(field.ruleKey)) continue;
        const uploaded = await uploadProfileDocument({ companyId, documentKey: field.pathKey.replace("_path", ""), fileValue: formData.get(field.formKey), ownerId: insertResult.data.id, ownerType: "contractor" });
        if (uploaded) documentPayload[field.pathKey] = uploaded.storagePath;
      }
      if (Object.keys(documentPayload).length) {
        const updateResult = await supabaseAdmin.from(dynamicWorkforceTable(code)).update(documentPayload).eq("id", insertResult.data.id).eq("company_id", companyId);
        if (updateResult.error) throw new Error(updateResult.error.message);
      }
    }
    revalidatePath(`/people/category/${code}`);
    revalidatePath("/people/all");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to add profile.";
    redirect(categoryPath(code, {
      error: message,
      full_name: String(formData.get("full_name") ?? ""),
      mobile_country_code: cleanCountryCode(formData.get("mobile_country_code")),
      mobile: String(formData.get("mobile") ?? "").replace(/\D/g, ""),
      email: String(formData.get("email") ?? ""),
      date_of_join: String(formData.get("date_of_join") ?? ""),
      location_id: String(formData.get("location_id") ?? ""),
      designation: String(formData.get("designation") ?? "")
    }));
  }
  redirect(categoryPath(code, { notice: "Profile added successfully." }));
}

export async function updateDynamicWorkforceProfile(formData: FormData) {
  const code = normalizeWorkforceCategoryCode(formData.get("category_code"));
  if (!isCustomWorkforceCategoryCode(code)) redirect("/people/all");
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const pageCode = workforceCategoryPageCode(code);
  if (!hasPermission(authorization, pageCode, "edit")) redirect(`/unauthorized?page=${encodeURIComponent(pageCode)}&action=edit`);
  const companyId = requireCompanyId(authorization);
  const id = required(formData.get("id"), "Profile");

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const table = dynamicWorkforceTable(code);
    const [categoryResult, existingResult] = await Promise.all([
      supabaseAdmin
        .from("workforce_categories")
        .select("statutory_enabled, profile_field_rules")
        .eq("company_id", companyId)
        .eq("code", code)
        .eq("is_active", true)
        .maybeSingle(),
      supabaseAdmin
        .from(table)
        .select("*")
        .eq("company_id", companyId)
        .eq("id", id)
        .maybeSingle()
    ]);
    if (categoryResult.error) throw new Error(categoryResult.error.message);
    if (!categoryResult.data) throw new Error("Workforce category was not found.");
    if (existingResult.error) throw new Error(existingResult.error.message);
    if (!existingResult.data) throw new Error("Profile was not found.");
    const existing = existingResult.data as Record<string, unknown>;
    const currentLocationId = String(existing.location_id ?? "");
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(currentLocationId)) {
      throw new Error("You do not have access to this profile.");
    }

    const locationId = optional(formData.get("location_id")) ?? currentLocationId;
    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(locationId)) {
      throw new Error("You do not have access to the selected location.");
    }
    const designation = optional(formData.get("designation")) ?? String(existing.designation ?? "");
    const [locationResult, designationResult] = await Promise.all([
      supabaseAdmin.from("stations").select("id").eq("company_id", companyId).eq("id", locationId).eq("is_active", true).maybeSingle(),
      supabaseAdmin.from("designations").select("onboarding_categories").eq("company_id", companyId).eq("name", designation).eq("is_active", true).maybeSingle()
    ]);
    if (locationResult.error) throw new Error(locationResult.error.message);
    if (!locationResult.data) throw new Error("Selected location is unavailable.");
    if (designationResult.error) throw new Error(designationResult.error.message);
    if (!designationResult.data || !((designationResult.data.onboarding_categories ?? []) as string[]).includes(code)) {
      throw new Error("Selected designation is unavailable for this category.");
    }

    const rules = normalizeCategoryProfileFieldRules(categoryResult.data.profile_field_rules).dashboard;
    const enabled = new Set(rules.enabled);
    const profileValues = directProfilePayload(formData) as Record<string, unknown>;
    const ruleColumns: Record<string, string> = { pincode: "postal_pin", ifsc: "ifsc_code" };
    const enabledProfilePayload = Object.fromEntries(
      rules.enabled
        .map((key) => ruleColumns[key] ?? key)
        .filter((column) => column in profileValues)
        .map((column) => [column, profileValues[column]])
    );
    const payload: Record<string, unknown> = {
      full_name: optional(formData.get("full_name")) ? normalizePersonName(formData.get("full_name")) : existing.full_name,
      mobile_country_code: cleanCountryCode(formData.get("mobile_country_code")) || existing.mobile_country_code,
      mobile: String(formData.get("mobile") ?? existing.mobile ?? "").replace(/\D/g, ""),
      email: String(formData.get("email") ?? existing.email ?? "").trim().toLowerCase(),
      date_of_join: optional(formData.get("date_of_join")) ?? existing.date_of_join,
      location_id: locationId,
      designation,
      ...enabledProfilePayload,
      is_active: String(formData.get("is_active") ?? existing.is_active) === "true",
      updated_at: new Date().toISOString()
    };
    if (categoryResult.data.statutory_enabled) {
      const statutory = formData.getAll("statutory_applicability").map(String).filter(Boolean);
      payload.statutory_applicability = statutory.length ? statutory : ["not_applicable"];
    }

    for (const field of documentFields) {
      if (!enabled.has(field.ruleKey)) continue;
      const uploaded = await uploadProfileDocument({
        companyId,
        documentKey: field.pathKey.replace("_path", ""),
        fileValue: formData.get(field.formKey),
        ownerId: id,
        ownerType: "contractor"
      });
      if (!uploaded) continue;
      await moveProfileDocumentToTrash({
        companyId,
        documentLabel: field.label,
        ownerId: id,
        ownerType: "contractor",
        replacedBy: authorization.userId,
        storagePath: String(existing[field.pathKey] ?? "") || null
      });
      payload[field.pathKey] = uploaded.storagePath;
    }

    const updateResult = await supabaseAdmin.from(table).update(payload).eq("id", id).eq("company_id", companyId);
    if (updateResult.error) throw new Error(updateResult.error.message);
    revalidatePath(`/people/category/${code}`);
    revalidatePath("/people/all");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update profile.";
    redirect(categoryPath(code, { edit: id, error: message }));
  }
  redirect(categoryPath(code, { notice: "Profile updated successfully." }));
}
