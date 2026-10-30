import "server-only";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const workforceConnectStatuses = ["submitted", "acknowledged", "in_review", "action_required", "resolved", "closed", "dismissed"];
export const workforceConnectOpenStatuses = workforceConnectStatuses.slice(0, 4);

// The database view enforces the profile boundary BEFORE filtering/pagination.
// Protected cases have no location/identity and are only visible to company-wide
// reviewers. An empty location scope must never mean unrestricted access.
export function scopedWorkforceCases(auth: AuthorizationContext, head = false) {
  if (!supabaseAdmin || !hasPermission(auth, "workforce_connect", "view")) throw new Error("Workforce Connect access required.");
  const query = supabaseAdmin.from("workforce_connect_cases").select("*", { count: "exact", head }).eq("company_id", requireCompanyId(auth));
  return auth.isMasterOwner || auth.hasAllLocationAccess ? query
    : query.in("location_id", auth.locationScopeIds.length ? auth.locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
}

export async function countWorkforceConnectAttention(auth: AuthorizationContext) {
  if (!hasPermission(auth, "workforce_connect", "view")) return 0;
  const result = await scopedWorkforceCases(auth, true).in("status", workforceConnectOpenStatuses);
  if (result.error) throw result.error;
  return result.count ?? 0;
}
