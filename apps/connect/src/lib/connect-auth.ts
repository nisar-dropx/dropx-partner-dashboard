import { createHash, randomUUID } from "crypto";
import { cookies } from "next/headers";
import { normalizeMobile } from "@/lib/connect-otp";
import { todayInIndia } from "@/lib/india-date";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  type NonEmployeeProfileType,
  type WorkforceProfileType,
  workforceLabel,
  workforceTable
} from "@/lib/workforce-profiles";
import { requiredDropxOnePageCodes } from "@/lib/dropx-one-pages";

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
  designation_category_id?: string | null;
  onboarding_categories: string[] | null;
  app_page_access?: string[] | null;
};

type DesignationCategoryRow = {
  id: string;
  company_id: string;
  code: string;
  people_module: string | null;
};

type PeopleEngagementRow = {
  id: string;
  company_id: string;
  worker_type: string;
  employee_id: string | null;
  contractor_id: string | null;
};

type PeopleAssignmentRow = {
  engagement_id: string;
  company_id: string;
  designation_id: string | null;
  position_title: string | null;
  effective_from: string;
};

type PeopleAssignmentMetadata = {
  designationId: string | null;
  positionTitle: string | null;
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

const nonEmployeeBaseSelect = "id,company_id,full_name,email,dropx_id,biometric_id,designation,onboarding_status,lifecycle_status,profile_photo_path,is_active";

function nonEmployeeSelect(profileType: NonEmployeeProfileType, includeMobile = false) {
  const mobileColumns = includeMobile ? ",mobile,mobile_country_code" : "";
  if (profileType === "workforce") {
    return `${nonEmployeeBaseSelect}${mobileColumns},source_profile_type,source_profile_id,deleted_at`;
  }
  if (profileType === "contractor") {
    return `${nonEmployeeBaseSelect}${mobileColumns},deleted_at`;
  }
  return `${nonEmployeeBaseSelect}${mobileColumns}`;
}

function icContractorReferenceKey(companyId: string, reference: string) {
  return `${companyId}:${reference.trim().toLowerCase()}`;
}

function isConnectManagerLogin(role?: string | null) {
  const normalized = String(role ?? "").trim().toLowerCase();
  return normalized === "admin" || normalized.includes("manager");
}

function shouldHideIcManagerLogin(
  account: AccountRow,
  selfServiceReferences: Set<string>
) {
  if (account.profile_type !== "user") return false;
  const profileReference = normalizeWorkforceReference(account.employee_id).toLowerCase();
  if (!profileReference) return false;
  if (!selfServiceReferences.has(icContractorReferenceKey(account.company_id, profileReference))) return false;
  if (isConnectManagerLogin(account.role)) return false;
  return true;
}

function collectSelfServiceReferences(accounts: AccountRow[]) {
  const references = new Set<string>();
  for (const account of accounts) {
    if (["user", "vendor", "worker"].includes(account.profile_type)) continue;
    for (const value of [account.employee_id, account.dropx_id, account.biometric_id]) {
      const reference = normalizeWorkforceReference(value).toLowerCase();
      if (!reference) continue;
      references.add(icContractorReferenceKey(account.company_id, reference));
    }
  }
  return references;
}

function rowMatchesReferences(
  row: { id?: string | null; dropx_id?: string | null; biometric_id?: string | null; employee_code?: string | null },
  references: Set<string>
) {
  const idReference = normalizeWorkforceReference(row.id).toLowerCase();
  const dropxReference = normalizeWorkforceReference(row.dropx_id).toLowerCase();
  const biometricReference = normalizeWorkforceReference(row.biometric_id).toLowerCase();
  const employeeCodeReference = normalizeWorkforceReference(row.employee_code).toLowerCase();
  return (
    (idReference && references.has(idReference)) ||
    (dropxReference && references.has(dropxReference)) ||
    (biometricReference && references.has(biometricReference)) ||
    (employeeCodeReference && references.has(employeeCodeReference))
  );
}

function accountIdentityKey(account: Pick<AccountRow, "profile_type" | "company_id" | "id">) {
  return `${account.profile_type}:${account.company_id}:${account.id}`;
}

function peopleWorkerKey(profileType: AccountRow["profile_type"], companyId: string, id: string) {
  if (profileType !== "employee" && profileType !== "contractor") return "";
  return `${profileType}:${companyId}:${id}`;
}

async function loadPeopleAssignmentMetadata(accounts: AccountRow[]) {
  if (!supabaseAdmin) return new Map<string, PeopleAssignmentMetadata>();
  const employeeIds = [...new Set(accounts.filter((account) => account.profile_type === "employee").map((account) => account.id))];
  const contractorIds = [...new Set(accounts.filter((account) => account.profile_type === "contractor").map((account) => account.id))];
  const empty = { data: [] as PeopleEngagementRow[], error: null as { message?: string } | null };
  const [employeeResult, contractorResult] = await Promise.all([
    employeeIds.length
      ? supabaseAdmin.from("hr_engagements")
        .select("id,company_id,worker_type,employee_id,contractor_id")
        .eq("worker_type", "employee").eq("status", "active").in("employee_id", employeeIds)
      : Promise.resolve(empty),
    contractorIds.length
      ? supabaseAdmin.from("hr_engagements")
        .select("id,company_id,worker_type,employee_id,contractor_id")
        .eq("worker_type", "contractor").eq("status", "active").in("contractor_id", contractorIds)
      : Promise.resolve(empty)
  ]);
  if (employeeResult.error && !isMissingColumnError(employeeResult.error)) throw new Error(employeeResult.error.message);
  if (contractorResult.error && !isMissingColumnError(contractorResult.error)) throw new Error(contractorResult.error.message);
  const engagements = [
    ...((employeeResult.data ?? []) as PeopleEngagementRow[]),
    ...((contractorResult.data ?? []) as PeopleEngagementRow[])
  ];
  if (!engagements.length) return new Map<string, PeopleAssignmentMetadata>();

  const today = todayInIndia();
  const assignmentResult = await supabaseAdmin.from("hr_work_assignments")
    .select("engagement_id,company_id,designation_id,position_title,effective_from")
    .in("engagement_id", engagements.map((engagement) => engagement.id))
    .eq("is_primary", true)
    .lte("effective_from", today)
    .or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false });
  if (assignmentResult.error && !isMissingColumnError(assignmentResult.error)) throw new Error(assignmentResult.error.message);
  const assignmentByEngagement = new Map<string, PeopleAssignmentRow>();
  for (const assignment of (assignmentResult.data ?? []) as PeopleAssignmentRow[]) {
    if (!assignmentByEngagement.has(assignment.engagement_id)) {
      assignmentByEngagement.set(assignment.engagement_id, assignment);
    }
  }

  const metadata = new Map<string, PeopleAssignmentMetadata>();
  for (const engagement of engagements) {
    const workerId = engagement.worker_type === "contractor" ? engagement.contractor_id : engagement.employee_id;
    if (!workerId) continue;
    const assignment = assignmentByEngagement.get(engagement.id);
    if (!assignment) continue;
    metadata.set(peopleWorkerKey(
      engagement.worker_type === "contractor" ? "contractor" : "employee",
      engagement.company_id,
      workerId
    ), {
      designationId: assignment.designation_id,
      positionTitle: assignment.position_title
    });
  }
  return metadata;
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

async function resolveIcSelfServiceByReference(
  companyId: string,
  reference: string,
  countryCode: string,
  mobile: string,
  localMobile: string
): Promise<AccountRow | null> {
  if (!supabaseAdmin || !reference) return null;

  const references = new Set([reference.toLowerCase()]);
  const mobileOr = `mobile.eq.${mobile},mobile.eq.${localMobile}`;

  const employeeResult = await supabaseAdmin
    .from("employees")
    .select("id, company_id, full_name, email, employee_code, biometric_id, designation_id, profile_completion_status, profile_photo_path, is_active")
    .eq("company_id", companyId)
    .eq("is_active", true);
  if (employeeResult.error && !isMissingColumnError(employeeResult.error)) {
    throw new Error(employeeResult.error.message);
  }
  for (const employee of (employeeResult.data ?? []) as EmployeeAccountRow[]) {
    if (rowMatchesReferences(employee, references)) {
      return mapEmployeeAccountRow(employee);
    }
  }

  async function resolveContractor(requireActive: boolean) {
    let query = supabaseAdmin!
      .from("contractors")
      .select(nonEmployeeSelect("contractor"))
      .eq("company_id", companyId);
    if (requireActive) query = query.eq("is_active", true);
    const result = await query;
    if (result.error && !isMissingColumnError(result.error)) {
      throw new Error(result.error.message);
    }
    for (const row of (result.data ?? []) as unknown as WorkforceRegisterRow[]) {
      if (!rowMatchesReferences(row, references)) continue;
      if (
        ["rejected", "cancelled"].includes(String(row.onboarding_status ?? "pending").toLowerCase()) ||
        String(row.lifecycle_status ?? "").toLowerCase() === "exited" ||
        row.deleted_at
      ) {
        continue;
      }
      return mapNonEmployeeAccountRow(row, "contractor");
    }
    return null;
  }

  const activeContractor = await resolveContractor(true);
  if (activeContractor) return activeContractor;
  const inactiveContractor = await resolveContractor(false);
  if (inactiveContractor) return inactiveContractor;

  for (const profileType of ["workforce"] as NonEmployeeProfileType[]) {
    const table = workforceTable(profileType);
    const result = await supabaseAdmin
      .from(table)
      .select(nonEmployeeSelect(profileType))
      .eq("company_id", companyId);
    if (result.error && !isMissingColumnError(result.error)) {
      throw new Error(result.error.message);
    }
    for (const row of (result.data ?? []) as unknown as WorkforceRegisterRow[]) {
      if (!rowMatchesReferences(row, references) || !isActiveWorkforceRegisterRow(row)) continue;
      return mapNonEmployeeAccountRow(row, profileType);
    }
  }

  const employeeByMobile = await supabaseAdmin
    .from("employees")
    .select("id, company_id, full_name, email, employee_code, biometric_id, designation_id, profile_completion_status, profile_photo_path, is_active")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .or(mobileOr);
  if (employeeByMobile.error && !isMissingColumnError(employeeByMobile.error)) {
    throw new Error(employeeByMobile.error.message);
  }
  const employeeMatch = (employeeByMobile.data ?? [])[0] as EmployeeAccountRow | undefined;
  if (employeeMatch) return mapEmployeeAccountRow(employeeMatch);

  const contractorByMobile = await supabaseAdmin
    .from("contractors")
    .select(nonEmployeeSelect("contractor"))
    .eq("company_id", companyId)
    .eq("is_active", true)
    .or(mobileOr);
  if (contractorByMobile.error && !isMissingColumnError(contractorByMobile.error)) {
    throw new Error(contractorByMobile.error.message);
  }
  const contractorMatch = ((contractorByMobile.data ?? []) as unknown as WorkforceRegisterRow[]).find(isActiveWorkforceRegisterRow);
  if (contractorMatch) return mapNonEmployeeAccountRow(contractorMatch, "contractor");

  return null;
}

async function enrichAccountsWithIcSelfService(
  profileUsers: Array<{ company_id: string; employee_id?: string | null; role?: string | null }>,
  accounts: AccountRow[],
  countryCode: string,
  mobile: string,
  localMobile: string
) {
  const existingKeys = new Set(accounts.map((account) => accountIdentityKey(account)));
  for (const profile of profileUsers) {
    if (isConnectManagerLogin(profile.role)) continue;
    const reference = normalizeWorkforceReference(profile.employee_id);
    if (!reference) continue;
    const resolved = await resolveIcSelfServiceByReference(
      profile.company_id,
      reference,
      countryCode,
      mobile,
      localMobile
    );
    if (!resolved) continue;
    const key = accountIdentityKey(resolved);
    if (existingKeys.has(key)) continue;
    accounts.push(resolved);
    existingKeys.add(key);
  }
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

async function signedProfilePhotoUrl(path?: string | null) {
  if (!supabaseAdmin || !path) return "";
  const result = await supabaseAdmin.storage
    .from("employee-profile-documents")
    .createSignedUrl(path, 60 * 60);
  return result.data?.signedUrl ?? "";
}

const managerPageAccess = ["dashboard", "approvals", "settings"];

export function connectWorkspace(
  profileType: ConnectAccount["profileType"],
  peopleModule?: string | null
) {
  if (profileType === "user" || profileType === "employee") return "people" as const;
  // The designation-category master owns the People/Workforce boundary. This
  // keeps independent contractors in People when their active assignment is a
  // People role, without carrying a list of designation codes in the app.
  if (String(peopleModule ?? "").trim().toLowerCase().startsWith("people")) {
    return "people" as const;
  }
  return "workforce" as const;
}

function categoryCodeForProfile(profileType: ConnectAccount["profileType"]) {
  if (profileType === "employee") return "employees";
  if (profileType === "workforce") return "workforce";
  if (profileType === "field_executive") return "workforce";
  if (profileType === "contractor") return "contractors";
  if (profileType === "vendor") return "vendors";
  if (profileType === "worker") return "workers";
  return "";
}

function designationLookupKey(companyId: string, categoryCode: string, value: string) {
  return `${companyId}:${categoryCode}:${value.trim().toLowerCase()}`;
}

function intersectPageAccess(categoryPages: string[], designationPages?: string[] | null) {
  if (!designationPages) return [];
  const allowedByDesignation = new Set(designationPages.map((page) => page.trim().toLowerCase()));
  return categoryPages.filter((page) => allowedByDesignation.has(page.trim().toLowerCase()));
}

function resolveConnectPageAccess(
  profileType: AccountRow["profile_type"],
  categoryPages: string[],
  designationPages?: string[] | null
) {
  if (profileType === "user") return managerPageAccess;
  return [...new Set([
    ...intersectPageAccess(categoryPages, designationPages),
    ...requiredDropxOnePageCodes
  ])];
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

  const nonEmployeeTypes: NonEmployeeProfileType[] = ["workforce", "contractor", "vendor", "worker"];
  async function loadNonEmployee(profileType: NonEmployeeProfileType): Promise<MatchResult<NonEmployeeMatch>> {
    const table = workforceTable(profileType);
    let query = supabaseAdmin!
      .from(table)
      .select(nonEmployeeSelect(profileType, true))
      .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
      .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`);
    if (!["workforce", "field_executive"].includes(profileType)) query = query.eq("is_active", true);
    let result = await query as unknown as MatchResult<NonEmployeeMatch>;
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

  const employeeAccounts = (employeesResult.data ?? []).map((employee) => mapEmployeeAccountRow(employee));
  const accounts: AccountRow[] = [
    ...((profilesResult.data ?? []).map((profile) => ({
      id: profile.id,
      company_id: profile.company_id,
      full_name: profile.full_name,
      email: profile.email,
      employee_id: profile.employee_id,
      role: profile.role,
      status: "Active",
      profile_type: "user" as const
    }))),
    ...nonEmployeeResults.flatMap((result, index) => {
      const profileType = nonEmployeeTypes[index];
      return (result.data ?? []).map((profile) => mapNonEmployeeAccountRow(profile, profileType));
    }),
    ...employeeAccounts
  ].filter((account) => account.company_id);

  await enrichAccountsWithIcSelfService(
    profilesResult.data ?? [],
    accounts,
    countryCode,
    mobile,
    localMobile
  );

  const employeeReferences = new Set(accounts
    .filter((account) => account.profile_type === "employee" && account.employee_id)
    .map((account) => `${account.company_id}:${String(account.employee_id).trim().toLowerCase()}`));
  const selfServiceReferences = collectSelfServiceReferences(accounts);

  const canonicalWorkforceSources = new Set(accounts
    .filter((account) => account.profile_type === "workforce" && account.source_profile_type && account.source_profile_id)
    .map((account) => `${account.company_id}:${account.source_profile_type}:${account.source_profile_id}`));
  const contractorAccountKeys = new Set(accounts
    .filter((account) => account.profile_type === "contractor")
    .map((account) => `${account.company_id}:${account.id}`));
  const visibleAccounts = accounts.filter((account) => {
    if (account.profile_type === "user") {
      if (shouldHideIcManagerLogin(account, selfServiceReferences)) {
        return false;
      }
      const profileReference = normalizeWorkforceReference(account.employee_id).toLowerCase();
      if (
        profileReference &&
        employeeReferences.has(`${account.company_id}:${profileReference}`)
      ) {
        return false;
      }
      return true;
    }
    if (account.profile_type === "field_executive") {
      return !canonicalWorkforceSources.has(`${account.company_id}:field_executive:${account.id}`);
    }
    if (account.profile_type === "workforce") {
      return !(
        account.source_profile_type === "contractor" &&
        account.source_profile_id &&
        contractorAccountKeys.has(`${account.company_id}:${account.source_profile_id}`)
      );
    }
    return true;
  });

  let loginAccounts = visibleAccounts;
  if (
    loginAccounts.length === 1 &&
    loginAccounts[0].profile_type === "user" &&
    !isConnectManagerLogin(loginAccounts[0].role)
  ) {
    const soleUser = loginAccounts[0];
    const resolved = await resolveIcSelfServiceByReference(
      soleUser.company_id,
      normalizeWorkforceReference(soleUser.employee_id),
      countryCode,
      mobile,
      localMobile
    );
    if (resolved) loginAccounts = [resolved];
  }

  const assignmentMetadata = await loadPeopleAssignmentMetadata(loginAccounts);
  for (const account of loginAccounts) {
    const metadata = assignmentMetadata.get(peopleWorkerKey(account.profile_type, account.company_id, account.id));
    if (!metadata) continue;
    account.designation_id = metadata.designationId;
    account.role = metadata.positionTitle || account.role;
  }

  const companyIds = Array.from(new Set(loginAccounts.map((account) => account.company_id)));
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
        : [];
      pageAccessByCategory.set(`${category.company_id}:${category.code}`, pages);
    }
  }
  const designationResult = companyIds.length
    ? await supabaseAdmin
      .from("designations")
      .select("id, company_id, code, name, designation_category_id, onboarding_categories, app_page_access")
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
        .select("id, company_id, code, name, designation_category_id, onboarding_categories")
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
  const categoryIds = [...new Set(designationRows.map((designation) => designation.designation_category_id).filter(Boolean))] as string[];
  const designationCategoryResult = categoryIds.length
    ? await supabaseAdmin.from("designation_categories")
      .select("id,company_id,code,people_module")
      .in("id", categoryIds)
      .eq("is_active", true)
    : { data: [], error: null };
  if (designationCategoryResult.error && !isMissingColumnError(designationCategoryResult.error)) {
    throw new Error(designationCategoryResult.error.message);
  }
  const peopleModuleByCategoryId = new Map(
    ((designationCategoryResult.data ?? []) as DesignationCategoryRow[])
      .map((category) => [category.id, category.people_module] as const)
  );
  const peopleModuleByDesignationId = new Map<string, string | null>();
  for (const designation of designationRows) {
    const pages = designationAccessAvailable && Array.isArray((designation as { app_page_access?: unknown }).app_page_access)
      ? (designation as { app_page_access: unknown[] }).app_page_access.map(String)
      : null;
    pageAccessByDesignationId.set(String(designation.id), pages);
    designationNameById.set(String(designation.id), String(designation.name || designation.code));
    peopleModuleByDesignationId.set(
      String(designation.id),
      designation.designation_category_id
        ? peopleModuleByCategoryId.get(designation.designation_category_id) ?? null
        : null
    );
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

  return Promise.all(loginAccounts
    .filter((account) => companyNameById.has(account.company_id))
    .map(async (account): Promise<ConnectAccount> => {
      const categoryCode = categoryCodeForProfile(account.profile_type);
      const categoryPages = pageAccessByCategory.get(`${account.company_id}:${categoryCode}`) ?? [];
      const designationPages = account.designation_id
        ? pageAccessByDesignationId.get(account.designation_id)
        : account.role
          ? pageAccessByDesignationKey.get(designationLookupKey(account.company_id, categoryCode, account.role))
          : undefined;
      const workspace = connectWorkspace(
        account.profile_type,
        account.designation_id ? peopleModuleByDesignationId.get(account.designation_id) : null
      );

      return {
      id: account.id,
      companyId: account.company_id,
      profileType: account.profile_type,
      name: account.full_name,
      email: account.email ?? null,
      reference: account.employee_id || account.dropx_id || null,
      role: account.profile_type === "user"
        ? account.role ?? null
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
      workspace,
      workspaceLabel: workspace === "people" ? "People workspace" : "Workforce workspace"
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
  const canonicalProfileType = profileType === "field_executive" ? "workforce" : profileType;
  const account = accounts.find((item) => item.profileType === canonicalProfileType && item.id === accountId);
  if (!account) throw new Error("This account is not available for the current login.");
  return account;
}
