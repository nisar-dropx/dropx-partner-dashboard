export type PayAdvanceApproval = {
  id: string; requestId: string; requestNumber: string; workerName: string; workerCode: string;
  stepName: string; stepType: string; requestedAmount: number; approvedAmount: number | null;
  recoveryMode: string; installments: number; reason: string; neededBy: string | null;
};

export function payAdvanceDecision(value: unknown, note: unknown) {
  if (value !== "approved" && value !== "rejected") throw new Error("Choose Approve or Reject.");
  const cleanedNote = String(note ?? "").trim();
  if (cleanedNote.length > 500) throw new Error("Keep the review note within 500 characters.");
  if (value === "rejected" && cleanedNote.length < 3) throw new Error("Add a reason when rejecting a pay advance.");
  return { decision: value, note: cleanedNote || null };
}

export function payAdvanceFinanceTerms(amount: unknown, installments: unknown, requestedAmount: number) {
  const approvedAmount = Number(amount);
  const approvedInstallments = Number(installments);
  if (!Number.isFinite(approvedAmount) || approvedAmount <= 0 || approvedAmount > requestedAmount) throw new Error("Enter an approved amount greater than zero and no higher than the requested amount.");
  if (!Number.isInteger(approvedInstallments) || approvedInstallments < 1 || approvedInstallments > 12) throw new Error("Choose between 1 and 12 recovery installments.");
  return { approvedAmount, approvedInstallments };
}
