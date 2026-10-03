import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforceRegisterLocations, type WorkforceStation } from "@/lib/workforce-register-policy";
export async function loadOpsWorkforceLocations(companyId: string, authorization: { hasAllLocationAccess: boolean; locationScopeIds: string[] }) {
  if (!supabaseAdmin) throw new Error("Workforce storage is not configured.");
  const result = await supabaseAdmin.from("stations")
    .select("id,station_code,station_name,is_active,hide_from_location_list,parent_station_id,location_model_id,providers(name),location_models(code,name)")
    .eq("company_id", companyId).order("station_code");
  if (result.error) throw new Error(result.error.message);
  return workforceRegisterLocations(result.data as unknown as WorkforceStation[], authorization);
}
