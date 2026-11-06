import "server-only";
import type { AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";

type FinanceAccess = { roleIds: string[]; allLocations: boolean; stationIds: string[] };
const none = (): FinanceAccess => ({ roleIds: [], allLocations: false, stationIds: [] });

// Dashboard keeps its own page permissions. Only final dispute review may reuse
// an existing Operations Finance membership; never grant a new membership.
export async function loadDisputeFinanceAccess(auth: AuthorizationContext): Promise<FinanceAccess> {
  if (!supabaseAdmin || !auth.companyId || auth.readOnly) return none();
  const memberships = await supabaseAdmin.from("company_product_memberships")
    .select("role_id,has_all_location_access,location_scope_ids")
    .eq("company_id", auth.companyId).eq("user_id", auth.userId)
    .eq("product_code", "operations").eq("is_active", true);
  if (memberships.error || !memberships.data?.length) return none();
  const roles = await supabaseAdmin.from("user_roles")
    .select("id,code,location_access_mode").eq("company_id", auth.companyId)
    .eq("is_active", true).in("id", memberships.data.map((row) => row.role_id));
  if (roles.error) return none();
  const active = roles.data ?? [];
  const finance = active.filter((role) => role.code === "OPERATIONS_FINMGR");
  const permitted: string[] = [];
  for (const role of finance) {
    const grant = await supabaseAdmin.rpc("workforce_payout_dispute_role_can_edit", {
      p_company: auth.companyId, p_role: role.id, p_page_code: "ops_workforce_payout_disputes"
    });
    if (!grant.error && grant.data === true) permitted.push(role.id);
  }
  const validMemberships = memberships.data.filter((row) => active.some((role) => role.id === row.role_id));
  return {
    roleIds: permitted,
    allLocations: validMemberships.some((row) => row.has_all_location_access
      || active.find((role) => role.id === row.role_id)?.location_access_mode === "all_locations"),
    stationIds: [...new Set(validMemberships.flatMap((row) => row.location_scope_ids ?? []))]
  };
}

export function disputeFinalRoleIds(nativeRoleIds: string[], access: FinanceAccess, stationId: string) {
  return [...new Set([...nativeRoleIds,
    ...(stationId && (access.allLocations || access.stationIds.includes(stationId)) ? access.roleIds : [])
  ])];
}
