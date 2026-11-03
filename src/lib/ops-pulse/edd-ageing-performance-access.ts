type EddAgeingPerformanceRole = {
  isMasterOwner?: boolean;
  roleCode?: string | null;
  roleName?: string | null;
  effectiveRoleCodes?: string[];
  designationName?: string | null;
};

/**
 * Ageing + Performance tabs (network and station) are limited to FSD,
 * Managing Partner, Finance Head, and company owners.
 */
export function canViewEddAgeingPerformance(authorization: EddAgeingPerformanceRole | null) {
  if (!authorization) return false;
  if (authorization.isMasterOwner || authorization.roleCode === "OWNER") return true;

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

  const allowed = new Set([
    "FSD",
    "FULL_STACK_DEVELOPER",
    "FULLSTACK_DEVELOPER",
    "MP",
    "MANAGING_PARTNER",
    "FINMGR",
    "FINANCE_MANAGER",
    "FINANCE_HEAD",
    "FH",
    "CFO",
  ]);
  if ([...tokens].some((token) => allowed.has(token))) return true;

  const phrase = ` ${String(authorization.designationName ?? authorization.roleName ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()} `;
  return (
    phrase.includes(" FULL STACK ")
    || phrase.includes(" MANAGING PARTNER ")
    || phrase.includes(" FINANCE HEAD ")
    || phrase.includes(" FINANCE MANAGER ")
  );
}
