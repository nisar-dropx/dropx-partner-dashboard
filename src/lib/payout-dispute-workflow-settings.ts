export const PAYOUT_DISPUTE_WORKFLOW_MAX_CANDIDATES = 3;

export type PayoutDisputeWorkflowStage = "initial" | "final" | "processor";

export type PayoutDisputeWorkflowSelection = Record<PayoutDisputeWorkflowStage, string[]>;

export const PAYOUT_DISPUTE_WORKFLOW_STAGES: Array<{
  code: PayoutDisputeWorkflowStage;
  label: string;
  description: string;
}> = [
  {
    code: "initial",
    label: "Initial approval",
    description: "Reviews the associate's concern and proposes the exact correction or rejection."
  },
  {
    code: "final",
    label: "Final approval",
    description: "Independently approves the proposed decision before any payout data can change."
  },
  {
    code: "processor",
    label: "Payout processor",
    description: "Applies only the final-approved correction to the authoritative payout input."
  }
];

export function normalizeWorkflowRoleIds(values: unknown[]) {
  const roleIds: string[] = [];
  for (const value of values) {
    const roleId = String(value ?? "").trim();
    if (!roleId || roleIds.includes(roleId)) continue;
    roleIds.push(roleId);
  }
  return roleIds;
}

export function validateWorkflowSelection(selection: PayoutDisputeWorkflowSelection) {
  const missing = PAYOUT_DISPUTE_WORKFLOW_STAGES
    .filter((stage) => selection[stage.code].length === 0)
    .map((stage) => stage.label);
  if (missing.length) {
    return `${missing.join(", ")} ${missing.length === 1 ? "requires" : "require"} at least one role.`;
  }

  const seen = new Map<string, PayoutDisputeWorkflowStage>();
  for (const stage of PAYOUT_DISPUTE_WORKFLOW_STAGES) {
    for (const roleId of selection[stage.code]) {
      const earlierStage = seen.get(roleId);
      if (earlierStage) {
        const earlierLabel = PAYOUT_DISPUTE_WORKFLOW_STAGES.find((item) => item.code === earlierStage)?.label ?? earlierStage;
        return `The same role cannot be used for both ${earlierLabel} and ${stage.label}.`;
      }
      seen.set(roleId, stage.code);
    }
  }

  return null;
}

