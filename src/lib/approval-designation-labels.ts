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

/** Station-floor roles skipped in roster approval (TL / SM / STM). Senior Store Manager (SRSM) may approve. */
export function isStationFloorRosterDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  if (isTeamLeadDesignation(designation)) return true;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase().replaceAll("-", " ");
  if (code === "SRSM" || code === "SENIOR_STORE_MANAGER" || name.includes("senior store manager")) {
    return false;
  }
  return code === "STM"
    || code === "SM"
    || code === "STATION_MANAGER"
    || code === "STORE_MANAGER"
    || name.includes("station manager")
    || (name.includes("store manager") && !name.includes("senior store manager"));
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

/** The HR Head seat only. HR Executive and other HR roles are not this seat. */
export function isHrHeadDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase().replaceAll("-", " ").replace(/\s+/g, " ").trim();
  return code === "HRM"
    || code === "HR_HEAD"
    || code === "PEOPLE_HRM"
    || code === "OPERATIONS_HRM"
    || code === "WORKFORCE_HRM"
    || code === "RECRUIT_HRM"
    || name === "hr head"
    || name.includes("hr head");
}

/** Access-role codes that are the HR Head seat, including the live HR_HAEAD typo. */
export function isHrHeadRoleCode(code: string | null | undefined) {
  const value = String(code ?? "").trim().toUpperCase();
  return value === "HR_HEAD"
    || value === "HR_HAEAD"
    || value === "HRM"
    || value === "PEOPLE_HRM"
    || value === "OPERATIONS_HRM"
    || value === "WORKFORCE_HRM"
    || value === "RECRUIT_HRM"
    || value === "HR_MANAGER";
}

/**
 * Station Manager only. Station-floor attendance regularization starts above
 * this seat. Store Manager and Senior Store Manager are not skipped: they
 * approve their own store's pickers and floor staff.
 */
export function isStationManagerDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase().replaceAll("-", " ");
  return code === "STM" || code === "STATION_MANAGER" || name.includes("station manager");
}

/** Station manager, store manager, and senior store manager. */
export function isStoreOrStationManagerDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
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

/**
 * Station-floor workers whose attendance regularization starts above the
 * station manager: picker, station support, delivery associate, and the same
 * kind of station role. Store managers still approve (see
 * isStationManagerDesignation).
 */
export function isStationSupportAttendanceDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  if (isTeamLeadDesignation(designation) || isStoreOrStationManagerDesignation(designation)) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase().replaceAll("-", " ").replace(/\s+/g, " ").trim();
  if ([
    "PC", "PTPC", "SSA", "PTSSA", "DA", "PTDA", "DCD", "ODCD", "DR", "HK",
    "SRTR", "QC", "TC", "WFA", "PICKER", "PACKER", "HELPER", "LOADER", "SORTER"
  ].includes(code)) return true;
  return /\b(pickers?|station support|delivery associates?|drivers?|house keeping|sorters?|telecallers?|packers?|helpers?|loaders?)\b/.test(name)
    || name.includes("quality control");
}

export function isManagingPartnerDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase();
  return code === "MP"
    || code === "MANAGING_PARTNER"
    || name.includes("managing partner");
}
