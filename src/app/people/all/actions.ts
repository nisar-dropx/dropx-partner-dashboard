"use server";

import { revalidatePath } from "next/cache";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { dynamicWorkforceTable, isCustomWorkforceCategoryCode, workforceCategoryPageCode } from "@/lib/dynamic-workforce";
import { supabaseAdmin } from "@/lib/supabase-admin";

type SheetValues = Record<string, string>;

const fixedSources: Record<string, { table: string; pageCode: string; employee: boolean }> = {
  employees: { table: "employees", pageCode: "employees", employee: true },
  contractors: { table: "contractors", pageCode: "contractors", employee: false },
  vendors: { table: "vendors", pageCode: "vendors", employee: false },
  workers: { table: "helpers", pageCode: "workers", employee: false },
  workforce: { table: "workforce", pageCode: "delivery_associates", employee: false }
};

const supportedKeys = [
  "fullName", "mobileCountryCode", "mobileNumber", "email", "dateOfJoin", "gender", "dateOfBirth",
  "aadhaarNumber", "panNumber", "eshramUan", "fatherName", "bloodGroup", "handicapped", "address",
  "stateCode", "pincode", "landmark", "bankAccountNumber", "ifsc", "pfUan", "pfAccountNumber",
  "esiNumber", "emergencyContactNumber", "emergencyContactName", "emergencyContactRelation",
  "drivingLicenseNumber", "drivingLicenseExpiry", "vehicleRegistrationNumber", "vehicleRegistrationExpiry",
  "vehicleInsuranceExpiry", "pollutionExpiry"
] as const;

function clean(value: string | undefined) {
  const text = String(value ?? "").trim();
  return text || null;
}

function dateValue(value: string | undefined) {
  const raw = clean(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : raw;
}

export async function saveAllPeopleSheetRow({ categoryCode, id, values }: { categoryCode: string; id: string; values: SheetValues }) {
  const authorization = await getAuthorization();
  if (!authorization) return { ok: false, error: "Your session has expired." };
  const source = fixedSources[categoryCode] ?? (isCustomWorkforceCategoryCode(categoryCode)
    ? { table: dynamicWorkforceTable(categoryCode), pageCode: workforceCategoryPageCode(categoryCode), employee: false }
    : null);
  if (!source || !hasPermission(authorization, source.pageCode, "edit")) return { ok: false, error: "You do not have permission to edit this profile." };
  if (!supabaseAdmin) return { ok: false, error: "Profile storage is not configured." };

  const companyId = requireCompanyId(authorization);
  const existingResult = await supabaseAdmin.from(source.table).select("id, location_id, pan_number, aadhaar_number, driving_license_no, vehicle_reg_no, bank_account_no, ifsc, ifsc_code").eq("company_id", companyId).eq("id", id).maybeSingle();
  if (existingResult.error || !existingResult.data) return { ok: false, error: existingResult.error?.message ?? "Profile was not found." };
  if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(String(existingResult.data.location_id ?? ""))) return { ok: false, error: "You do not have access to this profile location." };

  const workerOnly = categoryCode === "workforce";
  const payload: Record<string, string | boolean | null> = {
    full_name: clean(values.fullName),
    mobile_country_code: clean(values.mobileCountryCode)?.replace(/^\+/, "") ?? null,
    mobile: clean(values.mobileNumber)?.replace(/\D/g, "") ?? null,
    email: clean(values.email)?.toLowerCase() ?? null,
    date_of_join: dateValue(values.dateOfJoin),
    bank_account_no: clean(values.bankAccountNumber)?.toUpperCase() ?? null,
    [source.employee ? "ifsc" : "ifsc_code"]: clean(values.ifsc)?.toUpperCase() ?? null
  };
  if (!workerOnly) Object.assign(payload, {
    gender: clean(values.gender), date_of_birth: dateValue(values.dateOfBirth),
    aadhaar_number: clean(values.aadhaarNumber)?.replace(/\D/g, "") ?? null,
    pan_number: clean(values.panNumber)?.toUpperCase() ?? null, eshram_uan: clean(values.eshramUan)?.replace(/\D/g, "") ?? null,
    father_name: clean(values.fatherName), blood_group: clean(values.bloodGroup),
    is_handicapped: values.handicapped === "Yes" ? true : values.handicapped === "No" ? false : null,
    address: clean(values.address), state_code: clean(values.stateCode)?.toUpperCase() ?? null,
    [source.employee ? "pincode" : "postal_pin"]: clean(values.pincode)?.replace(/\D/g, "") ?? null,
    landmark: clean(values.landmark), pf_uan: clean(values.pfUan)?.replace(/\D/g, "") ?? null,
    pf_account_no: clean(values.pfAccountNumber)?.toUpperCase() ?? null, esi_no: clean(values.esiNumber)?.toUpperCase() ?? null,
    emergency_contact_number: clean(values.emergencyContactNumber)?.replace(/\D/g, "") ?? null,
    emergency_contact_name: clean(values.emergencyContactName), emergency_contact_relation: clean(values.emergencyContactRelation),
    driving_license_no: clean(values.drivingLicenseNumber)?.toUpperCase() ?? null, driving_license_exp_date: dateValue(values.drivingLicenseExpiry),
    vehicle_reg_no: clean(values.vehicleRegistrationNumber)?.toUpperCase() ?? null, vehicle_reg_exp_date: dateValue(values.vehicleRegistrationExpiry),
    vehicle_insurance_exp_date: dateValue(values.vehicleInsuranceExpiry), vehicle_pollution_exp_date: dateValue(values.pollutionExpiry)
  });
  const updateResult = await supabaseAdmin.from(source.table).update(payload).eq("company_id", companyId).eq("id", id);
  if (updateResult.error) return { ok: false, error: updateResult.error.message };

  const changedKinds: string[] = [];
  if (!workerOnly && String(existingResult.data.pan_number ?? "") !== String(payload.pan_number ?? "")) changedKinds.push("pan", "pan_aadhaar");
  if (!workerOnly && String(existingResult.data.aadhaar_number ?? "") !== String(payload.aadhaar_number ?? "")) changedKinds.push("pan_aadhaar");
  if (!workerOnly && String(existingResult.data.driving_license_no ?? "") !== String(payload.driving_license_no ?? "")) changedKinds.push("dl");
  if (!workerOnly && String(existingResult.data.vehicle_reg_no ?? "") !== String(payload.vehicle_reg_no ?? "")) changedKinds.push("vehicle");
  const existingIfsc = source.employee ? existingResult.data.ifsc : existingResult.data.ifsc_code;
  if (String(existingResult.data.bank_account_no ?? "") !== String(payload.bank_account_no ?? "") || String(existingIfsc ?? "") !== String(payload[source.employee ? "ifsc" : "ifsc_code"] ?? "")) changedKinds.push("bank");
  if (changedKinds.length) await supabaseAdmin.from("connect_profile_verifications").update({ verified: false, manual_review: false, block_submit: true, message: "Reverification required after profile field update.", updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("account_id", id).in("kind", [...new Set(changedKinds)]);

  revalidatePath("/people/all");
  return { ok: true };
}
