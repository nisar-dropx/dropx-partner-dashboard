import { createHash, randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { eligibleConnectWorkforceAccount } from "@/lib/connect-account-freshness";

export {
  normalizeConnectMobile,
  normalizeStoredConnectMobile
} from "@/lib/country-codes";
export {
  activateConnectSession,
  authenticateConnectPin,
  ConnectCredentialError,
  revokeIssuedConnectSession,
  setConnectPinWithOtp,
  type IssuedConnectSession
} from "@/lib/connect-session-issuance";
export {
  sameConnectAccountIdentitySet,
  type ConnectAccountIdentity
} from "@/lib/connect-account-freshness";

export type ConnectAccount = {
  id: string;
  companyId: string;
  profileType: "user" | "field_executive";
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
  profile_type: "user" | "field_executive";
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

export async function findConnectAccounts(
  countryCode: string,
  mobile: string,
  _options: { fresh?: boolean } = {}
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const localMobile = mobile.startsWith(countryCode) ? mobile.slice(countryCode.length) : mobile;
  let [profilesResult, executivesResult]: [
    MatchResult<{ id: string; company_id: string; full_name: string | null; email?: string | null; employee_id?: string | null; role?: string | null }>,
    MatchResult<{ id: string; company_id: string; full_name: string | null; email?: string | null; dropx_id?: string | null; biometric_id?: string | null; designation?: string | null; onboarding_status?: string | null; lifecycle_status?: string | null; profile_photo_path?: string | null; is_active?: boolean | null; deleted_at?: string | null; deactivated_at?: string | null }>
  ] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id, company_id, full_name, email, employee_id, role, is_active, mobile_country_code")
      .eq("is_active", true)
      .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
      .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`),
    supabaseAdmin
      .from("workforce")
      .select("id, company_id, full_name, email, dropx_id, biometric_id, designation, onboarding_status, lifecycle_status, profile_photo_path, is_active, deleted_at, deactivated_at, mobile_country_code")
      .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
      .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`)
  ]);
  if (isMissingColumnError(profilesResult.error)) {
    profilesResult = await supabaseAdmin
        .from("profiles")
        .select("id, company_id, full_name, email, employee_id, role, is_active")
        .eq("is_active", true)
        .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`);
  }
  if (isMissingColumnError(executivesResult.error)) {
    executivesResult = await supabaseAdmin
        .from("workforce")
        .select("id, company_id, full_name, email, dropx_id, biometric_id, designation, onboarding_status, lifecycle_status, profile_photo_path, is_active, deleted_at, deactivated_at")
        .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`);
  }
  if (profilesResult.error) throw new Error(profilesResult.error.message);
  if (executivesResult.error) throw new Error(executivesResult.error.message);
  executivesResult = {
    ...executivesResult,
    data: (executivesResult.data ?? []).filter(eligibleConnectWorkforceAccount)
  };

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
    })))
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
