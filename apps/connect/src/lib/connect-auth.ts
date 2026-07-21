import { createHash, randomUUID } from "crypto";
import { cookies } from "next/headers";
import { normalizeMobile } from "@/lib/connect-otp";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type ConnectAccount = {
  id: string;
  companyId: string;
  profileType: "user" | "field_executive" | "employee";
  name: string | null;
  email: string | null;
  reference: string | null;
  role: string | null;
  status: string | null;
  biometricId: string | null;
  profilePhotoUrl: string | null;
  companyName: string;
  label: string;
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
  status?: string | null;
  profile_type: "user" | "field_executive" | "employee";
};

type EmployeeAccountRow = {
  id: string;
  company_id: string;
  full_name: string | null;
  email?: string | null;
  employee_code?: string | null;
  biometric_id?: string | null;
  profile_photo_path?: string | null;
  profile_completion_status?: string | null;
  is_active?: boolean | null;
};

type MatchResult<T> = {
  data: T[] | null;
  error: { message?: string } | null;
};

export const connectSessionCookieName = "dropx_connect_session";

export function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;
}

export function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
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

export async function findConnectAccounts(countryCode: string, mobile: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const localMobile = mobile.startsWith(countryCode) ? mobile.slice(countryCode.length) : mobile;
  let [profilesResult, executivesResult, employeesResult]: [
    MatchResult<{ id: string; company_id: string; full_name: string | null; email?: string | null; employee_id?: string | null; role?: string | null }>,
    MatchResult<{ id: string; company_id: string; full_name: string | null; email?: string | null; dropx_id?: string | null; biometric_id?: string | null; designation?: string | null; onboarding_status?: string | null; profile_photo_path?: string | null }>,
    MatchResult<EmployeeAccountRow>
  ] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id, company_id, full_name, email, employee_id, role, is_active, mobile_country_code")
      .eq("is_active", true)
      .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
      .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`),
    supabaseAdmin
      .from("field_executives")
      .select("id, company_id, full_name, email, dropx_id, biometric_id, designation, onboarding_status, profile_photo_path, is_active, mobile_country_code")
      .eq("is_active", true)
      .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
      .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`),
    supabaseAdmin
      .from("employees")
      .select("id, company_id, full_name, email, employee_code, biometric_id, profile_completion_status, profile_photo_path, is_active, mobile_country_code")
      .eq("is_active", true)
      .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
      .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`)
  ]);
  if (isMissingColumnError(profilesResult.error) || isMissingColumnError(executivesResult.error) || isMissingColumnError(employeesResult.error)) {
    [profilesResult, executivesResult, employeesResult] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, company_id, full_name, email, employee_id, role, is_active")
        .eq("is_active", true)
        .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`),
      supabaseAdmin
        .from("field_executives")
        .select("id, company_id, full_name, email, dropx_id, biometric_id, designation, onboarding_status, is_active")
        .eq("is_active", true)
        .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`),
      supabaseAdmin
        .from("employees")
        .select("id, company_id, full_name, email, employee_code, biometric_id, is_active")
        .eq("is_active", true)
        .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`)
    ]);
  }
  if (profilesResult.error) throw new Error(profilesResult.error.message);
  if (executivesResult.error) throw new Error(executivesResult.error.message);
  if (employeesResult.error && !isMissingColumnError(employeesResult.error)) throw new Error(employeesResult.error.message);

  const employeeAccounts = (employeesResult.data ?? []).map((employee) => ({
    id: employee.id,
    company_id: employee.company_id,
    full_name: employee.full_name,
    email: employee.email,
    employee_id: employee.employee_code,
    biometric_id: employee.biometric_id ?? null,
    role: "Employee",
    status: employee.profile_completion_status === "active" ? "Active" : employee.profile_completion_status === "submitted" ? "Submitted" : "Pending",
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
      profile_type: "user" as const
    }))),
    ...((executivesResult.data ?? []).map((executive) => ({
      id: executive.id,
      company_id: executive.company_id,
      full_name: executive.full_name,
      email: executive.email,
      dropx_id: executive.dropx_id,
      biometric_id: executive.biometric_id,
      role: executive.designation,
      status: executive.onboarding_status === "active" ? "Active" : "Pending",
      profile_photo_path: executive.profile_photo_path ?? null,
      profile_type: "field_executive" as const
    }))),
    ...employeeAccounts
  ].filter((account) => account.company_id);

  const companyIds = Array.from(new Set(accounts.map((account) => account.company_id)));
  const companiesResult = companyIds.length
    ? await supabaseAdmin.from("companies").select("id, name, code").in("id", companyIds).eq("is_active", true)
    : { data: [], error: null };
  if (companiesResult.error) throw new Error(companiesResult.error.message);
  const companyNameById = new Map((companiesResult.data ?? []).map((company) => [company.id, company.name || company.code || "Company"]));

  return Promise.all(accounts
    .filter((account) => companyNameById.has(account.company_id))
    .map(async (account): Promise<ConnectAccount> => ({
      id: account.id,
      companyId: account.company_id,
      profileType: account.profile_type,
      name: account.full_name,
      email: account.email ?? null,
      reference: account.employee_id || account.dropx_id || null,
      role: account.role ?? null,
      status: account.status ?? null,
      biometricId: account.biometric_id ?? null,
      profilePhotoUrl: await signedProfilePhotoUrl(account.profile_photo_path),
      companyName: companyNameById.get(account.company_id) ?? "Company",
      label: accountLabel(account, companyNameById)
    })));
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
