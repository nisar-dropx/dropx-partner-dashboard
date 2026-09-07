import { loadEffectivePositionAccess } from "@/lib/position-access";
import { parseReviewClusterFilterKey } from "@/lib/ops-pulse/review-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";

function normalizePersonName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Ops location scope for a Cluster / AOM filter person — same stations they see
 * when logged into Ops (profile + position + operations membership).
 */
export async function loadReviewClusterPersonLocationScope(companyId: string, selectedCluster: string) {
  const parsed = parseReviewClusterFilterKey(selectedCluster);
  if (!parsed || !supabaseAdmin) return null;

  const profilesResult = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, location_scope_ids")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .ilike("full_name", parsed.name);
  if (profilesResult.error) return null;

  const target = normalizePersonName(parsed.name);
  const matches = (profilesResult.data ?? []).filter((profile) => normalizePersonName(String(profile.full_name ?? "")) === target);
  if (!matches.length) return null;

  let hasAllLocationAccess = false;
  const locationIds = new Set<string>();

  for (const profile of matches) {
    const positionAccess = await loadEffectivePositionAccess(companyId, profile.id);
    let scopeIds = Array.from(new Set([
      ...(Array.isArray(profile.location_scope_ids) ? profile.location_scope_ids : []),
      ...positionAccess.locationScopeIds
    ]));
    let allLocations = positionAccess.hasAllLocationAccess;

    const membershipResult = await supabaseAdmin
      .from("company_product_memberships")
      .select("role_id,has_all_location_access,location_scope_ids")
      .eq("company_id", companyId)
      .eq("user_id", profile.id)
      .eq("product_code", "operations")
      .eq("is_active", true);

    if (!membershipResult.error && (membershipResult.data ?? []).length) {
      const membershipRows = membershipResult.data ?? [];
      allLocations = membershipRows.some((row) => row.has_all_location_access);
      scopeIds = allLocations
        ? []
        : Array.from(new Set(membershipRows.flatMap((row) => row.location_scope_ids ?? [])));

      const roleIds = membershipRows.map((row) => row.role_id).filter((id): id is string => Boolean(id));
      if (roleIds.length) {
        const rolesResult = await supabaseAdmin
          .from("user_roles")
          .select("id, location_access_mode")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .in("id", roleIds);
        if (!rolesResult.error && (rolesResult.data ?? []).some((role) => role.location_access_mode === "all_locations")) {
          allLocations = true;
          scopeIds = [];
        }
      }
    }

    if (allLocations) {
      hasAllLocationAccess = true;
      continue;
    }
    scopeIds.forEach((id) => locationIds.add(id));
  }

  return { hasAllLocationAccess, locationIds };
}
