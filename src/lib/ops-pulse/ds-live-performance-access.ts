type RoleLike = {
  isMasterOwner?: boolean;
  roleCode?: string | null;
  roleName?: string | null;
  effectiveRoleCodes?: string[];
  designationName?: string | null;
  permissions?: Record<string, { canView?: boolean; canAdd?: boolean; canEdit?: boolean }>;
};

export const DS_OPERATIONS_PAGE_CODES = [
  "ds_live_performance",
  "ds_ppi",
  "ds_site_summary",
  "ds_datoms",
  "ds_cold_chain_alerts",
  "ds_workforce_pulse",
  "ds_message_policies"
] as const;
export type DsOperationsPageCode = (typeof DS_OPERATIONS_PAGE_CODES)[number];

function roleTokens(authorization: RoleLike) {
  const tokens = new Set<string>();
  for (const value of [authorization.roleCode, ...(authorization.effectiveRoleCodes ?? []), authorization.roleName, authorization.designationName]) {
    const code = String(value ?? "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!code) continue;
    tokens.add(code);
    tokens.add(code.replace(/^(OPERATIONS|FINANCE|PEOPLE)_/, ""));
  }
  return tokens;
}

/** FSD / Admin / Owner role gate shared by Dark Store Operations pages. */
export function hasDsOperationsRole(authorization: RoleLike | null) {
  if (!authorization) return false;
  if (authorization.isMasterOwner || authorization.roleCode === "OWNER") return true;

  const tokens = roleTokens(authorization);
  const allowed = new Set([
    "FSD",
    "FULL_STACK_DEVELOPER",
    "FULLSTACK_DEVELOPER",
    "ADMIN",
    "COMPANY_ADMIN",
    "OPERATIONS_ADMIN"
  ]);
  if ([...tokens].some((token) => allowed.has(token))) return true;

  // Designation phrase fallback is FSD-only — avoid matching "Station Admin" etc.
  const phrase = ` ${String(authorization.designationName ?? authorization.roleName ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()} `;
  return phrase.includes(" FULL STACK ");
}

/**
 * Dark Store Operations pages: FSD/Admin/Owner by default, or an explicit Settings
 * page grant (so managers can be enabled later without another code change).
 */
export function canViewDsOperations(authorization: RoleLike | null, pageCode: DsOperationsPageCode = "ds_live_performance") {
  if (!authorization) return false;
  if (hasDsOperationsRole(authorization)) return true;
  const grant = authorization.permissions?.[pageCode];
  if (grant?.canView || grant?.canAdd || grant?.canEdit) return true;
  // DATOMS hub reuses the legacy cold-chain page grant.
  if (pageCode === "ds_datoms") {
    const legacy = authorization.permissions?.ds_cold_chain_alerts;
    return Boolean(legacy?.canView || legacy?.canAdd || legacy?.canEdit);
  }
  if (pageCode === "ds_cold_chain_alerts") {
    const hub = authorization.permissions?.ds_datoms;
    return Boolean(hub?.canView || hub?.canAdd || hub?.canEdit);
  }
  return false;
}

/** @deprecated Prefer canViewDsOperations — kept for existing imports. */
export function canViewDsLivePerformance(authorization: RoleLike | null) {
  return canViewDsOperations(authorization, "ds_live_performance");
}
