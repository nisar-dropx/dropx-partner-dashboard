export type FlowStepState = "done" | "current" | "returned" | "stopped" | "upcoming";

export type FlowStep = {
  key: string;
  label: string;
  roleIds: string[];
  state: FlowStepState;
  approvedByUserId?: string | null;
  approvedAt?: string | null;
};

type FlowRequest = {
  status: string | null;
  approval_status: string | null;
  current_step_order: number | null;
};

type FlowLog = { action: string | null; approver_user_id: string | null; approver_role_id: string | null; created_at: string };

/**
 * Builds the approval flow shown in the payment request View modal: every configured approval
 * level followed by Finance payment, each marked approved / pending / returned / stopped / upcoming
 * from the request's current step and its approval history.
 */
export function buildPaymentApprovalFlow(
  request: FlowRequest,
  levels: Array<{ stepOrder: number; roleIds: string[] }>,
  financeRoleIds: string[],
  logs: FlowLog[]
): FlowStep[] {
  const status = String(request.status ?? "").toLowerCase();
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  const currentStep = Number(request.current_step_order) || 1;
  const paid = status === "processed" || approvalStatus === "PROCESSED";
  const withFinance = paid || status === "processing" || approvalStatus === "PROCESSING" ||
    status === "approved" || approvalStatus === "APPROVED" || approvalStatus === "OWNER_APPROVED" ||
    approvalStatus === "RE_APPROVED" || currentStep > levels.length;
  const returned = status === "returned" || approvalStatus === "RETURNED";
  const stopped = ["cancelled", "rejected"].includes(status) || ["CANCELLED", "REJECTED"].includes(approvalStatus);

  const approvals = logs.filter((log) => String(log.action ?? "").toLowerCase() === "approved");
  const approvalFor = (roleIds: string[], index: number) =>
    [...approvals].reverse().find((log) => log.approver_role_id && roleIds.includes(log.approver_role_id)) ?? approvals[index] ?? null;

  const steps: FlowStep[] = levels.map((level, index) => {
    let state: FlowStepState;
    if (withFinance || level.stepOrder < currentStep) state = "done";
    else if (level.stepOrder === currentStep) state = returned ? "returned" : stopped ? "stopped" : "current";
    else state = "upcoming";
    const approval = state === "done" ? approvalFor(level.roleIds, index) : null;
    return {
      key: `level-${level.stepOrder}`,
      label: `Level ${index + 1} approval`,
      roleIds: level.roleIds,
      state,
      approvedByUserId: approval?.approver_user_id ?? null,
      approvedAt: approval?.created_at ?? null
    };
  });

  steps.push({
    key: "finance",
    label: "Finance payment",
    roleIds: financeRoleIds,
    state: paid ? "done" : stopped || returned ? "upcoming" : withFinance ? "current" : "upcoming"
  });
  return steps;
}
