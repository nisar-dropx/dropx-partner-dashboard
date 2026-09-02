import { AppShell } from "@/components/app-shell";
import { AllPeopleRegister, type AllPeopleRow } from "@/components/all-people-register";
import { PageHead } from "@/components/page-head";
import { getAuthorization, hasPermission, isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { dynamicWorkforceTable, isCustomWorkforceCategoryCode, workforceCategoryPageCode } from "@/lib/dynamic-workforce";
import { canAccessDesignationPortal } from "@/lib/designation-portal-access";
import { loadCanonicalWorkforcePeople } from "@/lib/canonical-workforce-people";
import type { AllPeopleExportValues } from "@/lib/all-people-export";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { redirect } from "next/navigation";

const sources = [
  { categoryCode: "employees", category: "Employees", pageCode: "employees", basePath: "/employees", table: "employees", codeField: "employee_code", statusField: "profile_completion_status", employeeDesignation: true },
  { categoryCode: "contractors", category: "Independent Contractor", pageCode: "contractors", basePath: "/contractors", table: "contractors", codeField: "dropx_id", statusField: "onboarding_status", employeeDesignation: false },
  { categoryCode: "vendors", category: "Vendors", pageCode: "vendors", basePath: "/vendors", table: "vendors", codeField: "dropx_id", statusField: "onboarding_status", employeeDesignation: false },
  { categoryCode: "workers", category: "Helpers", pageCode: "workers", basePath: "/helpers", table: "workers", codeField: "dropx_id", statusField: "onboarding_status", employeeDesignation: false }
] as const;

type PeopleSource = (typeof sources)[number] & { canEdit: boolean };

function first<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function displayStatus(value: unknown, active: boolean) {
  if (!active) return "Inactive";
  const text = String(value ?? "pending").replaceAll("_", " ");
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function profileActionHref(basePath: string, action: "view" | "edit", profileId: unknown) {
  return `${basePath}?${action}=${encodeURIComponent(String(profileId ?? ""))}`;
}

function peopleIdentityKeys(row: AllPeopleRow) {
  const keys: string[] = [];
  const code = row.code.trim().toUpperCase();
  const biometricId = row.biometricId.trim();
  if (code && code !== "-") keys.push(`code:${code}`);
  if (biometricId && biometricId !== "-") keys.push(`biometric:${biometricId}`);
  return keys;
}

const sharedProfileColumns = [
  "full_name", "mobile_country_code", "mobile", "email", "date_of_join", "is_active", "statutory_applicability",
  "gender", "date_of_birth", "aadhaar_number", "pan_number", "eshram_uan", "father_name", "blood_group",
  "is_handicapped", "address", "state_code", "landmark", "bank_account_no", "pf_uan", "pf_account_no", "esi_no",
  "emergency_contact_number", "emergency_contact_name", "emergency_contact_relation", "driving_license_no",
  "driving_license_exp_date", "vehicle_reg_no", "vehicle_reg_exp_date", "vehicle_insurance_exp_date",
  "vehicle_pollution_exp_date", "aadhaar_front_path", "aadhaar_back_path", "pan_upload_path", "dl_front_path",
  "dl_back_path", "profile_photo_path", "profile_return_remarks", "created_at", "updated_at"
].join(", ");

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function dateText(value: unknown) {
  const raw = text(value).trim();
  if (!raw) return "";
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(date).replace(",", "");
}

function booleanText(value: unknown) {
  return value === true ? "Yes" : value === false ? "No" : "";
}

function listText(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean).join(", ") : text(value);
}

function buildExportValues(
  row: Record<string, unknown>,
  codeField: string,
  category: string,
  location: string,
  designation: string,
  status: string,
  employee: boolean
): AllPeopleExportValues {
  const countryCode = text(row.mobile_country_code).replace(/^\+/, "");
  return {
    dropxId: text(row[codeField]),
    biometricId: text(row.biometric_id),
    fullName: text(row.full_name),
    category,
    mobileCountryCode: countryCode ? `+${countryCode}` : "",
    mobileNumber: text(row.mobile),
    email: text(row.email),
    dateOfJoin: dateText(row.date_of_join),
    location,
    designation,
    status,
    active: booleanText(row.is_active),
    statutoryApplicability: listText(row.statutory_applicability),
    gender: text(row.gender),
    dateOfBirth: dateText(row.date_of_birth),
    aadhaarNumber: text(row.aadhaar_number),
    panNumber: text(row.pan_number),
    eshramUan: text(row.eshram_uan),
    fatherName: text(row.father_name),
    bloodGroup: text(row.blood_group),
    handicapped: booleanText(row.is_handicapped),
    address: text(row.address),
    stateCode: text(row.state_code),
    pincode: text(row[employee ? "pincode" : "postal_pin"]),
    landmark: text(row.landmark),
    bankAccountNumber: text(row.bank_account_no),
    ifsc: text(row[employee ? "ifsc" : "ifsc_code"]),
    pfUan: text(row.pf_uan),
    pfAccountNumber: text(row.pf_account_no),
    esiNumber: text(row.esi_no),
    emergencyContactNumber: text(row.emergency_contact_number),
    emergencyContactName: text(row.emergency_contact_name),
    emergencyContactRelation: text(row.emergency_contact_relation),
    drivingLicenseNumber: text(row.driving_license_no),
    drivingLicenseExpiry: dateText(row.driving_license_exp_date),
    vehicleRegistrationNumber: text(row.vehicle_reg_no),
    vehicleRegistrationExpiry: dateText(row.vehicle_reg_exp_date),
    vehicleInsuranceExpiry: dateText(row.vehicle_insurance_exp_date),
    pollutionExpiry: dateText(row.vehicle_pollution_exp_date),
    aadhaarFrontFile: text(row.aadhaar_front_path),
    aadhaarBackFile: text(row.aadhaar_back_path),
    panFile: text(row.pan_upload_path),
    drivingLicenseFrontFile: text(row.dl_front_path),
    drivingLicenseBackFile: text(row.dl_back_path),
    profilePhotoFile: text(row.profile_photo_path),
    returnRemarks: text(row.profile_return_remarks),
    createdAt: dateText(row.created_at),
    updatedAt: dateText(row.updated_at)
  };
}

async function loadPeople(
  companyId: string,
  allowedSources: PeopleSource[],
  locationScopeIds: string[],
  hasAllLocationAccess: boolean,
  authorization: AuthorizationContext
) {
  if (!supabaseAdmin) {
    return {
      categories: [] as Array<{ code: string; name: string }>,
      rows: [] as AllPeopleRow[],
      error: "Supabase service role key is not configured."
    };
  }
  const categoryResult = await supabaseAdmin
    .from("workforce_categories")
    .select("code, name")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("sort_order")
    .order("name");
  const categories = (categoryResult.data ?? []) as Array<{ code: string; name: string }>;
  const designationResult = await supabaseAdmin
    .from("designations")
    .select("id, name, portal_permissions")
    .eq("company_id", companyId)
    .eq("is_active", true);
  const designations = (designationResult.data ?? []) as Array<{ id: string; name: string; portal_permissions: unknown }>;
  const designationById = new Map(designations.map((designation) => [designation.id, designation]));
  const designationByName = new Map(designations.map((designation) => [designation.name.trim().toLowerCase(), designation]));
  const ownerAccess = isCompanyOwner(authorization);
  const activeCategoryCodes = new Set(categories.map((category) => category.code));
  const currentSources = allowedSources.filter((source) => activeCategoryCodes.has(source.categoryCode));
  const customSources = categories
    .filter((category) => isCustomWorkforceCategoryCode(category.code))
    .map((category) => ({
      categoryCode: category.code,
      category: category.name,
      table: dynamicWorkforceTable(category.code),
      codeField: "dropx_id",
      statusField: "onboarding_status",
      basePath: `/people/category/${encodeURIComponent(category.code)}`,
      canEdit: hasPermission(authorization, workforceCategoryPageCode(category.code), "edit")
    }));
  const results = await Promise.all(currentSources.map(async (source) => {
    const designationFields = source.employeeDesignation ? ", designation_id, designations (id, name)" : ", designation";
    const sourceSpecificFields = source.employeeDesignation ? ", pincode, ifsc" : ", postal_pin, ifsc_code";
    const result = await supabaseAdmin!
      .from(source.table)
      .select(`id, ${sharedProfileColumns}, biometric_id, location_id, ${source.codeField}, ${source.statusField}, stations (station_code)${designationFields}${sourceSpecificFields}`)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });
    if (result.error) return { rows: [] as AllPeopleRow[], error: result.error.message };
    const sourceRows = (result.data ?? []) as unknown as Record<string, unknown>[];
    return {
      error: null,
      rows: sourceRows
        .filter((row: Record<string, unknown>) => {
          if (!hasAllLocationAccess && !locationScopeIds.includes(String(row.location_id ?? ""))) return false;
          const joinedDesignation = first(row.designations as { id?: string; name?: string } | Array<{ id?: string; name?: string }> | null);
          const designation = source.employeeDesignation
            ? designationById.get(String(row.designation_id ?? joinedDesignation?.id ?? ""))
            : designationByName.get(String(row.designation ?? "").trim().toLowerCase());
          return canAccessDesignationPortal(designation, "dashboard", "view", { isOwner: ownerAccess });
        })
        .map((row: Record<string, unknown>) => {
          const location = String((first(row.stations as { station_code?: string } | Array<{ station_code?: string }> | null) ?? {}).station_code ?? "-");
          const joinedDesignation = first(row.designations as { id?: string; name?: string } | Array<{ id?: string; name?: string }> | null);
          const designationRecord = source.employeeDesignation
            ? designationById.get(String(row.designation_id ?? joinedDesignation?.id ?? ""))
            : designationByName.get(String(row.designation ?? "").trim().toLowerCase());
          const designation = String(row.designation ?? joinedDesignation?.name ?? "-");
          const status = displayStatus(row[source.statusField], row.is_active !== false);
          return {
            id: String(row.id),
            category: source.category,
            categoryCode: source.categoryCode,
            code: String(row[source.codeField] ?? "-"),
            biometricId: String(row.biometric_id ?? "-"),
            fullName: String(row.full_name ?? "-"),
            mobile: `+${String(row.mobile_country_code ?? "91")} ${String(row.mobile ?? "")}`,
            email: String(row.email ?? "-"),
            location,
            designation,
            status,
            viewHref: profileActionHref(source.basePath, "view", row.id),
            editHref: profileActionHref(source.basePath, "edit", row.id),
            canEdit: source.canEdit && canAccessDesignationPortal(designationRecord, "dashboard", "edit", { isOwner: ownerAccess }),
            exportValues: buildExportValues(row, source.codeField, source.category, location, designation, status, source.employeeDesignation)
          };
        })
    };
  }));
  const customResults = await Promise.all(customSources.map(async (source) => {
    const result = await supabaseAdmin!
      .from(source.table)
      .select(`id, ${sharedProfileColumns}, biometric_id, location_id, dropx_id, onboarding_status, postal_pin, ifsc_code, stations (station_code), designation`)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });
    if (result.error) return { rows: [] as AllPeopleRow[], error: result.error.message };
    const sourceRows = (result.data ?? []) as unknown as Record<string, unknown>[];
    return {
      error: null,
      rows: sourceRows
        .filter((row: Record<string, unknown>) => {
          if (!hasAllLocationAccess && !locationScopeIds.includes(String(row.location_id ?? ""))) return false;
          const designation = designationByName.get(String(row.designation ?? "").trim().toLowerCase());
          return canAccessDesignationPortal(designation, "dashboard", "view", { isOwner: ownerAccess });
        })
        .map((row: Record<string, unknown>) => {
          const location = String((first(row.stations as { station_code?: string } | Array<{ station_code?: string }> | null) ?? {}).station_code ?? "-");
          const designation = String(row.designation ?? "-");
          const designationRecord = designationByName.get(designation.trim().toLowerCase());
          const status = displayStatus(row[source.statusField], row.is_active !== false);
          return {
            id: String(row.id),
            category: source.category,
            categoryCode: source.categoryCode,
            code: String(row[source.codeField] ?? "-"),
            biometricId: String(row.biometric_id ?? "-"),
            fullName: String(row.full_name ?? "-"),
            mobile: `+${String(row.mobile_country_code ?? "91")} ${String(row.mobile ?? "")}`,
            email: String(row.email ?? "-"),
            location,
            designation,
            status,
            viewHref: profileActionHref(source.basePath, "view", row.id),
            editHref: profileActionHref(source.basePath, "edit", row.id),
            canEdit: source.canEdit && canAccessDesignationPortal(designationRecord, "dashboard", "edit", { isOwner: ownerAccess }),
            exportValues: buildExportValues(row, source.codeField, source.category, location, designation, status, false)
          };
        })
    };
  }));
  const workforceResult = await loadCanonicalWorkforcePeople(companyId, locationScopeIds, hasAllLocationAccess, {
    canView: hasPermission(authorization, "delivery_associates", "access"),
    canEdit: hasPermission(authorization, "delivery_associates", "edit")
  });
  const allResults = [...results, ...customResults];
  const sourceRows = allResults.flatMap((result) => result.rows);
  const contractorIdentityKeys = new Set(sourceRows
    .filter((row) => row.categoryCode === "contractors")
    .flatMap(peopleIdentityKeys));
  const categoryRows = sourceRows.filter((row) => row.categoryCode !== "employees"
    || !peopleIdentityKeys(row).some((key) => contractorIdentityKeys.has(key)));
  return {
    categories,
    rows: [...categoryRows, ...workforceResult.rows],
    error: categoryResult.error?.message ?? designationResult.error?.message ?? allResults.find((result) => result.error)?.error ?? workforceResult.error ?? null
  };
}

export const dynamic = "force-dynamic";

export default async function AllPeoplePage() {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!hasPermission(authorization, "people_all", "access")) redirect("/unauthorized?page=people_all&action=access");
  const allowedSources: PeopleSource[] = sources.map((source) => ({
    ...source,
    canEdit: hasPermission(authorization, source.pageCode, "edit")
  }));
  const companyId = requireCompanyId(authorization);
  const data = await loadPeople(
    companyId,
    allowedSources,
    authorization.locationScopeIds,
    authorization.hasAllLocationAccess,
    authorization
  );
  return (
    <AppShell active="All People" pageCode="people_all">
      <PageHead eyebrow="People" title="All People" subtitle="View every workforce category in one consolidated register." />
      {data.error ? (
        <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load people</strong><p className="subtle">{data.error}</p></div></section>
      ) : null}
      <AllPeopleRegister rows={data.rows} />
    </AppShell>
  );
}
