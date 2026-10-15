import {
  normalizeVehicleRegistration,
  trustedVehicleFuelFromAudits,
  trustedVehicleFuelFromStoredVerification,
  type VehicleVerificationAudit
} from "@/lib/vehicle-fuel";
import { supabaseAdmin } from "./supabase-admin";
import type { WorkforceProfileType } from "./workforce-profiles";

function profileTypeAliases(profileType: WorkforceProfileType) {
  return profileType === "workforce" || profileType === "field_executive"
    ? ["workforce", "field_executive"]
    : [profileType];
}

export async function loadTrustedVehicleFuel({
  accountId,
  companyId,
  profileType,
  registrationNumber
}: {
  accountId: string;
  companyId: string;
  profileType: WorkforceProfileType;
  registrationNumber: string;
}) {
  if (!supabaseAdmin) return "";
  const normalizedRegistration = normalizeVehicleRegistration(registrationNumber);
  if (!normalizedRegistration) return "";

  const result = await supabaseAdmin
    .from("verification_api_audit_logs")
    .select("is_success, request_data, request_status, response_data, created_at")
    .eq("company_id", companyId)
    .eq("account_id", accountId)
    .in("profile_type", profileTypeAliases(profileType))
    .eq("provider_code", "idspay")
    .eq("verification_kind", "vehicle")
    .eq("endpoint", "/srv2/validation/rc")
    .eq("request_data->>reg_no", normalizedRegistration)
    .order("created_at", { ascending: false })
    .limit(2);

  if (result.error) {
    console.error("Unable to read the trusted vehicle verification audit:", result.error.message);
    return "";
  }

  const audits = (result.data ?? []) as VehicleVerificationAudit[];
  if (audits.length > 0) {
    return trustedVehicleFuelFromAudits(audits, normalizedRegistration);
  }

  // Provider audit payloads are retained for a limited period. Once the exact
  // matching audit has been deleted, use only the canonical successful result
  // saved for this same account, profile, verification kind, and registration.
  const stored = await supabaseAdmin
    .from("connect_profile_verifications")
    .select("verified, input_key, details")
    .eq("company_id", companyId)
    .eq("account_id", accountId)
    .eq("profile_type", profileType)
    .eq("kind", "vehicle")
    .eq("input_key", normalizedRegistration)
    .maybeSingle();

  if (stored.error) {
    console.error("Unable to read the retained vehicle verification:", stored.error.message);
    return "";
  }

  // An exact profile-type row is authoritative, including a failed row. Only
  // fall back to a legacy/canonical alias when no exact row exists at all.
  if (stored.data) {
    return trustedVehicleFuelFromStoredVerification(stored.data, normalizedRegistration);
  }

  const aliases = profileTypeAliases(profileType).filter((alias) => alias !== profileType);
  if (!aliases.length) return "";
  const aliased = await supabaseAdmin
    .from("connect_profile_verifications")
    .select("verified, input_key, details, updated_at")
    .eq("company_id", companyId)
    .eq("account_id", accountId)
    .in("profile_type", aliases)
    .eq("kind", "vehicle")
    .eq("input_key", normalizedRegistration)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (aliased.error) {
    console.error("Unable to read the retained vehicle verification alias:", aliased.error.message);
    return "";
  }

  return trustedVehicleFuelFromStoredVerification(aliased.data, normalizedRegistration);
}
