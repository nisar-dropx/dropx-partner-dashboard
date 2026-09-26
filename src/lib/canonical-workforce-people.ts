import type { AllPeopleRow } from "@/components/all-people-register";
import { allPeopleExportColumns, type AllPeopleExportValues } from "@/lib/all-people-export";
import { ALL_PEOPLE_SHEET_EDITABLE_KEYS } from "@/lib/all-people-sheet";
import { canAccessDesignationPortal } from "@/lib/designation-portal-access";
import { supabaseAdmin } from "@/lib/supabase-admin";

function first<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function dateText(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(date).replace(",", "");
}

function exportValues(row: Record<string, unknown>, location: string, model: string, provider: string, status: string, designation: string): AllPeopleExportValues {
  const values = Object.fromEntries(allPeopleExportColumns.map(({ key }) => [key, ""])) as AllPeopleExportValues;
  values.dropxId = String(row.dropx_id ?? "");
  values.biometricId = String(row.biometric_id ?? "");
  values.fullName = String(row.full_name ?? "");
  values.category = "Workforce";
  const countryCode = String(row.mobile_country_code ?? "").replace(/^\+/, "");
  values.mobileCountryCode = countryCode ? `+${countryCode}` : "";
  values.mobileNumber = String(row.mobile ?? "");
  values.email = String(row.email ?? "");
  values.dateOfJoin = dateText(row.date_of_join);
  values.location = location; values.model = model; values.provider = provider;
  values.designation = designation;
  values.status = status;
  values.active = row.is_active === false || row.deleted_at ? "No" : "Yes";
  values.statutoryApplicability = Array.isArray(row.statutory_applicability) ? row.statutory_applicability.map(String).join(", ") : String(row.statutory_applicability ?? "");
  values.gender = String(row.gender ?? "");
  values.dateOfBirth = dateText(row.date_of_birth);
  values.aadhaarNumber = String(row.aadhaar_number ?? "");
  values.panNumber = String(row.pan_number ?? "");
  values.eshramUan = String(row.eshram_uan ?? "");
  values.fatherName = String(row.father_name ?? "");
  values.bloodGroup = String(row.blood_group ?? "");
  values.handicapped = row.is_handicapped === true ? "Yes" : row.is_handicapped === false ? "No" : "";
  values.address = String(row.address ?? "");
  values.stateCode = String(row.state_code ?? "");
  values.pincode = String(row.postal_pin ?? "");
  values.landmark = String(row.landmark ?? "");
  values.bankAccountNumber = String(row.bank_account_no ?? "");
  values.ifsc = String(row.ifsc_code ?? "");
  values.pfUan = String(row.pf_uan ?? "");
  values.pfAccountNumber = String(row.pf_account_no ?? "");
  values.esiNumber = String(row.esi_no ?? "");
  values.emergencyContactNumber = String(row.emergency_contact_number ?? "");
  values.emergencyContactName = String(row.emergency_contact_name ?? "");
  values.emergencyContactRelation = String(row.emergency_contact_relation ?? "");
  values.drivingLicenseNumber = String(row.driving_license_no ?? "");
  values.drivingLicenseExpiry = dateText(row.driving_license_exp_date);
  values.vehicleRegistrationNumber = String(row.vehicle_reg_no ?? "");
  values.vehicleRegistrationExpiry = dateText(row.vehicle_reg_exp_date);
  values.vehicleInsuranceExpiry = dateText(row.vehicle_insurance_exp_date);
  values.pollutionExpiry = dateText(row.vehicle_pollution_exp_date);
  values.aadhaarFrontFile = String(row.aadhaar_front_path ?? "");
  values.aadhaarBackFile = String(row.aadhaar_back_path ?? "");
  values.panFile = String(row.pan_upload_path ?? "");
  values.drivingLicenseFrontFile = String(row.dl_front_path ?? "");
  values.drivingLicenseBackFile = String(row.dl_back_path ?? "");
  values.profilePhotoFile = String(row.profile_photo_path ?? "");
  values.returnRemarks = String(row.profile_return_remarks ?? "");
  values.createdAt = dateText(row.created_at);
  values.updatedAt = dateText(row.updated_at);
  return values;
}

export async function loadCanonicalWorkforcePeople(
  companyId: string,
  locationScopeIds: string[],
  hasAllLocationAccess: boolean,
  actions: { canEdit: boolean; canView: boolean; isOwner?: boolean } = { canEdit: false, canView: false }
): Promise<{ rows: AllPeopleRow[]; error: string | null }> {
  if (!supabaseAdmin) return { rows: [], error: "Supabase service role key is not configured." };

  const result = await supabaseAdmin
    .from("workforce")
    .select("id, source_profile_type, source_profile_id, full_name, date_of_join, location_id, designation_id, dropx_id, biometric_id, mobile_country_code, mobile, email, onboarding_status, is_active, deleted_at, statutory_applicability, gender, date_of_birth, aadhaar_number, pan_number, eshram_uan, father_name, blood_group, is_handicapped, address, state_code, postal_pin, landmark, bank_account_no, ifsc_code, pf_uan, pf_account_no, esi_no, emergency_contact_number, emergency_contact_name, emergency_contact_relation, driving_license_no, driving_license_exp_date, vehicle_reg_no, vehicle_reg_exp_date, vehicle_insurance_exp_date, vehicle_pollution_exp_date, aadhaar_front_path, aadhaar_back_path, pan_upload_path, dl_front_path, dl_back_path, profile_photo_path, profile_return_remarks, created_at, updated_at, stations (station_code, providers (name), location_models (code, name)), designations (id, code, name, portal_permissions)")
    .eq("company_id", companyId)
    .order("full_name");
  if (result.error) return { rows: [], error: result.error.message };

  const seen = new Set<string>();
  const rows = ((result.data ?? []) as unknown as Record<string, unknown>[])
    .filter((row) => hasAllLocationAccess || locationScopeIds.includes(String(row.location_id ?? "")))
    .filter((row) => {
      const key = String(row.id ?? "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((row) => {
      const designationRecord = first(row.designations as { portal_permissions?: unknown } | Array<{ portal_permissions?: unknown }> | null);
      return canAccessDesignationPortal(designationRecord, "dashboard", "view", { isOwner: actions.isOwner });
    })
    .map((row) => {
      const station = first(row.stations as { station_code?: string; providers?: { name?: string } | Array<{ name?: string }> | null; location_models?: { code?: string; name?: string } | Array<{ code?: string; name?: string }> | null } | Array<{ station_code?: string; providers?: { name?: string } | Array<{ name?: string }> | null; location_models?: { code?: string; name?: string } | Array<{ code?: string; name?: string }> | null }> | null);
      const designationRecord = first(row.designations as { id?: string; code?: string; name?: string; portal_permissions?: unknown } | Array<{ id?: string; code?: string; name?: string; portal_permissions?: unknown }> | null);
      const location = String(station?.station_code ?? "-"); const modelRecord = first(station?.location_models); const model = String(modelRecord?.code ?? modelRecord?.name ?? "-"); const provider = String(first(station?.providers)?.name ?? "-");
      const designation = String(designationRecord?.name ?? designationRecord?.code ?? "-").trim() || "-";
      const active = row.is_active !== false && !row.deleted_at;
      const onboardingStatus = String(row.onboarding_status ?? "").trim().replaceAll("_", " ");
      const status = active
        ? onboardingStatus
          ? onboardingStatus.replace(/\b\w/g, (letter) => letter.toUpperCase())
          : "Active"
        : "Inactive";
      const canEdit = actions.canEdit && canAccessDesignationPortal(designationRecord, "dashboard", "edit", { isOwner: actions.isOwner });
      return {
        id: String(row.id),
        category: "Workforce",
        categoryCode: "workforce",
        code: String(row.dropx_id ?? "-"),
        biometricId: String(row.biometric_id ?? "-") || "-",
        fullName: String(row.full_name ?? "-"),
        mobile: String(row.mobile ?? "-") || "-",
        email: String(row.email ?? "-") || "-",
        location, model, provider, designation,
        status,
        viewHref: actions.canView ? `/workforce?view=${encodeURIComponent(String(row.id))}` : undefined,
        editHref: actions.canEdit ? `/workforce?edit=${encodeURIComponent(String(row.id))}` : undefined,
        canEdit,
        version: String(row.updated_at ?? ""),
        locationId: String(row.location_id ?? ""),
        designationId: String(row.designation_id ?? designationRecord?.id ?? ""),
        editableKeys: canEdit ? [...ALL_PEOPLE_SHEET_EDITABLE_KEYS] : [],
        exportValues: exportValues(row, location, model, provider, status, designation)
      } satisfies AllPeopleRow;
    });

  return { rows, error: null };
}
