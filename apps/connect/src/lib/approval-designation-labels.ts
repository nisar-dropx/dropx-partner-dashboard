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

export function isStationOrStoreManagerDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase();
  return code === "SM"
    || code === "STM"
    || code === "SRSM"
    || code === "STATION_MANAGER"
    || code === "STORE_MANAGER"
    || code === "SENIOR_STORE_MANAGER"
    || name.includes("station manager")
    || name.includes("store manager");
}

export function isStationTeamFloorDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  if (isStationOrStoreManagerDesignation(designation) || isTeamLeadDesignation(designation)) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase().replaceAll("-", " ");
  return code === "PC"
    || code === "PTPC"
    || code === "PICKER"
    || code === "PACKER"
    || code === "HELPER"
    || code === "LOADER"
    || code === "SORTER"
    || code === "ASSOCIATE"
    || code === "QC"
    || /\b(picker|packers?|associates?|helpers?|loaders?|sorters?|telecallers?)\b/.test(name)
    || name.includes("quality control");
}

export function isFloorResignationDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  return isTeamLeadDesignation(designation)
    || isStationOrStoreManagerDesignation(designation)
    || isStationTeamFloorDesignation(designation);
}

export function isClusterManagerDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase().replaceAll("-", " ");
  return code === "CLM"
    || code === "CLUSTER_MANAGER"
    || name.includes("cluster manager");
}

export function isWfhHardBlockedDesignation(designation: DesignationLabel | null | undefined) {
  return isTeamLeadDesignation(designation) || isStationOrStoreManagerDesignation(designation);
}

/** National / Business Head — final reimbursement manager; Managing Partner L2 is skipped. */
export function isBusinessOrNationalHeadDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase();
  return code === "NH"
    || code === "BH"
    || code === "BUSINESS_HEAD"
    || code === "NATIONAL_HEAD"
    || name.includes("national head")
    || name.includes("business head");
}

export function isFinanceHeadDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase().replaceAll("-", " ");
  return code === "FH"
    || code === "FINMGR"
    || code === "FINANCE_HEAD"
    || code === "FINANCE_MANAGER"
    || name.includes("finance head")
    || name.includes("finance manager");
}

export function isManagingPartnerDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase();
  return code === "MP"
    || code === "MANAGING_PARTNER"
    || name.includes("managing partner");
}

export function isHrPeopleDesignation(designation: DesignationLabel | null | undefined) {
  if (!designation) return false;
  if (isManagingPartnerDesignation(designation)) return false;
  const code = (designation.code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const name = designation.name.toLowerCase().replaceAll("-", " ");
  return code === "HR"
    || code === "HRM"
    || code === "HRE"
    || code === "HR_HEAD"
    || code === "HR_MANAGER"
    || code === "HR_EXECUTIVE"
    || code === "PEOPLE_HEAD"
    || name.includes("hr head")
    || name.includes("hr manager")
    || name.includes("hr executive")
    || name === "hr"
    || name.includes("human resource")
    || name.includes("people ops")
    || name.includes("people operations");
}
