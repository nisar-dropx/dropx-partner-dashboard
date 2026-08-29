import "server-only";
import { normalizeMobile } from "@/lib/connect-otp";
import type { AuthorizedMobileLoginProfile } from "@/lib/mobile-login-otp";
import { supabaseAdmin } from "@/lib/supabase-admin";

type ProfileRow = {
  id: string;
  company_id: string | null;
  email: string | null;
  full_name: string | null;
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

export async function findAuthorizedPeopleProfileByMobile(rawMobile: unknown, countryCode = "91") {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const mobile = normalizeMobile(rawMobile, countryCode);
  if (!mobile || mobile.length < 11) return null;

  const profilesWithCountryResult = await supabaseAdmin
    .from("profiles")
    .select("id, company_id, email, full_name, mobile, mobile_country_code")
    .eq("is_active", true)
    .not("mobile", "is", null);

  let profilesData: ProfileRow[] = [];
  let profilesError = profilesWithCountryResult.error;
  if (profilesWithCountryResult.error && isMissingColumnError(profilesWithCountryResult.error)) {
    const legacyProfilesResult = await supabaseAdmin
      .from("profiles")
      .select("id, company_id, email, full_name, mobile")
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

  return {
    id: profile.id,
    companyId: profile.company_id,
    email,
    fullName: profile.full_name,
    mobile
  } satisfies AuthorizedMobileLoginProfile;
}

export function safePeopleNextPath(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("/") || text.startsWith("//") || text.startsWith("/login")) return "/";
  try {
    const parsed = new URL(text, "https://people.dropxlogistics.com");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}
