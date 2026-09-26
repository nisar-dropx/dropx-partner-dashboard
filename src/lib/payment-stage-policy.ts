/** Pure approval-sequence rules shared by routing, inboxes and action guards. */
export type StageCandidate = { role_id: string; scope: "station" | "cluster" | "company" };
export type ApprovalStage = {
  step_order: number;
  candidates: StageCandidate[];
  is_required: boolean;
  has_local_candidates?: boolean;
};
export type StageTarget = { userId: string; roleId: string } | null;

export function isLocalApprovalStage(step: ApprovalStage) {
  return step.has_local_candidates ?? step.candidates.some(candidate => candidate.scope !== "company");
}

/**
 * Repairs a persisted step pointer when the named assignee role belongs to one
 * unambiguous configured step but the request still points at another step.
 * Never infer a step for roles reused at multiple levels.
 */
export function effectiveApprovalStepOrder(
  steps: ApprovalStage[],
  storedStepOrder: number,
  assignedRoleId: string | null | undefined
) {
  if (!assignedRoleId) return storedStepOrder;
  const storedStep = steps.find(step => step.step_order === storedStepOrder);
  if (storedStep?.candidates.some(candidate => candidate.role_id === assignedRoleId)) return storedStepOrder;

  const matchingSteps = steps.filter(step => step.candidates.some(candidate => candidate.role_id === assignedRoleId));
  return matchingSteps.length === 1 ? matchingSteps[0].step_order : storedStepOrder;
}

export async function resolveInitialStage<T extends ApprovalStage>(
  steps: T[], resolve: (step: T) => Promise<StageTarget>
) {
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order);
  let unresolvedLocal: T | undefined;
  for (const step of ordered) {
    // A missing/absent local manager is not an approval. Never promote a new
    // request to a company-level approver after skipping all local stages.
    if (!isLocalApprovalStage(step) && unresolvedLocal) {
      return { step: unresolvedLocal, approver: null };
    }
    const approver = await resolve(step);
    if (approver || step.is_required) return { step, approver };
    if (isLocalApprovalStage(step)) unresolvedLocal = step;
  }
  return { step: unresolvedLocal ?? ordered.at(-1), approver: null };
}

export function initialStageStatus(approver: StageTarget) {
  // Step numbers describe configuration, not completed approval history.
  return approver ? "PENDING" : "NO_APPROVER_CONFIGURED";
}

export function hasInitialApprovalForStage(
  steps: ApprovalStage[], currentStepOrder: number,
  approvals: { action: string | null; approver_role_id: string | null }[]
) {
  const current = steps.find(step => step.step_order === currentStepOrder);
  if (!current) return false;
  if (isLocalApprovalStage(current)) return true;
  const priorLocalRoles = new Set(steps.filter(step => step.step_order < currentStepOrder && isLocalApprovalStage(step))
    .flatMap(step => step.candidates.map(candidate => candidate.role_id)));
  if (!priorLocalRoles.size) return true; // Explicitly company-only workflow.
  return approvals.some(approval => String(approval.action).toLowerCase() === "approved" &&
    Boolean(approval.approver_role_id && priorLocalRoles.has(approval.approver_role_id)));
}

export function hasInitialApprovalForPersistedRequest(
  steps: ApprovalStage[], currentStepOrder: number, totalSteps: number | null,
  approvals: { action: string | null; approver_role_id: string | null }[]
) {
  if (!totalSteps) return true; // Legacy two-phase routing has no step master.
  // Do not reinterpret already-approved, longer historical workflows using
  // a shorter master edited later. Preserve the persisted Finance assignee.
  if (currentStepOrder > steps.length && totalSteps > steps.length &&
      approvals.some(approval => approval.action === "approved")) return true;
  return hasInitialApprovalForStage(steps, currentStepOrder, approvals);
}

export function matchesCurrentPaymentAssignee(
  userId: string, roleIds: string[],
  request: { current_approver_user_id?: string | null; current_approver_role_id?: string | null; current_approver_role_ids?: string[] | null }
) {
  // Named assignment is authoritative. A broad/secondary role must not make
  // another person's requests actionable; role pools apply only when unnamed.
  if (request.current_approver_user_id) return request.current_approver_user_id === userId;
  return Boolean(request.current_approver_role_id && roleIds.includes(request.current_approver_role_id)) ||
    (request.current_approver_role_ids ?? []).some(role => roleIds.includes(role));
}

export function isPendingPaymentApproval(status: string | null, approvalStatus: string | null) {
  const terminal = new Set(["FINAL_APPROVED", "RE_APPROVED", "PROCESSED", "PROCESSING", "RETURNED", "REJECTED", "CANCELLED"]);
  return String(status).toUpperCase() !== "APPROVED" && !terminal.has(String(status).toUpperCase()) && !terminal.has(String(approvalStatus).toUpperCase());
}
