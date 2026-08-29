import "server-only";
import { normalizeMobile } from "@/lib/connect-otp";
import type { AuthorizedMobileLoginProfile } from "@/lib/mobile-login-otp";
import { isPeoplePortalPageCode } from "@/lib/people/navigation";
import { safePeopleNextPath } from "@/lib/people/surface";
import { loadEffectivePositionAccess } from "@/lib/position-access";
import { supabaseAdmin } from "@/lib/supabase-admin";

type ProfileRow = {
  id: string;
  company_id: string | null;
  email: string | null;
  full_name: string | null;
  is_master_owner?: boolean | null;
  mobile: string | null;
  mobile_country_code?: string | null;
  role_id: string | null;
};

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

function normalizedEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

async function hasAuthorizedPeopleRole(profile: ProfileRow) {
  if (!supabaseAdmin || !profile.company_id) return false;
  if (profile.is_master_owner) return true;

  const positionAccess = await loadEffectivePositionAccess(profile.company_id, profile.id);
  const roleIds = Array.from(new Set([
    ...(profile.role_id ? [profile.role_id] : []),
    ...positionAccess.roleIds
  ]));
  if (!roleIds.length) return false;

  const rolesResult = await supabaseAdmin
    .from("user_roles")
    .select("id, code, is_active")
    .eq("company_id", profile.company_id)
    .eq("is_active", true)
    .in("id", roleIds);
  if (rolesResult.error) throw new Error(rolesResult.error.message);
  const activeRoleIds = (rolesResult.data ?? []).map((role) => role.id);
  if ((rolesResult.data ?? []).some((role) => String(role.code ?? "").trim().toUpperCase() === "OWNER")) return true;
  if (!activeRoleIds.length) return false;

  const pagesResult = await supabaseAdmin
    .from("app_pages")
    .select("id, code")
    .eq("company_id", profile.company_id)
    .eq("is_active", true);
  if (pagesResult.error) throw new Error(pagesResult.error.message);
  const peoplePageIds = (pagesResult.data ?? [])
    .filter((page) => isPeoplePortalPageCode(String(page.code ?? "")))
    .map((page) => page.id);
  if (!peoplePageIds.length) return false;

  const grantsResult = await supabaseAdmin
    .from("role_page_permissions")
    .select("page_id, can_view, can_add, can_edit")
    .eq("company_id", profile.company_id)
    .in("role_id", activeRoleIds)
    .in("page_id", peoplePageIds);
  if (grantsResult.error) throw new Error(grantsResult.error.message);
  return (grantsResult.data ?? []).some((grant) => grant.can_view || grant.can_add || grant.can_edit);
}

export async function findAuthorizedPeopleProfileByMobile(rawMobile: unknown, countryCode = "91") {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const mobile = normalizeMobile(rawMobile, countryCode);
  if (!mobile || mobile.length < 11) return null;

  const profilesWithCountryResult = await supabaseAdmin
    .from("profiles")
    .select("id, company_id, email, full_name, role_id, is_master_owner, mobile, mobile_country_code")
    .eq("is_active", true)
    .not("mobile", "is", null);

  let profilesData: ProfileRow[] = [];
  let profilesError = profilesWithCountryResult.error;
  if (profilesWithCountryResult.error && isMissingColumnError(profilesWithCountryResult.error)) {
    const legacyProfilesResult = await supabaseAdmin
      .from("profiles")
      .select("id, company_id, email, full_name, role_id, mobile")
      .eq("is_active", true)
      .not("mobile", "is", null);
    profilesError = legacyProfilesResult.error;
    profilesData = (legacyProfilesResult.data ?? []) as ProfileRow[];
  } else {
    profilesData = (profilesWithCountryResult.data ?? []) as ProfileRow[];
  }
  if (profilesError) throw new Error(profilesError.message);

  const matches = profilesData.filter((profile) => {
    const profileCountry = String(profile.mobile_country_code ?? countryCode).replace(/\D/g, "") || countryCode;
    return normalizeMobile(profile.mobile, profileCountry) === mobile;
  });
  // Never guess when one number belongs to more than one active user.
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
  if (!await hasAuthorizedPeopleRole(profile)) return null;

  return {
    id: profile.id,
    companyId: profile.company_id,
    email,
    fullName: profile.full_name,
    mobile
  } satisfies AuthorizedMobileLoginProfile;
}

export { safePeopleNextPath };
