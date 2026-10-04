import "server-only";
import { normalizeMobile } from "@/lib/connect-otp";
import type { AuthorizedMobileLoginProfile } from "@/lib/mobile-login-otp";
import { supabaseAdmin } from "@/lib/supabase-admin";

function isMissingColumn(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

export async function findFleetMobileProfile(mobileValue: unknown, countryCode: string): Promise<AuthorizedMobileLoginProfile | null> {
  if (!supabaseAdmin) return null;
  const mobile = normalizeMobile(mobileValue, countryCode);
  if (!mobile) return null;
  const localMobile = mobile.startsWith(countryCode) ? mobile.slice(countryCode.length) : mobile;
  let result = await supabaseAdmin
    .from("profiles")
    .select("id,company_id,email,full_name,mobile,is_active,mobile_country_code")
    .eq("is_active", true)
    .not("email", "is", null)
    .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`);
  if (result.error && isMissingColumn(result.error)) {
    result = await supabaseAdmin
      .from("profiles")
      .select("id,company_id,email,full_name,mobile,is_active")
      .eq("is_active", true)
      .not("email", "is", null)
      .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`) as typeof result;
  }
  if (result.error) throw new Error(result.error.message);
  const candidates = (result.data ?? []).filter((profile) => profile.company_id && profile.email);
  if (candidates.length !== 1) return null;
  const profile = candidates[0];
  return {
    id: profile.id,
    companyId: profile.company_id,
    email: String(profile.email).trim().toLowerCase(),
    fullName: profile.full_name,
    mobile
  };
}

export function safeFleetNextPath(value: unknown) {
  const candidate = String(value ?? "").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "/fleet-control";
  return candidate.startsWith("/fleet-control") ? candidate : "/fleet-control";
}
