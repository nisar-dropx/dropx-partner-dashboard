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
  processingPaymentItemId?: string | null;
  processingInstructionAmount?: number | null;
  currentNetAmount: number;
  paidAmount: number;
  processingAmount: number;
  balancePayable: number;
  availableToPay: number;
  overpaidAmount: number;
  historyCount: number;
  status:
    | "Payment Processing"
    | "Payment Failed"
    | "Payment Cancelled"
    | "Payment On Hold"
    | "PAN Not Linked"
    | "Paid"
    | "Partially paid"
    | null;
  eligible: boolean | null;
  eligibilityCode: string | null;
  eligibilityMessage: string | null;
};

const PAYMENT_BALANCE_AVAILABLE_CODES = new Set([
  "eligible",
  "payment_processing",
  "payment_on_hold",
  "pan_not_linked",
  "profile_not_active",
  "no_positive_balance",
  "beneficiary_bank_details_missing",
  "beneficiary_bank_account_invalid",
  "beneficiary_ifsc_invalid",
  "payment_reference_invalid",
  "current_location_missing"
]);

export function isWorkforcePayoutPaymentBalanceAvailable(
  summary: Pick<WorkforcePayoutPaymentSummary, "eligible" | "eligibilityCode">
) {
  if (summary.eligible !== false) return true;
  return PAYMENT_BALANCE_AVAILABLE_CODES.has(String(summary.eligibilityCode ?? "").trim().toLowerCase());
}

export function workforcePayoutPaymentEligibilityLabel(
  summary: Pick<WorkforcePayoutPaymentSummary, "eligible" | "eligibilityCode">
) {
  if (summary.eligible !== false) return null;
  switch (String(summary.eligibilityCode ?? "").trim().toLowerCase()) {
    case "publication_refresh_pending":
      return "Publication refresh pending";
    case "publication_missing":
      return "Publish before payment";
    case "publication_stale_or_incomplete":
      return "Republish required";
    case "mapping_relock_required":
      return "Relock required";
    case "profile_unavailable":
      return "Payment profile unavailable";
    case "profile_not_active":
      return "Active profiles only";
    case "no_positive_balance":
      return "No positive balance";
    case "beneficiary_bank_details_missing":
    case "beneficiary_bank_account_invalid":
    case "beneficiary_ifsc_invalid":
    case "payment_reference_invalid":
      return "Payment details required";
    case "current_location_missing":
      return "Current location required";
    case "payment_processing":
      return null;
    case "payment_on_hold":
      return "Payment on hold";
    case "pan_not_linked":
      return "PAN not linked";
    default:
      return "Payment unavailable";
  }
}

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
    const latestAttemptStatus = history.at(-1)?.status.trim().toLowerCase() ?? "";
    const status = processingAmount > 0
      ? "Payment Processing"
      : paidAmount > 0 && balancePayable === 0
        ? "Paid"
        : latestAttemptStatus === "failed"
          ? "Payment Failed"
          : latestAttemptStatus === "cancelled"
            ? "Payment Cancelled"
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
      status,
      eligible: null,
      eligibilityCode: null,
      eligibilityMessage: null
    });
  });
  return summaries;
}
