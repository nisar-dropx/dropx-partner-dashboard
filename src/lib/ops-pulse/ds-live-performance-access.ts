type RoleLike = {
  isMasterOwner?: boolean;
  roleCode?: string | null;
  roleName?: string | null;
  effectiveRoleCodes?: string[];
  designationName?: string | null;
};

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

/**
 * Dark Store Live performance is limited to FSD and Admin (incl. company owners).
 * Not seeded to Review Desk users.
 */
export function canViewDsLivePerformance(authorization: RoleLike | null) {
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
