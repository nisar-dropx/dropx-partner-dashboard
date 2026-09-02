import "server-only";

import {
  resolveAttendanceRegularizationApprovers,
  type AttendanceRegularizationApprovalStep
} from "@/lib/attendance-regularization-workflow";

export type AttendanceApprovalStep = AttendanceRegularizationApprovalStep;

export { isTeamLeadDesignation } from "@/lib/approval-designation-labels";

export async function resolveAttendanceApprovalSteps({
  companyId,
  workerId,
  workerType
}: {
  companyId: string;
  workerId: string;
  workerType: "employee" | "contractor";
}): Promise<AttendanceApprovalStep[]> {
  const resolution = await resolveAttendanceRegularizationApprovers(companyId, workerType, workerId);
  return resolution.steps;
}

export type AttendanceRegularizationRouteResolution = Awaited<ReturnType<typeof resolveAttendanceRegularizationApprovers>>;

export { resolveAttendanceRegularizationApprovers };

/** @deprecated Use isTeamLeadDesignation from approval-designation-labels */
export function isTeamLeadManagerAssignment(
  designationCode: string | null | undefined,
  positionTitle: string | null | undefined
): boolean {
  const code = String(designationCode ?? "").trim().toUpperCase();
  if (["TL", "ATL", "TEAM_LEAD", "ASST_TEAM_LEAD"].includes(code)) return true;
  const title = String(positionTitle ?? "").trim().toUpperCase();
  if (!title) return false;
  return /\b(TL|ATL|TEAM LEAD|ASST\.?\s*TEAM LEAD|ASSISTANT TEAM LEAD)\b/.test(title);
}
