import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { AuthorizationContext } from "@/lib/authorization";

export type AuditAssignee = {
  id: string;
  name: string;
  email: string | null;
  role: string;
  roleCodes: string[];
  stationIds: string[];
  allLocations: boolean;
};
export function canDeleteStationAudit(auth: AuthorizationContext) {
  return (
    !auth.readOnly &&
    (auth.isMasterOwner ||
      (auth.effectiveRoleCodes || [auth.roleCode || ""]).some((code) =>
        [
          "OPERATIONS_BH",
          "OPERATIONS_HLM",
          "OPERATIONS_SLPM",
          "OPERATIONS_NH",
          "OPERATIONS_NATIONAL_HEAD",
          "NATIONAL_HEAD",
        ].includes(code),
      ))
  );
}
/** Resolve from the same Operations memberships and role scope used at login. */
export async function loadAuditAssignees(
  companyId: string,
  schedulerRoleIds: string[],
  visibleStationIds: string[],
) {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  const [profiles, memberships, roles, pages, grants] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id,full_name,email,is_master_owner")
      .eq("company_id", companyId)
      .eq("is_active", true),
    supabaseAdmin
      .from("company_product_memberships")
      .select("user_id,role_id,location_scope_ids,has_all_location_access")
      .eq("company_id", companyId)
      .eq("product_code", "operations")
      .eq("is_active", true),
    supabaseAdmin
      .from("user_roles")
      .select("id,code,name,location_access_mode")
      .eq("company_id", companyId)
      .eq("is_active", true),
    supabaseAdmin
      .from("app_pages")
      .select("id")
      .eq("company_id", companyId)
      .eq("code", "station_audits")
      .eq("is_active", true),
    supabaseAdmin
      .from("role_page_permissions")
      .select("role_id,page_id,can_edit")
      .eq("company_id", companyId)
      .eq("can_edit", true),
  ]);
  for (const result of [profiles, memberships, roles, pages, grants])
    if (result.error) throw new Error(result.error.message);
  const pageIds = new Set((pages.data || []).map((p) => p.id));
  const editorRoles = new Set(
    (grants.data || [])
      .filter((g) => pageIds.has(g.page_id))
      .map((g) => g.role_id),
  );
  return (profiles.data || [])
    .flatMap((profile) => {
      const member = (memberships.data || []).filter(
        (m) => m.user_id === profile.id,
      );
      const effectiveRoles = (roles.data || []).filter((r) =>
        member.some((m) => m.role_id === r.id),
      );
      if (
        !profile.is_master_owner &&
        !effectiveRoles.some(
          (r) => schedulerRoleIds.includes(r.id) && editorRoles.has(r.id),
        )
      )
        return [];
      const all =
        profile.is_master_owner ||
        member.some((m) => m.has_all_location_access) ||
        effectiveRoles.some((r) => r.location_access_mode === "all_locations");
      const ids = all
        ? visibleStationIds
        : visibleStationIds.filter((id) =>
            member.some((m) => (m.location_scope_ids || []).includes(id)),
          );
      if (!ids.length) return [];
      return [
        {
          id: profile.id,
          name: profile.full_name || profile.email || "Auditor",
          email: profile.email,
          role: effectiveRoles.map((r) => r.name).join(" / ") || "Owner",
          roleCodes: effectiveRoles.map((r) => r.code),
          stationIds: ids,
          allLocations: Boolean(all),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name)) as AuditAssignee[];
}
