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
  if (!designationPages) return categoryPages;
  const allowedByDesignation = new Set(designationPages.map((page) => page.trim().toLowerCase()));
  return categoryPages.filter((page) => allowedByDesignation.has(page.trim().toLowerCase()));
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

  const employeeAccounts = (employeesResult.data ?? []).map((employee) => ({
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
    profile_type: "employee" as const,
    profile_photo_path: employee.profile_photo_path ?? null,
  }));
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
      return (result.data ?? []).map((profile) => ({
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
        profile_type: profileType
      }));
    }),
    ...employeeAccounts
  ].filter((account) => account.company_id);

  // A People login and its employee record represent the same employee workspace.
  // Keep the richer employee account in that case, while retaining a manager login
  // beside contractor/workforce identities so genuine dual-role users can switch.
  const employeeReferences = new Set(employeeAccounts
    .filter((account) => account.employee_id)
    .map((account) => `${account.company_id}:${String(account.employee_id).trim().toLowerCase()}`));
  const canonicalWorkforceSources = new Set(accounts
    .filter((account) => account.profile_type === "workforce" && account.source_profile_type && account.source_profile_id)
    .map((account) => `${account.company_id}:${account.source_profile_type}:${account.source_profile_id}`));
  const visibleAccounts = accounts.filter((account) => {
    if (account.profile_type === "user") {
      return !account.employee_id ||
        !employeeReferences.has(`${account.company_id}:${String(account.employee_id).trim().toLowerCase()}`);
    }
    if (["field_executive", "contractor", "vendor", "worker"].includes(account.profile_type)) {
      return !canonicalWorkforceSources.has(`${account.company_id}:${account.profile_type}:${account.id}`);
    }
    return true;
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
      role: account.designation_id
        ? designationNameById.get(String(account.designation_id)) ?? null
        : account.role === "Employee"
          ? null
          : account.role ?? null,
      status: account.status ?? null,
      biometricId: account.biometric_id ?? null,
      profilePhotoUrl: await signedProfilePhotoUrl(account.profile_photo_path),
      pageAccess: account.profile_type === "user"
        ? managerPageAccess
        : intersectPageAccess(categoryPages, designationPages),
      isDefault: defaultPreference?.default_company_id === account.company_id &&
        defaultPreference?.default_profile_type === account.profile_type &&
        defaultPreference?.default_account_id === account.id,
      companyName: companyNameById.get(account.company_id) ?? "Company",
      label: accountLabel(account, companyNameById),
      workspace: connectWorkspace(account.profile_type),
      workspaceLabel: connectWorkspace(account.profile_type) === "people" ? "People workspace" : "Workforce workspace"
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
