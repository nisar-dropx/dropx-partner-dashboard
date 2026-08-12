import { normalizeMobile } from "@/lib/connect-otp";
import { opsAccessPageCodes } from "@/lib/access-surface";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type OpsLoginProfile = {
  id: string;
  companyId: string;
  email: string;
  fullName: string | null;
  mobile: string;
};

type ProfileRow = {
  id: string;
  company_id: string | null;
  email: string | null;
  full_name: string | null;
  role_id: string | null;
  is_master_owner?: boolean | null;
  mobile: string | null;
  mobile_country_code?: string | null;
};

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

function normalizedEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export async function findAuthorizedOpsProfileByMobile(rawMobile: unknown, countryCode = "91") {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const mobile = normalizeMobile(rawMobile, countryCode);
  if (!mobile || mobile.length < 11) return null;

  const profilesWithOwnerResult = await supabaseAdmin
    .from("profiles")
    .select("id, company_id, email, full_name, role_id, is_master_owner, mobile, mobile_country_code")
    .eq("is_active", true)
    .not("mobile", "is", null);

  let profilesData: ProfileRow[] | null = null;
  let profilesError = profilesWithOwnerResult.error;
  if (profilesWithOwnerResult.error && isMissingColumnError(profilesWithOwnerResult.error)) {
    const legacyProfilesResult = await supabaseAdmin
      .from("profiles")
      .select("id, company_id, email, full_name, role_id, mobile")
      .eq("is_active", true)
      .not("mobile", "is", null);
    profilesError = legacyProfilesResult.error;
    profilesData = (legacyProfilesResult.data ?? []) as ProfileRow[];
  } else {
    profilesData = (profilesWithOwnerResult.data ?? []) as ProfileRow[];
  }
  if (profilesError) throw new Error(profilesError.message);

  const matches = (profilesData ?? []).filter((profile) => {
    const profileCountry = String(profile.mobile_country_code ?? countryCode).replace(/\D/g, "") || countryCode;
    return normalizeMobile(profile.mobile, profileCountry) === mobile;
  });
  if (matches.length !== 1) return null;

  const profile = matches[0];
  const email = normalizedEmail(profile.email);
  if (!profile.company_id || !email) return null;

  const companyResult = await supabaseAdmin
    .from("companies")
    .select("id, is_active")
    .eq("id", profile.company_id)
    .maybeSingle();
  if (companyResult.error || !companyResult.data?.is_active) return null;

  if (profile.is_master_owner) {
    return {
      id: profile.id,
      companyId: profile.company_id,
      email,
      fullName: profile.full_name,
      mobile
    } satisfies OpsLoginProfile;
  }
  if (!profile.role_id) return null;

  const roleResult = await supabaseAdmin
    .from("user_roles")
    .select("id, code, is_active")
    .eq("id", profile.role_id)
    .maybeSingle();
  if (roleResult.error || !roleResult.data?.is_active) return null;
  if (String(roleResult.data.code ?? "").trim().toUpperCase() === "OWNER") {
    return {
      id: profile.id,
      companyId: profile.company_id,
      email,
      fullName: profile.full_name,
      mobile
    } satisfies OpsLoginProfile;
  }

  let pagesResult = await supabaseAdmin
    .from("app_pages")
    .select("id, code")
    .eq("company_id", profile.company_id)
    .eq("is_active", true)
    .in("code", [...opsAccessPageCodes]);
  if (pagesResult.error && isMissingColumnError(pagesResult.error)) {
    pagesResult = await supabaseAdmin
      .from("app_pages")
      .select("id, code")
      .eq("is_active", true)
      .in("code", [...opsAccessPageCodes]);
  }
  if (pagesResult.error) throw new Error(pagesResult.error.message);
  const pageIds = (pagesResult.data ?? []).map((page) => page.id);
  if (!pageIds.length) return null;

  let grantsResult = await supabaseAdmin
    .from("role_page_permissions")
    .select("page_id, can_view, can_add, can_edit")
    .eq("company_id", profile.company_id)
    .eq("role_id", profile.role_id)
    .in("page_id", pageIds);
  if (grantsResult.error && isMissingColumnError(grantsResult.error)) {
    grantsResult = await supabaseAdmin
      .from("role_page_permissions")
      .select("page_id, can_view, can_add, can_edit")
      .eq("role_id", profile.role_id)
      .in("page_id", pageIds);
  }
  if (grantsResult.error) throw new Error(grantsResult.error.message);
  const hasOpsAccess = (grantsResult.data ?? []).some((grant) => grant.can_view || grant.can_add || grant.can_edit);
  if (!hasOpsAccess) return null;

  return {
    id: profile.id,
    companyId: profile.company_id,
    email,
    fullName: profile.full_name,
    mobile
  } satisfies OpsLoginProfile;
}

export function safeOpsNextPath(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("/") || text.startsWith("//") || text.startsWith("/login")) return "/";
  try {
    const parsed = new URL(text, "https://ops.dropxlogistics.com");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}
