export type CarryForwardStep = {
  step_order: number;
  stage_code?: "manager" | "policy_exception" | "finance";
  approver_user_id: string;
  [key: string]: unknown;
};

export type ApprovedExpenseRequest = {
  status?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
  estimated_amount?: number | string | null;
  expected_expenses?: Record<string, unknown> | null;
};

export type ClaimedExpenseLine = { categoryId: string; amount: number };

export type ApprovalCarryForwardResult<T extends CarryForwardStep> = {
  steps: T[];
  applied: boolean;
  approvedByUserId: string | null;
  approvedAt: string | null;
  skippedManagerCount: number;
  reason: "applied" | "request_not_approved" | "missing_source_approver" | "amount_exceeded" | "breakdown_mismatch" | "approver_not_in_route";
};

const MONEY_TOLERANCE = 0.01;

function finiteMoney(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * Reuses a higher-manager approval from the approved estimate only when the
 * submitted claim remains inside both the total estimate and every approved
 * expense head. Finance and policy-exception steps are never bypassed.
 */
export function carryForwardApprovedExpenseRequest<T extends CarryForwardStep>(
  steps: T[],
  request: ApprovedExpenseRequest | null | undefined,
  items: ClaimedExpenseLine[]
): ApprovalCarryForwardResult<T> {
  const unchanged = (reason: ApprovalCarryForwardResult<T>["reason"]): ApprovalCarryForwardResult<T> => ({
    steps,
    applied: false,
    approvedByUserId: request?.decided_by ?? null,
    approvedAt: request?.decided_at ?? null,
    skippedManagerCount: 0,
    reason
  });

  if (request?.status !== "approved") return unchanged("request_not_approved");
  if (!request.decided_by) return unchanged("missing_source_approver");

  const total = items.reduce((sum, item) => sum + finiteMoney(item.amount), 0);
  if (total - finiteMoney(request.estimated_amount) > MONEY_TOLERANCE) return unchanged("amount_exceeded");

  const expected = request.expected_expenses;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return unchanged("breakdown_mismatch");
  const actualByCategory = new Map<string, number>();
  for (const item of items) {
    actualByCategory.set(item.categoryId, (actualByCategory.get(item.categoryId) ?? 0) + finiteMoney(item.amount));
  }
  for (const [categoryId, amount] of actualByCategory) {
    if (!(categoryId in expected) || amount - finiteMoney(expected[categoryId]) > MONEY_TOLERANCE) {
      return unchanged("breakdown_mismatch");
    }
  }

  let approvedManagerIndex = -1;
  steps.forEach((step, index) => {
    if (step.stage_code === "manager" && step.approver_user_id === request.decided_by) approvedManagerIndex = index;
  });
  if (approvedManagerIndex < 0) return unchanged("approver_not_in_route");

  const retained = steps
    .filter((step, index) => !(index <= approvedManagerIndex && step.stage_code === "manager"))
    .map((step, index) => ({ ...step, step_order: index + 1 }));
  const skippedManagerCount = steps.length - retained.length;
  if (!retained.some((step) => step.stage_code === "finance")) return unchanged("approver_not_in_route");

  return {
    steps: retained,
    applied: true,
    approvedByUserId: request.decided_by,
    approvedAt: request.decided_at ?? null,
    skippedManagerCount,
    reason: "applied"
  };
}
