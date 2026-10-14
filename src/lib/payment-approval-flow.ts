export type FlowStepState = "done" | "current" | "returned" | "stopped" | "upcoming" | "skipped";

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

type FlowLog = { approval_step_order?: number | null; action: string | null; approver_user_id: string | null; approver_role_id: string | null; created_at: string };

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
    status === "approved" || approvalStatus === "FINAL_APPROVED" || approvalStatus === "OWNER_APPROVED" ||
    approvalStatus === "RE_APPROVED" || currentStep > Math.max(0, ...levels.map(level => level.stepOrder));
  const returned = status === "returned" || approvalStatus === "RETURNED";
  const stopped = ["cancelled", "rejected"].includes(status) || ["CANCELLED", "REJECTED"].includes(approvalStatus);

  const lastReset = logs.filter(log => ['returned','resubmitted','rejected'].includes(String(log.action).toLowerCase())).at(-1)?.created_at;
  const approvals = logs.filter(log => String(log.action ?? "").toLowerCase() === "approved" && (!lastReset || log.created_at > lastReset));
  const used = new Set<FlowLog>();
  const approvalFor = (level: { stepOrder: number; roleIds: string[] }) => {
    const available = approvals.filter(log => !used.has(log));
    const match = available.find(log => log.approval_step_order === level.stepOrder) ??
      available.find(log => !log.approval_step_order && log.approver_role_id && level.roleIds.includes(log.approver_role_id));
    if (match) used.add(match);
    return match ?? null;
  };

  const steps: FlowStep[] = levels.map((level, index) => {
    let state: FlowStepState;
    if (withFinance || level.stepOrder < currentStep) state = "done";
    else if (level.stepOrder === currentStep) state = returned ? "returned" : stopped ? "stopped" : "current";
    else state = "upcoming";
    const approval = state === "done" ? approvalFor(level) : null;
    if (state === "done" && !approval) state = "skipped";
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
