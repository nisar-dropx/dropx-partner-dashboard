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
