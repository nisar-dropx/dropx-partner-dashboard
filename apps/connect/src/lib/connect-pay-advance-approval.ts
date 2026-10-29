export type PayAdvanceApproval = {
  id: string; requestId: string; requestNumber: string; workerName: string; workerCode: string;
  stepName: string; stepType: string; requestedAmount: number; approvedAmount: number | null;
  workerType: string; outstandingPay: number | null; eligibilityPercent: number | null;
  maxEligibleAmount: number | null; eligibilityWithinLimit: boolean;
  monthPaidCount: number; monthPaidAmount: number; outstandingAdvance: number; reservedRecovery: number;
  recoveryMode: string; installments: number; reason: string; neededBy: string | null;
};

export type PayAdvanceReviewDetails = {
  requestedAt: string | null;
  submittedBy: string;
  steps: Array<{ id: string; label: string; status: string; actorName: string | null;
    actedAt: string | null; note: string | null; approvedAmount: number | null }>;
  capacity: { outstandingPay: number; maxEligibleAmount: number; committedAdvance: number;
    eligibilityPercent: number; breakdown: Array<{ month: string; outstanding: number }> };
  requestLimit: number;
  advances: Array<{ id: string; reference: string; amount: number; paidAt: string;
    firstDuePeriod: string; installments: number; evidence: string; bankReference: string | null;
    recovered: number; reserved: number; waived: number; outstanding: number;
    deductions: Array<{ id: string; period: string; amount: number; status: string; target: string }> }>;
};

export function payAdvanceApprovalPayContext(
  workerTypeValue: unknown,
  requestedAmountValue: unknown,
  outstandingPayValue: unknown,
  eligibilityPercentValue: unknown,
  maxEligibleAmountValue: unknown,
) {
  const workerType = String(workerTypeValue ?? "").trim().toLowerCase();
  const requestedAmount = Number(requestedAmountValue ?? 0);
  const maximum = Number(maxEligibleAmountValue ?? requestedAmount);
  const workforceAmountsVisible = ["employee", "contractor", "workforce"].includes(workerType);
  return {
    workerType,
    outstandingPay: workforceAmountsVisible ? Number(outstandingPayValue ?? 0) : null,
    eligibilityPercent: workforceAmountsVisible ? Number(eligibilityPercentValue ?? 25) : null,
    maxEligibleAmount: workforceAmountsVisible ? maximum : null,
    eligibilityWithinLimit: Number.isFinite(requestedAmount) && Number.isFinite(maximum) && requestedAmount <= maximum,
  };
}

export function payAdvanceDecision(value: unknown, note: unknown) {
  if (value !== "approved" && value !== "rejected" && value !== "returned") throw new Error("Choose Approve, Return, or Reject.");
  const cleanedNote = String(note ?? "").trim();
  if (cleanedNote.length > 500) throw new Error("Keep the review note within 500 characters.");
  if ((value === "rejected" || value === "returned") && cleanedNote.length < 3) {
    throw new Error(value === "returned" ? "Add a short note explaining why the request is being returned." : "Add a reason when rejecting a pay advance.");
  }
  return { decision: value, note: cleanedNote || null };
}

export function payAdvanceFinanceTerms(amount: unknown, installments: unknown, maxEligibleAmount: number) {
  const approvedAmount = Number(amount);
  const approvedInstallments = Number(installments);
  if (!Number.isFinite(approvedAmount) || approvedAmount <= 0 || approvedAmount > maxEligibleAmount) throw new Error("Enter an approved amount greater than zero and within the 25% outstanding-pay limit.");
  if (!Number.isInteger(approvedInstallments) || approvedInstallments < 1 || approvedInstallments > 12) throw new Error("Choose between 1 and 12 recovery installments.");
  return { approvedAmount, approvedInstallments };
}
