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
    | "On Hold"
    | "Payment On Hold"
    | "PAN Not Linked"
    | "Paid"
    | "Partially Paid"
    | null;
  eligible: boolean | null;
  eligibilityCode: string | null;
  eligibilityMessage: string | null;
};

type WorkforcePayoutPaymentState = {
  publicationPaymentReady?: boolean;
  publicationLockState?: "locked" | "unlocked" | null;
  publicationTargetAmount?: number | null;
  netAmount: number;
  status: string;
  paymentSummary?: WorkforcePayoutPaymentSummary;
};

// The bank candidate deliberately stops before reading money when a mapping or
// publication is being revised. Those zero placeholders are not payment history.
export function workforcePayoutNeedsRecordedSettlements(eligibilityCode: string | null | undefined) {
  return [
    "mapping_relock_required",
    "publication_missing",
    "publication_stale_or_incomplete",
    "publication_refresh_pending"
  ].includes(String(eligibilityCode ?? "").trim().toLowerCase());
}

export type WorkforcePayoutRecordedSettlement = {
  payment_allocation_id: string;
  payment_item_id: string;
  settled_amount_snapshot: number | string;
};

export function withWorkforcePayoutRecordedSettlements(
  summary: WorkforcePayoutPaymentSummary,
  liveNetAmount: number,
  settlements: readonly WorkforcePayoutRecordedSettlement[]
): WorkforcePayoutPaymentSummary {
  if (!workforcePayoutNeedsRecordedSettlements(summary.eligibilityCode)) return summary;
  const target = paise(liveNetAmount);
  if (target === null) throw new Error("The current payout amount is unavailable.");
  const allocations = new Map<string, { itemId: string; amount: number }>();
  for (const row of settlements) {
    const amount = paise(row.settled_amount_snapshot);
    if (!row.payment_allocation_id || !row.payment_item_id || amount === null || amount < 0) {
      throw new Error("Recorded payout settlement evidence is invalid.");
    }
    const previous = allocations.get(row.payment_allocation_id);
    if (previous && (previous.amount !== amount || previous.itemId !== row.payment_item_id)) {
      throw new Error("Recorded payout settlement evidence conflicts.");
    }
    allocations.set(row.payment_allocation_id, { itemId: row.payment_item_id, amount });
  }
  const paid = [...allocations.values()].reduce((sum, row) => sum + row.amount, 0);
  return {
    ...summary,
    currentNetAmount: target / 100,
    paidAmount: paid / 100,
    balancePayable: Math.max(0, target - paid) / 100,
    overpaidAmount: Math.max(0, paid - target) / 100,
    historyCount: Math.max(summary.historyCount, new Set([...allocations.values()].map(row => row.itemId)).size),
    // This enriches the worksheet only. Relock/publication and all bank gates
    // remain mandatory, even when the live calculation has a positive balance.
    availableToPay: 0,
    eligible: false
  };
}

function paise(value: unknown) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) : null;
}

export function workforcePayoutTargetAmountsMatch(liveNetAmount: unknown, publishedNetAmount: unknown) {
  const live = paise(liveNetAmount);
  const published = paise(publishedNetAmount);
  return live !== null && published !== null && live === published;
}

export function workforcePayoutPublicationRefreshPending(
  audience: "workforce" | "helpers",
  publicationLockState: WorkforcePayoutPaymentState["publicationLockState"],
  liveNetAmount: unknown,
  publishedNetAmount: unknown
) {
  return audience === "workforce"
    && publicationLockState === "locked"
    && paise(publishedNetAmount) !== null
    && !workforcePayoutTargetAmountsMatch(liveNetAmount, publishedNetAmount);
}

/**
 * Review/publication freshness is the first payment gate. A bank preview based
 * on an older immutable publication must never overwrite that blocker merely
 * because the older snapshot was otherwise eligible.
 */
export function mergeWorkforcePayoutPaymentState<Row extends WorkforcePayoutPaymentState>(
  reviewedRow: Row,
  paymentRow: WorkforcePayoutPaymentState,
  audience: "workforce" | "helpers"
) {
  const paymentSummary = paymentRow.paymentSummary;
  if (!paymentSummary) return reviewedRow;

  const publishedTargetAmount = audience === "workforce"
    && Object.prototype.hasOwnProperty.call(reviewedRow, "publicationTargetAmount")
      ? reviewedRow.publicationTargetAmount
      : paymentSummary.currentNetAmount;
  const publishedTargetChanged = workforcePayoutPublicationRefreshPending(
    audience,
    reviewedRow.publicationLockState,
    reviewedRow.netAmount,
    publishedTargetAmount
  );
  const refreshPending = publishedTargetChanged
    || String(paymentSummary.eligibilityCode ?? "").trim().toLowerCase() === "publication_refresh_pending";
  const paymentProcessing = paymentSummary.status === "Payment Processing"
    || Number(paymentSummary.processingAmount) > 0;
  // The payment candidate RPC is the authoritative, location-level bank
  // preflight.  The review loader still carries a company/month dependency
  // hash for notification replay, so an unrelated payout change can make its
  // legacy `publicationPaymentReady` flag false even though the selected
  // publication was validated by the candidate RPC.  Trust that authoritative
  // candidate only when the review presentation independently confirms that a
  // publication/review exists.  Explicit freshness/relock blockers continue
  // to fail closed below and can never be bypassed by an older preview.
  const authoritativePublishedStatuses = new Set([
    "approved",
    "delivery needs review",
    "notification failed",
    "notification queued",
    "payment published",
    "under review"
  ]);
  const reviewReady = reviewedRow.publicationPaymentReady === true
    || (
      paymentRow.publicationPaymentReady === true
      && paymentSummary.eligible === true
      && authoritativePublishedStatuses.has(String(reviewedRow.status ?? "").trim().toLowerCase())
    );
  const numericPublishedTarget = paise(publishedTargetAmount) === null
    ? paymentSummary.currentNetAmount
    : Number(publishedTargetAmount);
  const effectiveBalance = money(Math.max(
    0,
    refreshPending
      ? Number(reviewedRow.netAmount) - Number(paymentSummary.paidAmount)
      : Number(paymentSummary.balancePayable)
  ));
  const financialLifecycleStatus = Number(paymentSummary.paidAmount) > 0
    ? effectiveBalance === 0
      ? "Paid" as const
      : "Partially Paid" as const
    : null;
  const mergedSummary = refreshPending
    ? {
        ...paymentSummary,
        currentNetAmount: numericPublishedTarget,
        balancePayable: money(Math.max(0, numericPublishedTarget - Number(paymentSummary.paidAmount))),
        availableToPay: 0,
        overpaidAmount: money(Math.max(0, Number(paymentSummary.paidAmount) - numericPublishedTarget)),
        status: paymentProcessing ? "Payment Processing" as const : paymentSummary.status,
        eligible: false,
        eligibilityCode: "publication_refresh_pending",
        eligibilityMessage: "Payout inputs changed after publication. The current balance will be revalidated before the bank file is created."
      } satisfies WorkforcePayoutPaymentSummary
    : paymentSummary;

  return {
    ...reviewedRow,
    publicationPaymentReady: !refreshPending
      && reviewReady
      && paymentRow.publicationPaymentReady === true,
    paymentSummary: mergedSummary,
    status: paymentProcessing
      ? "Payment Processing"
      : financialLifecycleStatus
        ? financialLifecycleStatus
      : refreshPending
        ? "Publication refresh pending"
      : reviewReady
        ? paymentSummary.status ?? reviewedRow.status
        : reviewedRow.status
  };
}

const PAYMENT_BALANCE_AVAILABLE_CODES = new Set([
  "eligible",
  "payment_processing",
  "payment_on_hold",
  "payout_dispute_open",
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
    case "payout_dispute_open":
      return "Open payout dispute";
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
        : paidAmount > 0 && balancePayable > 0
          ? "Partially Paid"
          : latestAttemptStatus === "failed"
            ? "Payment Failed"
            : latestAttemptStatus === "cancelled"
              ? "Payment Cancelled"
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
