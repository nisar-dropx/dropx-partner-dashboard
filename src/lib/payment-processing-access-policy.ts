import type { AuthorizationContext, PagePermission } from "./authorization";

export type FinanceProcessingMembership = {
  role_id: string | null;
  is_active: boolean;
  has_all_location_access: boolean;
  location_scope_ids: string[] | null;
};
export type FinanceProcessingRole = {
  id: string;
  location_access_mode: string | null;
};

const denied: PagePermission = { canView: false, canAdd: false, canEdit: false };

/** Finance owns processor routing. Never union its scopes with legacy Dashboard access. */
export function applyFinanceProcessingAccess(
  dashboard: AuthorizationContext,
  memberships: FinanceProcessingMembership[],
  roles: FinanceProcessingRole[],
  financePermissions: Record<string, PagePermission>
): AuthorizationContext {
  // Preserve legacy companies that have never configured a Finance membership.
  // A disabled membership is an explicit revocation, not a legacy fallback.
  if (!memberships.length) return dashboard;
  const activeRoleIds = new Set(roles.map(role => role.id));
  const active = memberships.filter(row => row.is_active && row.role_id && activeRoleIds.has(row.role_id));
  const roleIds = [...new Set(active.map(row => row.role_id!))];
  const financeAll = active.some(row => row.has_all_location_access)
    || roles.some(role => roleIds.includes(role.id) && role.location_access_mode === "all_locations");
  const financeLocations = [...new Set(active.flatMap(row => row.location_scope_ids ?? []))];
  const hasAllLocationAccess = dashboard.hasAllLocationAccess && financeAll;
  const locationScopeIds = hasAllLocationAccess ? [] : dashboard.hasAllLocationAccess
    ? financeLocations
    : financeAll ? dashboard.locationScopeIds
      : dashboard.locationScopeIds.filter(id => financeLocations.includes(id));
  const permissions = { ...dashboard.permissions };
  for (const page of ["payment_process", "workforce_payouts"]) {
    const existing = dashboard.permissions[page] ?? denied;
    const finance = roleIds.length ? financePermissions[page] ?? denied : denied;
    permissions[page] = {
      canView: (existing.canView || existing.canEdit) && (finance.canView || finance.canEdit),
      canAdd: existing.canAdd && finance.canAdd,
      canEdit: existing.canEdit && finance.canEdit
    };
  }
  return {
    ...dashboard,
    effectiveRoleIds: roleIds,
    effectiveRoleCodes: [],
    roleId: roleIds[0] ?? null,
    // Do not inherit owner privilege from a membership; the authenticated
    // Dashboard owner's existing bypass is handled before this policy.
    hasAllLocationAccess,
    locationScopeIds,
    permissions
  };
}
