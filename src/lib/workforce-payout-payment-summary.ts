export type WorkforcePayoutPaymentAttemptSummary = {
  workforceId: string;
  status: string;
  amount: number;
  currentTargetAmount?: number;
};

export type WorkforcePayoutCurrentAmount = {
  rowId: string;
  workforceId: string;
  netAmount: number;
};

export type WorkforcePayoutPaymentSummary = {
  currentNetAmount: number;
  paidAmount: number;
  processingAmount: number;
  balancePayable: number;
  availableToPay: number;
  overpaidAmount: number;
  historyCount: number;
  status: "Payment Processing" | "Paid" | "Partially paid" | null;
};

function money(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

export function summarizeWorkforcePayoutPayments(
  currentRows: readonly WorkforcePayoutCurrentAmount[],
  attempts: readonly WorkforcePayoutPaymentAttemptSummary[]
) {
  const currentByWorkforce = new Map<string, number>();
  const seenRows = new Set<string>();
  currentRows.forEach((row) => {
    const workforceId = String(row.workforceId ?? "").trim().toLowerCase();
    const rowId = String(row.rowId ?? "").trim();
    if (!workforceId || !rowId || seenRows.has(rowId)) return;
    seenRows.add(rowId);
    currentByWorkforce.set(
      workforceId,
      money((currentByWorkforce.get(workforceId) ?? 0) + (Number(row.netAmount) || 0))
    );
  });

  const attemptsByWorkforce = new Map<string, WorkforcePayoutPaymentAttemptSummary[]>();
  attempts.forEach((attempt) => {
    const workforceId = String(attempt.workforceId ?? "").trim().toLowerCase();
    if (!workforceId) return;
    const rows = attemptsByWorkforce.get(workforceId) ?? [];
    rows.push(attempt);
    attemptsByWorkforce.set(workforceId, rows);
  });

  const workforceIds = new Set([...currentByWorkforce.keys(), ...attemptsByWorkforce.keys()]);
  const summaries = new Map<string, WorkforcePayoutPaymentSummary>();
  workforceIds.forEach((workforceId) => {
    const history = attemptsByWorkforce.get(workforceId) ?? [];
    const processingHistory = history.filter((attempt) => attempt.status.trim().toLowerCase() === "processing");
    const frozenProcessingTarget = processingHistory.length
      ? Math.max(...processingHistory.map((attempt) => Number(attempt.currentTargetAmount) || 0))
      : null;
    const currentNetAmount = money(Math.max(0, frozenProcessingTarget ?? currentByWorkforce.get(workforceId) ?? 0));
    const paidAmount = money(history
      .filter((attempt) => attempt.status.trim().toLowerCase() === "paid")
      .reduce((sum, attempt) => sum + Math.max(0, Number(attempt.amount) || 0), 0));
    const processingAmount = money(processingHistory
      .reduce((sum, attempt) => sum + Math.max(0, Number(attempt.amount) || 0), 0));
    const balancePayable = money(Math.max(0, currentNetAmount - paidAmount));
    const availableToPay = money(Math.max(0, balancePayable - processingAmount));
    const overpaidAmount = money(Math.max(0, paidAmount - currentNetAmount));
    const status = processingAmount > 0
      ? "Payment Processing"
      : paidAmount > 0 && balancePayable === 0
        ? "Paid"
        : paidAmount > 0
          ? "Partially paid"
          : null;
    summaries.set(workforceId, {
      currentNetAmount,
      paidAmount,
      processingAmount,
      balancePayable,
      availableToPay,
      overpaidAmount,
      historyCount: history.length,
      status
    });
  });
  return summaries;
}
