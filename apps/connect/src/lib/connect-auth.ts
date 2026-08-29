import { createHash, randomUUID } from "crypto";
import { cookies } from "next/headers";
import { normalizeMobile } from "@/lib/connect-otp";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  type NonEmployeeProfileType,
  type WorkforceProfileType,
  workforceLabel,
  workforceTable
} from "@/lib/workforce-profiles";

export type ConnectAccount = {
  id: string;
  companyId: string;
  profileType: "user" | WorkforceProfileType;
  name: string | null;
  email: string | null;
  reference: string | null;
  role: string | null;
  status: string | null;
  biometricId: string | null;
  profilePhotoUrl: string | null;
  pageAccess: string[];
  isDefault: boolean;
  companyName: string;
  label: string;
  workspace: "people" | "workforce";
  workspaceLabel: string;
};

type AccountRow = {
  id: string;
  company_id: string;
  full_name: string | null;
  email?: string | null;
  employee_id?: string | null;
  dropx_id?: string | null;
  biometric_id?: string | null;
  profile_photo_path?: string | null;
  role?: string | null;
  designation_id?: string | null;
  status?: string | null;
  source_profile_type?: string | null;
  source_profile_id?: string | null;
  profile_type: "user" | WorkforceProfileType;
};

type EmployeeAccountRow = {
  id: string;
  company_id: string;
  full_name: string | null;
  email?: string | null;
  employee_code?: string | null;
  designation_id?: string | null;
  biometric_id?: string | null;
  profile_photo_path?: string | null;
  profile_completion_status?: string | null;
  is_active?: boolean | null;
};

type MatchResult<T> = {
  data: T[] | null;
  error: { message?: string } | null;
};

type DesignationAccessRow = {
  id: string;
  company_id: string;
  code: string;
  name: string;
  onboarding_categories: string[] | null;
  app_page_access?: string[] | null;
};

export const connectSessionCookieName = "dropx_connect_session";

export function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;
}

export function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return (message.includes("column") || message.includes("relation")) &&
    (message.includes("does not exist") || message.includes("schema cache"));
}

export function normalizeConnectMobile(mobile: unknown, countryCode: unknown) {
  const normalizedCountryCode = String(countryCode ?? "91").replace(/\D/g, "") || "91";
  const normalizedMobile = normalizeMobile(mobile, normalizedCountryCode);
  const localMobile = normalizedMobile.startsWith(normalizedCountryCode)
    ? normalizedMobile.slice(normalizedCountryCode.length)
    : normalizedMobile;
  return { countryCode: normalizedCountryCode, mobile: normalizedMobile, localMobile };
}

function accountLabel(account: AccountRow, companyNameById: Map<string, string>) {
  const companyName = companyNameById.get(account.company_id) ?? "Company";
  const id = account.employee_id || account.dropx_id || account.email || "";
  return [companyName, account.full_name, id].filter(Boolean).join(" - ");
}

function normalizeWorkforceReference(value: unknown) {
  return String(value ?? "").trim();
}

function collectProfileWorkforceReferences(
  profiles: Array<{ company_id: string; employee_id?: string | null }>
) {
  return collectWorkforceReferencesByCompany(
    profiles.map((profile) => ({
      company_id: profile.company_id,
      references: [profile.employee_id]
    }))
  );
}

function collectWorkforceReferencesByCompany(
  seeds: Array<{ company_id: string; references: Array<unknown> }>
) {
  const referencesByCompany = new Map<string, Set<string>>();
  for (const seed of seeds) {
    for (const value of seed.references) {
      const reference = normalizeWorkforceReference(value);
      if (!reference) continue;
      const bucket = referencesByCompany.get(seed.company_id) ?? new Set<string>();
      bucket.add(reference.toLowerCase());
      referencesByCompany.set(seed.company_id, bucket);
    }
  }
  return referencesByCompany;
}

function matchesWorkforceReference(candidate: unknown, references: Set<string>) {
  const normalized = normalizeWorkforceReference(candidate).toLowerCase();
  return Boolean(normalized && references.has(normalized));
}

function mapEmployeeAccountRow(employee: EmployeeAccountRow): AccountRow {
  return {
    id: employee.id,
    company_id: employee.company_id,
    full_name: employee.full_name,
    email: employee.email,
    employee_id: employee.employee_code,
    biometric_id: employee.biometric_id ?? null,
    designation_id: employee.designation_id ?? null,
    role: "Employee",
    status: employee.profile_completion_status === "active"
      ? "Active"
      : employee.profile_completion_status === "under_review"
        ? "Under review"
        : employee.profile_completion_status === "returned"
          ? "Returned"
          : employee.profile_completion_status === "submitted"
            ? "Submitted"
            : "Pending",
    profile_type: "employee",
    profile_photo_path: employee.profile_photo_path ?? null,
  };
}

function mapNonEmployeeAccountRow(
  profile: {
    id: string;
    company_id: string;
    full_name: string | null;
    email?: string | null;
    dropx_id?: string | null;
    biometric_id?: string | null;
    designation?: string | null;
    onboarding_status?: string | null;
    profile_photo_path?: string | null;
    source_profile_type?: string | null;
    source_profile_id?: string | null;
  },
  profileType: NonEmployeeProfileType
): AccountRow {
  return {
    id: profile.id,
    company_id: profile.company_id,
    full_name: profile.full_name,
    email: profile.email,
    dropx_id: profile.dropx_id,
    biometric_id: profile.biometric_id,
    role: profile.designation || workforceLabel(profileType),
    status: profile.onboarding_status === "active"
      ? "Active"
      : profile.onboarding_status === "under_review"
        ? "Under review"
        : profile.onboarding_status === "returned"
          ? "Returned"
          : "Pending",
    profile_photo_path: profile.profile_photo_path ?? null,
    source_profile_type: profile.source_profile_type ?? null,
    source_profile_id: profile.source_profile_id ?? null,
    profile_type: profileType,
  };
}

async function loadLinkedSelfServiceRecords({
  referenceSeeds,
  knownEmployeeIds,
  knownWorkforceIds
}: {
  referenceSeeds: Array<{ company_id: string; references: Array<unknown> }>;
  knownEmployeeIds: Set<string>;
  knownWorkforceIds: Record<NonEmployeeProfileType, Set<string>>;
}) {
  const referencesByCompany = collectWorkforceReferencesByCompany(referenceSeeds);
  const linkedEmployees: EmployeeAccountRow[] = [];
  const linkedNonEmployees: Partial<Record<NonEmployeeProfileType, NonEmployeeMatch[]>> = {};
  if (!referencesByCompany.size || !supabaseAdmin) {
    return { linkedEmployees, linkedNonEmployees };
  }

  type NonEmployeeMatch = {
    id: string;
    company_id: string;
    full_name: string | null;
    email?: string | null;
    dropx_id?: string | null;
    biometric_id?: string | null;
    designation?: string | null;
    onboarding_status?: string | null;
    lifecycle_status?: string | null;
    profile_photo_path?: string | null;
    source_profile_type?: string | null;
    source_profile_id?: string | null;
    deleted_at?: string | null;
    is_active?: boolean | null;
  };

  for (const [companyId, references] of referencesByCompany) {
    const employeeResult = await supabaseAdmin
      .from("employees")
      .select("id, company_id, full_name, email, employee_code, biometric_id, designation_id, profile_completion_status, profile_photo_path, is_active")
      .eq("company_id", companyId)
      .eq("is_active", true);
    if (employeeResult.error && !isMissingColumnError(employeeResult.error)) {
      throw new Error(employeeResult.error.message);
    }
    for (const employee of employeeResult.data ?? []) {
      if (knownEmployeeIds.has(employee.id)) continue;
      if (
        !matchesWorkforceReference(employee.employee_code, references) &&
        !matchesWorkforceReference(employee.biometric_id, references)
      ) {
        continue;
      }
      linkedEmployees.push(employee as EmployeeAccountRow);
      knownEmployeeIds.add(employee.id);
    }

    for (const profileType of ["contractor", "field_executive", "workforce"] as NonEmployeeProfileType[]) {
      const table = workforceTable(profileType);
      let query = supabaseAdmin
        .from(table)
        .select("id, company_id, full_name, email, dropx_id, biometric_id, designation, onboarding_status, lifecycle_status, profile_photo_path, is_active, source_profile_type, source_profile_id, deleted_at")
        .eq("company_id", companyId);
      if (profileType === "contractor") query = query.eq("is_active", true);
      const result = await query;
      if (result.error && !isMissingColumnError(result.error)) {
        throw new Error(result.error.message);
      }
      for (const row of (result.data ?? []) as NonEmployeeMatch[]) {
        if (knownWorkforceIds[profileType].has(row.id)) continue;
        if (
          ["rejected", "cancelled"].includes(String(row.onboarding_status ?? "pending").toLowerCase()) ||
          String(row.lifecycle_status ?? "").toLowerCase() === "exited" ||
          row.deleted_at
        ) {
          continue;
        }
        if (
          !matchesWorkforceReference(row.dropx_id, references) &&
          !matchesWorkforceReference(row.biometric_id, references)
        ) {
          continue;
        }
        const bucket = linkedNonEmployees[profileType] ?? [];
        bucket.push(row);
        linkedNonEmployees[profileType] = bucket;
        knownWorkforceIds[profileType].add(row.id);
      }
    }
  }

  return { linkedEmployees, linkedNonEmployees };
}

type WorkforceRegisterRow = {
  id: string;
  company_id: string;
  full_name: string | null;
  email?: string | null;
  dropx_id?: string | null;
  biometric_id?: string | null;
  designation?: string | null;
  onboarding_status?: string | null;
  lifecycle_status?: string | null;
  profile_photo_path?: string | null;
  source_profile_type?: string | null;
  source_profile_id?: string | null;
  deleted_at?: string | null;
  is_active?: boolean | null;
};

function isActiveWorkforceRegisterRow(row: WorkforceRegisterRow) {
  return !["rejected", "cancelled"].includes(String(row.onboarding_status ?? "pending").toLowerCase()) &&
    String(row.lifecycle_status ?? "").toLowerCase() !== "exited" &&
    !row.deleted_at;
}

async function loadCanonicalWorkforceMirrors({
  sourceProfileType,
  sourceRows,
  knownWorkforceIds
}: {
  sourceProfileType: "field_executive" | "contractor";
  sourceRows: WorkforceRegisterRow[];
  knownWorkforceIds: Set<string>;
}) {
  const mirrors: WorkforceRegisterRow[] = [];
  if (!sourceRows.length || !supabaseAdmin) return mirrors;

  for (const sourceRow of sourceRows) {
    const result = await supabaseAdmin
      .from("workforce")
      .select("id, company_id, full_name, email, dropx_id, biometric_id, designation, onboarding_status, lifecycle_status, profile_photo_path, is_active, source_profile_type, source_profile_id, deleted_at")
      .eq("company_id", sourceRow.company_id)
      .eq("source_profile_type", sourceProfileType)
      .eq("source_profile_id", sourceRow.id);
    if (result.error && !isMissingColumnError(result.error)) {
      throw new Error(result.error.message);
    }
    for (const row of (result.data ?? []) as WorkforceRegisterRow[]) {
      if (!isActiveWorkforceRegisterRow(row) || knownWorkforceIds.has(row.id)) continue;
      mirrors.push(row);
      knownWorkforceIds.add(row.id);
    }
  }

  return mirrors;
}

function buildReferenceSeeds({
  profiles,
  employees,
  nonEmployeeRows
}: {
  profiles: Array<{ company_id: string; employee_id?: string | null }>;
  employees: EmployeeAccountRow[];
  nonEmployeeRows: WorkforceRegisterRow[];
}) {
  const seeds: Array<{ company_id: string; references: Array<unknown> }> = [];
  for (const profile of profiles) {
    seeds.push({ company_id: profile.company_id, references: [profile.employee_id] });
  }
  for (const employee of employees) {
    seeds.push({
      company_id: employee.company_id,
      references: [employee.employee_code, employee.biometric_id]
    });
  }
  for (const row of nonEmployeeRows) {
    seeds.push({
      company_id: row.company_id,
      references: [row.dropx_id, row.biometric_id, row.designation]
    });
  }
  return seeds;
}

async function signedProfilePhotoUrl(path?: string | null) {
  if (!supabaseAdmin || !path) return "";
  const result = await supabaseAdmin.storage
    .from("employee-profile-documents")
    .createSignedUrl(path, 60 * 60);
  return result.data?.signedUrl ?? "";
}

const defaultPageAccess = ["dashboard", "attendance", "roster", "leave", "performance", "settings"];
const managerPageAccess = ["dashboard", "approvals", "settings"];

export function connectWorkspace(profileType: ConnectAccount["profileType"]) {
  return profileType === "user" || profileType === "employee" ? "people" as const : "workforce" as const;
}

function categoryCodeForProfile(profileType: ConnectAccount["profileType"]) {
  if (profileType === "employee") return "employees";
  if (profileType === "workforce") return "field_executives";
  if (profileType === "field_executive") return "field_executives";
  if (profileType === "contractor") return "contractors";
  if (profileType === "vendor") return "vendors";
  if (profileType === "worker") return "workers";
  return "";
}

function designationLookupKey(companyId: string, categoryCode: string, value: string) {
  return `${companyId}:${categoryCode}:${value.trim().toLowerCase()}`;
}

function intersectPageAccess(categoryPages: string[], designationPages?: string[] | null) {
  if (!designationPages?.length) return categoryPages;
  const allowedByDesignation = new Set(designationPages.map((page) => page.trim().toLowerCase()));
  return categoryPages.filter((page) => allowedByDesignation.has(page.trim().toLowerCase()));
}

function resolveConnectPageAccess(
  profileType: AccountRow["profile_type"],
  categoryPages: string[],
  designationPages?: string[] | null
) {
  if (profileType === "user") return managerPageAccess;
  const pages = intersectPageAccess(categoryPages, designationPages);
  if (profileType !== "contractor") return pages;
  // Independent contractors always need core self-service even when designation pages are narrow.
  return [...new Set([...pages, "dashboard", "attendance", "roster", "settings"])];
}

const workforceMirrorProfileTypes = new Set<AccountRow["profile_type"]>([
  "workforce",
  "field_executive",
  "contractor",
  "vendor",
  "worker"
]);

function isWorkforceMirrorProfileType(profileType: AccountRow["profile_type"]) {
  return workforceMirrorProfileTypes.has(profileType);
}

async function loadPeopleOnlyDesignationKeys(companyIds: string[]) {
  const peopleOnlyDesignationIds = new Set<string>();
  const peopleOnlyDesignationKeys = new Set<string>();
  if (!companyIds.length) {
    return { peopleOnlyDesignationIds, peopleOnlyDesignationKeys };
  }

  const routesResult = await supabaseAdmin!
    .from("designation_register_routes")
    .select("company_id, designation_id, registration_enabled, workforce_register_master!inner(table_name, is_active)")
    .in("company_id", companyIds)
    .eq("registration_enabled", true)
    .eq("workforce_register_master.table_name", "employees")
    .eq("workforce_register_master.is_active", true);
  if (routesResult.error && !isMissingColumnError(routesResult.error)) {
    throw new Error(routesResult.error.message);
  }
  if (!routesResult.error) {
    for (const row of routesResult.data ?? []) {
      peopleOnlyDesignationIds.add(String(row.designation_id));
    }
  }

  const designationResult = await supabaseAdmin!
    .from("designations")
    .select("id, company_id, code, name, onboarding_categories")
    .in("company_id", companyIds)
    .eq("is_active", true);
  if (designationResult.error && !isMissingColumnError(designationResult.error)) {
    throw new Error(designationResult.error.message);
  }
  for (const designation of designationResult.data ?? []) {
    const categories = Array.isArray(designation.onboarding_categories)
      ? designation.onboarding_categories.map(String)
      : [];
    const routesToEmployeesRegister = peopleOnlyDesignationIds.has(String(designation.id));
    const employeesCategoryOnly = categories.length === 1 && categories[0] === "employees";
    if (!routesToEmployeesRegister && !employeesCategoryOnly) continue;

    peopleOnlyDesignationIds.add(String(designation.id));
    const registerCategories = new Set([
      ...categories,
      "employees",
      "field_executives",
      "contractors",
      "workforce",
      "vendors",
      "workers"
    ]);
    for (const category of registerCategories) {
      peopleOnlyDesignationKeys.add(
        designationLookupKey(String(designation.company_id), category, String(designation.name))
      );
      peopleOnlyDesignationKeys.add(
        designationLookupKey(String(designation.company_id), category, String(designation.code))
      );
    }
  }

  return { peopleOnlyDesignationIds, peopleOnlyDesignationKeys };
}

function matchesPeopleOnlyDesignation(
  account: AccountRow,
  peopleOnlyDesignationIds: Set<string>,
  peopleOnlyDesignationKeys: Set<string>
) {
  if (account.designation_id && peopleOnlyDesignationIds.has(account.designation_id)) return true;
  if (!account.role) return false;
  const categoryCode = categoryCodeForProfile(account.profile_type);
  return peopleOnlyDesignationKeys.has(designationLookupKey(account.company_id, categoryCode, account.role));
}

export async function findConnectAccounts(countryCode: string, mobile: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const localMobile = mobile.startsWith(countryCode) ? mobile.slice(countryCode.length) : mobile;
  type ProfileMatch = { id: string; company_id: string; full_name: string | null; email?: string | null; employee_id?: string | null; role?: string | null };
  type NonEmployeeMatch = { id: string; company_id: string; full_name: string | null; email?: string | null; dropx_id?: string | null; biometric_id?: string | null; designation?: string | null; onboarding_status?: string | null; lifecycle_status?: string | null; profile_photo_path?: string | null; source_profile_type?: string | null; source_profile_id?: string | null; deleted_at?: string | null };

  let profilesResult: MatchResult<ProfileMatch> = await supabaseAdmin
    .from("profiles")
    .select("id, company_id, full_name, email, employee_id, role, is_active, mobile_country_code")
    .eq("is_active", true)
    .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
    .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`);
  let employeesResult: MatchResult<EmployeeAccountRow> = await supabaseAdmin
    .from("employees")
    .select("id, company_id, full_name, email, employee_code, biometric_id, designation_id, profile_completion_status, profile_photo_path, is_active, mobile_country_code")
    .eq("is_active", true)
    .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
    .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`);

  const nonEmployeeTypes: NonEmployeeProfileType[] = ["workforce", "field_executive", "contractor", "vendor", "worker"];
  async function loadNonEmployee(profileType: NonEmployeeProfileType): Promise<MatchResult<NonEmployeeMatch>> {
    const table = workforceTable(profileType);
    let query = supabaseAdmin!
      .from(table)
      .select("id, company_id, full_name, email, dropx_id, biometric_id, designation, onboarding_status, lifecycle_status, profile_photo_path, is_active, mobile_country_code, source_profile_type, source_profile_id, deleted_at")
      .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
      .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`);
    if (!["workforce", "field_executive"].includes(profileType)) query = query.eq("is_active", true);
    let result: MatchResult<NonEmployeeMatch> = await query;
    if (!["workforce", "field_executive"].includes(profileType) && isMissingColumnError(result.error)) {
      return { data: [], error: null };
    }
    if (isMissingColumnError(result.error)) {
      let fallbackQuery = supabaseAdmin!
        .from(table)
        .select("id, company_id, full_name, email, dropx_id, biometric_id, designation, onboarding_status, is_active")
        .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`);
      if (!["workforce", "field_executive"].includes(profileType)) fallbackQuery = fallbackQuery.eq("is_active", true);
      result = await fallbackQuery;
    }
    if (!["workforce", "field_executive"].includes(profileType) && isMissingColumnError(result.error)) {
      return { data: [], error: null };
    }
    return result;
  }
  const nonEmployeeResults = (await Promise.all(nonEmployeeTypes.map(loadNonEmployee))).map((result, index) => {
    if (!["workforce", "field_executive"].includes(nonEmployeeTypes[index])) return result;
    return {
      ...result,
      data: (result.data ?? []).filter((row) =>
        !["rejected", "cancelled"].includes(String(row.onboarding_status ?? "pending").toLowerCase()) &&
        String(row.lifecycle_status ?? "").toLowerCase() !== "exited" &&
        !row.deleted_at
      )
    };
  });

  if (isMissingColumnError(profilesResult.error) || isMissingColumnError(employeesResult.error)) {
    [profilesResult, employeesResult] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, company_id, full_name, email, employee_id, role, is_active")
        .eq("is_active", true)
        .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`),
      supabaseAdmin
        .from("employees")
        .select("id, company_id, full_name, email, employee_code, biometric_id, designation_id, is_active")
        .eq("is_active", true)
        .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`)
    ]);
  }
  if (profilesResult.error) throw new Error(profilesResult.error.message);
  if (employeesResult.error && !isMissingColumnError(employeesResult.error)) throw new Error(employeesResult.error.message);
  for (const result of nonEmployeeResults) {
    if (result.error) throw new Error(result.error.message);
  }

  const knownEmployeeIds = new Set((employeesResult.data ?? []).map((employee) => employee.id));
  const knownWorkforceIds = Object.fromEntries(
    nonEmployeeTypes.map((profileType, index) => [
      profileType,
      new Set((nonEmployeeResults[index].data ?? []).map((row) => row.id))
    ])
  ) as Record<NonEmployeeProfileType, Set<string>>;

  const fieldExecutiveIndex = nonEmployeeTypes.indexOf("field_executive");
  const contractorIndex = nonEmployeeTypes.indexOf("contractor");
  const workforceIndex = nonEmployeeTypes.indexOf("workforce");
  const fieldExecutiveRows = (nonEmployeeResults[fieldExecutiveIndex]?.data ?? []) as WorkforceRegisterRow[];
  const contractorRows = (nonEmployeeResults[contractorIndex]?.data ?? []) as WorkforceRegisterRow[];

  for (const [sourceProfileType, sourceRows] of [
    ["field_executive", fieldExecutiveRows],
    ["contractor", contractorRows]
  ] as const) {
    const mirrors = await loadCanonicalWorkforceMirrors({
      sourceProfileType,
      sourceRows,
      knownWorkforceIds: knownWorkforceIds.workforce
    });
    if (!mirrors.length) continue;
    nonEmployeeResults[workforceIndex] = {
      ...nonEmployeeResults[workforceIndex],
      data: [...(nonEmployeeResults[workforceIndex].data ?? []), ...mirrors]
    };
  }

  const referenceSeeds = buildReferenceSeeds({
    profiles: profilesResult.data ?? [],
    employees: employeesResult.data ?? [],
    nonEmployeeRows: nonEmployeeTypes.flatMap((_, index) => nonEmployeeResults[index].data ?? []) as WorkforceRegisterRow[]
  });
  const linkedRecords = await loadLinkedSelfServiceRecords({
    referenceSeeds,
    knownEmployeeIds,
    knownWorkforceIds
  });
  if (linkedRecords.linkedEmployees.length) {
    employeesResult = {
      ...employeesResult,
      data: [...(employeesResult.data ?? []), ...linkedRecords.linkedEmployees]
    };
  }
  for (const profileType of ["contractor", "field_executive", "workforce"] as NonEmployeeProfileType[]) {
    const linkedRows = linkedRecords.linkedNonEmployees[profileType] ?? [];
    if (!linkedRows.length) continue;
    const index = nonEmployeeTypes.indexOf(profileType);
    if (index < 0) continue;
    nonEmployeeResults[index] = {
      ...nonEmployeeResults[index],
      data: [...(nonEmployeeResults[index].data ?? []), ...linkedRows]
    };
  }

  const employeeAccounts = (employeesResult.data ?? []).map((employee) => mapEmployeeAccountRow(employee));
  const accounts: AccountRow[] = [
    ...((profilesResult.data ?? []).map((profile) => ({
      id: profile.id,
      company_id: profile.company_id,
      full_name: profile.full_name,
      email: profile.email,
      employee_id: profile.employee_id,
      role: profile.role?.trim() || "Manager",
      status: "Active",
      profile_type: "user" as const
    }))),
    ...nonEmployeeResults.flatMap((result, index) => {
      const profileType = nonEmployeeTypes[index];
      return (result.data ?? []).map((profile) => mapNonEmployeeAccountRow(profile, profileType));
    }),
    ...employeeAccounts
  ].filter((account) => account.company_id);

  // Manager logins stay available beside self-service employee / contractor identities.
  const employeeIdsByCompany = new Set(employeeAccounts.map((account) => `${account.company_id}:${account.id}`));
  const employeeCodesByCompany = new Map<string, Set<string>>();
  const employeeBiometricsByCompany = new Map<string, Set<string>>();
  for (const employee of employeeAccounts) {
    if (employee.employee_id) {
      const codes = employeeCodesByCompany.get(employee.company_id) ?? new Set<string>();
      codes.add(String(employee.employee_id).trim().toLowerCase());
      employeeCodesByCompany.set(employee.company_id, codes);
    }
    if (employee.biometric_id) {
      const biometrics = employeeBiometricsByCompany.get(employee.company_id) ?? new Set<string>();
      biometrics.add(String(employee.biometric_id).trim().toLowerCase());
      employeeBiometricsByCompany.set(employee.company_id, biometrics);
    }
  }
  const companyIdsForRoutes = Array.from(new Set(accounts.map((account) => account.company_id)));
  const { peopleOnlyDesignationIds, peopleOnlyDesignationKeys } = await loadPeopleOnlyDesignationKeys(companyIdsForRoutes);
  const canonicalWorkforceSources = new Set(accounts
    .filter((account) => account.profile_type === "workforce" && account.source_profile_type && account.source_profile_id)
    .map((account) => `${account.company_id}:${account.source_profile_type}:${account.source_profile_id}`));
  const contractorAccountKeys = new Set(accounts
    .filter((account) => account.profile_type === "contractor")
    .map((account) => `${account.company_id}:${account.id}`));
  const visibleAccounts = accounts.filter((account) => {
    // DA / WM legacy rows move to the canonical Workforce register; IC contractors stay on contractors.
    if (account.profile_type === "field_executive") {
      return !canonicalWorkforceSources.has(`${account.company_id}:field_executive:${account.id}`);
    }
    if (!isWorkforceMirrorProfileType(account.profile_type)) {
      return true;
    }

    if (account.profile_type === "workforce") {
      if (
        account.source_profile_type === "employee" &&
        account.source_profile_id &&
        employeeIdsByCompany.has(`${account.company_id}:${account.source_profile_id}`)
      ) {
        return false;
      }
      if (
        account.source_profile_type === "contractor" &&
        account.source_profile_id &&
        contractorAccountKeys.has(`${account.company_id}:${account.source_profile_id}`)
      ) {
        return false;
      }
    }

    const peopleOnlyDesignation = matchesPeopleOnlyDesignation(
      account,
      peopleOnlyDesignationIds,
      peopleOnlyDesignationKeys
    );
    if (!peopleOnlyDesignation) {
      return true;
    }

    const employeeCodes = employeeCodesByCompany.get(account.company_id);
    const employeeBiometrics = employeeBiometricsByCompany.get(account.company_id);
    return !(
      (account.source_profile_type === "employee" &&
        account.source_profile_id &&
        employeeIdsByCompany.has(`${account.company_id}:${account.source_profile_id}`)) ||
      (employeeCodes && account.dropx_id && employeeCodes.has(String(account.dropx_id).trim().toLowerCase())) ||
      (employeeBiometrics && account.biometric_id && employeeBiometrics.has(String(account.biometric_id).trim().toLowerCase()))
    );
  });

  const companyIds = Array.from(new Set(visibleAccounts.map((account) => account.company_id)));
  const companiesResult = companyIds.length
    ? await supabaseAdmin.from("companies").select("id, name, code").in("id", companyIds).eq("is_active", true)
    : { data: [], error: null };
  if (companiesResult.error) throw new Error(companiesResult.error.message);
  const companyNameById = new Map((companiesResult.data ?? []).map((company) => [company.id, company.name || company.code || "Company"]));
  const categoryResult = companyIds.length
    ? await supabaseAdmin
      .from("workforce_categories")
      .select("company_id, code, app_page_access")
      .in("company_id", companyIds)
      .eq("is_active", true)
    : { data: [], error: null };
  const pageAccessByCategory = new Map<string, string[]>();
  if (!categoryResult.error) {
    for (const category of categoryResult.data ?? []) {
      const pages = Array.isArray(category.app_page_access)
        ? category.app_page_access.map(String)
        : defaultPageAccess;
      pageAccessByCategory.set(`${category.company_id}:${category.code}`, pages);
    }
  }
  const designationResult = companyIds.length
    ? await supabaseAdmin
      .from("designations")
      .select("id, company_id, code, name, onboarding_categories, app_page_access")
      .in("company_id", companyIds)
      .eq("is_active", true)
    : { data: [], error: null };
  let designationRows: DesignationAccessRow[] = (designationResult.data ?? []) as DesignationAccessRow[];
  let designationAccessAvailable = true;
  if (isMissingColumnError(designationResult.error)) {
    designationAccessAvailable = false;
    const fallbackResult = companyIds.length
      ? await supabaseAdmin
        .from("designations")
        .select("id, company_id, code, name, onboarding_categories")
        .in("company_id", companyIds)
        .eq("is_active", true)
      : { data: [], error: null };
    if (fallbackResult.error && !isMissingColumnError(fallbackResult.error)) {
      throw new Error(fallbackResult.error.message);
    }
    designationRows = (fallbackResult.data ?? []).map((designation) => ({
      ...designation,
      app_page_access: null
    })) as DesignationAccessRow[];
  } else if (designationResult.error) {
    throw new Error(designationResult.error.message);
  }
  const pageAccessByDesignationId = new Map<string, string[] | null>();
  const designationNameById = new Map<string, string>();
  const pageAccessByDesignationKey = new Map<string, string[] | null>();
  for (const designation of designationRows) {
    const pages = designationAccessAvailable && Array.isArray((designation as { app_page_access?: unknown }).app_page_access)
      ? (designation as { app_page_access: unknown[] }).app_page_access.map(String)
      : null;
    pageAccessByDesignationId.set(String(designation.id), pages);
    designationNameById.set(String(designation.id), String(designation.name || designation.code));
    const categories = Array.isArray(designation.onboarding_categories)
      ? designation.onboarding_categories.map(String)
      : [];
    for (const category of categories) {
      pageAccessByDesignationKey.set(
        designationLookupKey(String(designation.company_id), category, String(designation.name)),
        pages
      );
      pageAccessByDesignationKey.set(
        designationLookupKey(String(designation.company_id), category, String(designation.code)),
        pages
      );
    }
  }
  const preferenceResult = await supabaseAdmin
    .from("mob_app_user_preferences")
    .select("default_company_id, default_profile_type, default_account_id")
    .eq("country_code", countryCode)
    .eq("mobile_number", mobile)
    .maybeSingle();
  const preferenceTableMissing = isMissingColumnError(preferenceResult.error) ||
    String(preferenceResult.error?.message ?? "").toLowerCase().includes("mob_app_user_preferences");
  if (preferenceResult.error && !preferenceTableMissing) {
    throw new Error(preferenceResult.error.message);
  }
  const defaultPreference = preferenceResult.error ? null : preferenceResult.data;

  return Promise.all(visibleAccounts
    .filter((account) => companyNameById.has(account.company_id))
    .map(async (account): Promise<ConnectAccount> => {
      const categoryCode = categoryCodeForProfile(account.profile_type);
      const categoryPages = pageAccessByCategory.get(`${account.company_id}:${categoryCode}`) ?? defaultPageAccess;
      const designationPages = account.designation_id
        ? pageAccessByDesignationId.get(account.designation_id)
        : account.role
          ? pageAccessByDesignationKey.get(designationLookupKey(account.company_id, categoryCode, account.role))
          : undefined;

      return {
      id: account.id,
      companyId: account.company_id,
      profileType: account.profile_type,
      name: account.full_name,
      email: account.email ?? null,
      reference: account.employee_id || account.dropx_id || null,
      role: account.profile_type === "user"
        ? account.role ?? "Manager"
        : account.designation_id
        ? designationNameById.get(String(account.designation_id)) ?? null
        : account.role === "Employee"
          ? null
          : account.role ?? null,
      status: account.status ?? null,
      biometricId: account.biometric_id ?? null,
      profilePhotoUrl: await signedProfilePhotoUrl(account.profile_photo_path),
      pageAccess: resolveConnectPageAccess(account.profile_type, categoryPages, designationPages),
      isDefault: defaultPreference?.default_company_id === account.company_id &&
        defaultPreference?.default_profile_type === account.profile_type &&
        defaultPreference?.default_account_id === account.id,
      companyName: companyNameById.get(account.company_id) ?? "Company",
      label: accountLabel(account, companyNameById),
      workspace: connectWorkspace(account.profile_type),
      workspaceLabel: account.profile_type === "user"
        ? "People workspace · Manager"
        : connectWorkspace(account.profile_type) === "people"
          ? "People workspace"
          : "Workforce workspace"
      };
    }));
}

export function createSecretHash(value: string) {
  const salt = randomUUID();
  const hash = createHash("sha256").update(`${salt}:${value}`).digest("hex");
  return `${salt}:${hash}`;
}

export function verifySecretHash(value: string, storedHash: string) {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  return createHash("sha256").update(`${salt}:${value}`).digest("hex") === hash;
}

export async function createConnectSession({
  countryCode,
  mobile,
  request
}: {
  countryCode: string;
  mobile: string;
  request: Request;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const token = randomUUID() + randomUUID();
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
  const insertResult = await supabaseAdmin.from("connect_login_sessions").insert({
    country_code: countryCode,
    mobile_number: mobile,
    session_hash: sessionHash,
    expires_at: expiresAt.toISOString(),
    request_ip: requestIp(request),
    user_agent: request.headers.get("user-agent")
  });
  if (insertResult.error) throw new Error(insertResult.error.message);
  cookies().set(connectSessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    expires: expiresAt
  });
}

export async function requireConnectAccount(profileType: ConnectAccount["profileType"], accountId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) throw new Error("Connect session expired. Please log in again.");
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const { data: session, error } = await supabaseAdmin.from("connect_login_sessions")
    .select("country_code, mobile_number, expires_at, revoked_at").eq("session_hash", sessionHash).maybeSingle();
  if (error) throw new Error(error.message);
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
    cookies().delete(connectSessionCookieName);
    throw new Error("Connect session expired. Please log in again.");
  }
  const accounts = await findConnectAccounts(session.country_code, session.mobile_number);
  const account = accounts.find((item) => item.profileType === profileType && item.id === accountId);
  if (!account) throw new Error("This account is not available for the current login.");
  return account;
}
