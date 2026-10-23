import { accessPages } from "@/lib/access-pages";
import { loadActiveRoles, loadCompanyAccessRow, loadPeopleDesignation, loadRolePageGrants } from "@/lib/access-cache";
import {
  hasPermission,
  type AuthorizationContext,
  type PagePermission
} from "@/lib/authorization";
import { loadEffectivePositionAccess } from "@/lib/position-access";
import { enforceAccessCutoffIfDue } from "@/lib/access-cutoff";
import { loadSessionProfile } from "@/lib/session-user";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { MCP_SCOPE } from "@/lib/mcp/constants";

const noPermission: PagePermission = { canView: false, canAdd: false, canEdit: false };

const FLEET_MCP_GATE_PAGES = [
  "fleet_action_center",
  "fleet_vehicle_view",
  "fleet_tracking",
  "fleet_reports",
  "fleet_audits",
  "fleet_maintenance",
  "fleet_date_view",
  "fleet_settings"
] as const;

function normalizeEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function grantFullAccess(permissions: Record<string, PagePermission>) {
  for (const page of accessPages) {
    permissions[page.code] = { canView: true, canAdd: true, canEdit: true };
  }
}

/**
 * Resolve Fleet-scoped authorization for an MCP bearer token subject.
 * Forces the fleet product membership path (same as fleet.dropxlogistics.com).
 */
export async function loadAuthorizationForMcpUser(userId: string): Promise<AuthorizationContext | null> {
  if (!supabaseAdmin || !userId) return null;

  const { data: profile, error: profileError } = await loadSessionProfile(userId);
  if (profileError || !profile) return null;

  const isActive = profile.is_active ? await enforceAccessCutoffIfDue(profile.id) : profile.is_active;
  if (!isActive) return null;

  const permissions: Record<string, PagePermission> = Object.fromEntries(
    accessPages.map((page) => [page.code, { ...noPermission }])
  );

  let hasAllLocationAccess = false;
  let locationScopeIds = Array.isArray(profile.location_scope_ids) ? profile.location_scope_ids : [];
  let companyId: string | null = typeof profile.company_id === "string" ? profile.company_id : null;
  let companyCode: string | null = null;
  let companyName: string | null = null;
  const effectiveEmail = normalizeEmail(profile.email);
  let isMasterCompany = effectiveEmail === "nisar@dropxlogistics.com";
  const isMasterOwner = Boolean(profile.is_master_owner) || effectiveEmail === "nisar@dropxlogistics.com";
  let roleCode: string | null = null;
  let roleName: string | null = null;
  let effectiveRoleCodes: string[] = [];
  let effectiveRoleIds: string[] = isMasterOwner && profile.role_id ? [profile.role_id] : [];
  let primaryRoleId: string | null = isMasterOwner ? profile.role_id ?? null : null;

  if (!companyId) return null;

  const company = await loadCompanyAccessRow(companyId).catch(() => null);
  if (!company?.is_active) return null;
  const resolvedCompanyId = company.id;
  companyId = resolvedCompanyId;
  companyCode = company.code;
  companyName = company.name;
  isMasterCompany = Boolean(company.is_master);

  const positionAccess = await loadEffectivePositionAccess(resolvedCompanyId, profile.id);
  if (isMasterOwner) {
    effectiveRoleIds = Array.from(new Set([...effectiveRoleIds, ...positionAccess.roleIds]));
    primaryRoleId = positionAccess.primaryRoleId ?? primaryRoleId;
  }
  locationScopeIds = Array.from(new Set([...locationScopeIds, ...positionAccess.locationScopeIds]));
  hasAllLocationAccess = positionAccess.hasAllLocationAccess;

  const membershipResult = await supabaseAdmin
    .from("company_product_memberships")
    .select("role_id,has_all_location_access,location_scope_ids")
    .eq("company_id", resolvedCompanyId)
    .eq("user_id", profile.id)
    .eq("product_code", "fleet")
    .eq("is_active", true);

  if (!membershipResult.error && !isMasterOwner) {
    const membershipRows = membershipResult.data ?? [];
    const membershipRoleIds = membershipRows
      .map((membership) => membership.role_id)
      .filter((roleId): roleId is string => Boolean(roleId));
    if (membershipRoleIds.length) {
      effectiveRoleIds = Array.from(new Set(membershipRoleIds));
      primaryRoleId = membershipRoleIds[0] ?? null;
    } else {
      effectiveRoleIds = [];
      primaryRoleId = null;
    }
    hasAllLocationAccess = membershipRows.some((membership) => membership.has_all_location_access);
    locationScopeIds = hasAllLocationAccess
      ? []
      : Array.from(new Set(membershipRows.flatMap((membership) => membership.location_scope_ids ?? [])));
  }

  if (effectiveRoleIds.length) {
    const roles = await loadActiveRoles(resolvedCompanyId, effectiveRoleIds).catch(() => null);
    if (!roles) return null;
    effectiveRoleCodes = roles.map((role) => String(role.code ?? "").trim().toUpperCase());
    const primaryRole = roles.find((role) => role.id === primaryRoleId) ?? roles[0] ?? null;
    roleName = primaryRole?.name ?? null;
    roleCode = String(primaryRole?.code ?? "").trim().toUpperCase() || null;
    if (roles.some((role) => role.location_access_mode === "all_locations")) {
      hasAllLocationAccess = true;
      locationScopeIds = [];
    }
    const hasLocationRole = roles.some((role) => String(role.code ?? "").trim().toUpperCase() === "LOCATION");
    if (hasLocationRole && effectiveEmail) {
      const { data: allEmailLocations } = await supabaseAdmin
        .from("stations")
        .select("id, station_email")
        .eq("company_id", resolvedCompanyId)
        .eq("is_active", true)
        .not("station_email", "is", null);
      const emailLocationIds = (allEmailLocations ?? [])
        .filter((location) => normalizeEmail(location.station_email) === effectiveEmail)
        .map((location) => location.id);
      locationScopeIds = Array.from(new Set([...locationScopeIds, ...emailLocationIds]));
    }

    if (roles.some((role) => String(role.code ?? "").trim().toUpperCase() === "OWNER")) {
      hasAllLocationAccess = true;
      grantFullAccess(permissions);
    } else {
      const access = await loadRolePageGrants(resolvedCompanyId, effectiveRoleIds).catch(() => null);
      if (!access) return null;
      const codeByPageId = new Map(access.pages.map((page) => [page.id, page.code]));
      access.grants.forEach((grant) => {
        const code = codeByPageId.get(grant.page_id);
        if (!code) return;
        const current = permissions[code] ?? noPermission;
        permissions[code] = {
          canView: current.canView || grant.can_view || grant.can_edit,
          canAdd: current.canAdd || grant.can_add,
          canEdit: current.canEdit || grant.can_edit
        };
      });
    }
  }

  if (isMasterOwner) {
    hasAllLocationAccess = true;
    grantFullAccess(permissions);
    permissions.company_master = { canView: true, canAdd: true, canEdit: true };
  } else if (!isMasterCompany) {
    permissions.company_master = { ...noPermission };
  }

  const designation = await loadPeopleDesignation(resolvedCompanyId, profile.id);

  return {
    designationName: designation?.name ?? null,
    canPreviewUsers: false,
    isPreview: false,
    readOnly: true,
    viewerUserId: profile.id,
    companyCode,
    companyId,
    companyName,
    email: profile.email ?? null,
    effectiveRoleIds,
    effectiveRoleCodes,
    fullName: profile.full_name,
    hasAllLocationAccess,
    isMasterCompany,
    isMasterOwner,
    locationScopeIds,
    permissions,
    roleCode,
    roleId: primaryRoleId,
    roleName,
    userId: profile.id
  };
}

export function mcpUserHasFleetAccess(authorization: AuthorizationContext) {
  return FLEET_MCP_GATE_PAGES.some((code) => hasPermission(authorization, code, "access"));
}

export function assertMcpScope(scope: string | null | undefined) {
  const parts = String(scope ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.includes(MCP_SCOPE) || parts.includes("fleet") || parts.length === 0;
}
