export type DesignationLabel = { name: string; code: string | null };

export function isTeamLeadDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase();
  return code === "TL"
    || code === "ATL"
    || code === "TEAM_LEAD"
    || code === "ASST_TEAM_LEAD"
    || code === "ASSISTANT_TEAM_LEAD"
    || name.includes("team lead")
    || name.includes("team-lead");
}

/** Station-floor roles that must not be the final roster approver. */
export function isStationFloorRosterDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  if (isTeamLeadDesignation(designation)) return true;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase();
  return code === "STM"
    || code === "SM"
    || code === "SRSM"
    || code === "STATION_MANAGER"
    || code === "STORE_MANAGER"
    || code === "SENIOR_STORE_MANAGER"
    || name.includes("station manager")
    || name.includes("store manager");
}

/** Leadership / HR / FSD designations that can prepare roster changes in Ops and People. */
export function isRosterDirectPublishDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase();
  return code === "FSD"
    || code === "HRM"
    || code === "HRE"
    || code === "HR"
    || code === "HR_HEAD"
    || code === "HR_EXECUTIVE"
    || code === "NH"
    || code === "MANAGING_PARTNER"
    || code === "BH"
    || code === "BUSINESS_HEAD"
    || code === "FH"
    || code === "FINMGR"
    || code === "FINANCE_HEAD"
    || code === "FINANCE_MANAGER"
    || name === "full stack developer"
    || name.includes("hr head")
    || name.includes("hr executive")
    || name === "hr"
    || name.includes("national head")
    || name.includes("managing partner")
    || name.includes("business head")
    || name.includes("finance head")
    || name.includes("finance manager");
}

/** Ops product roles that should plan rosters even if People designation lookup is missing. */
export function isOpsRosterPlannerRole(roleCode: string | null | undefined) {
  const code = String(roleCode ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  return code === "OWNER"
    || code === "OWNER_BREAK_GLASS"
    // Shared station mailboxes (tta5@…, tcc3@…) use OPERATIONS_LOCATION and have no People designation.
    || code === "LOCATION"
    || code === "OPERATIONS_LOCATION"
    || code.endsWith("_FSD")
    || code === "FSD"
    || code.includes("FULL_STACK");
}
