/** Pure helpers for Regional Manager roster location inheritance (no DB / server-only). */

export function isRegionalManagerSeat(input: {
  designationCode?: string | null;
  designationName?: string | null;
  roleCodes?: string[] | null;
}) {
  const code = String(input.designationCode ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = ` ${String(input.designationName ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ")} `;
  if (code === "RM" || code === "RH" || code === "REGIONAL_MANAGER" || code === "REGIONAL_HEAD") return true;
  if (/\b(REGIONAL MANAGER|REGIONAL HEAD)\b/.test(name)) return true;
  return (input.roleCodes ?? []).some((role) => {
    const value = String(role ?? "").toUpperCase().replace(/[\s-]+/g, "_");
    return value === "OPERATIONS_RM"
      || value === "OPERATIONS_REGIONAL_HEAD"
      || value === "REGIONAL_HEAD"
      || value === "REGIONAL_MANAGER";
  });
}

/** Skip People lookup when auth already proves this is not an RM seat. */
export function shouldResolveRegionalManagerReporteeScope(input: {
  designationName?: string | null;
  roleCodes?: string[] | null;
}) {
  if (isRegionalManagerSeat(input)) return true;
  const hasDesignation = Boolean(String(input.designationName ?? "").trim());
  const roleCodes = input.roleCodes ?? [];
  // Known non-RM identity → do not hit People.
  if (hasDesignation || roleCodes.length > 0) return false;
  // No designation/role hints → allow a People designation check.
  return true;
}

export function mergeRosterLocationScopeIds(
  locationScopeIds: string[],
  inheritedStationIds: string[],
  hasAllLocationAccess: boolean
) {
  if (hasAllLocationAccess) return [];
  return [...new Set([...locationScopeIds, ...inheritedStationIds].filter(Boolean))];
}
