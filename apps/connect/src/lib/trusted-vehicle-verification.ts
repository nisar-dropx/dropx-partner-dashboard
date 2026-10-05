import {
  normalizeVehicleRegistration,
  trustedVehicleFuelFromAudits,
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

  return trustedVehicleFuelFromAudits(
    (result.data ?? []) as VehicleVerificationAudit[],
    normalizedRegistration
  );
}
