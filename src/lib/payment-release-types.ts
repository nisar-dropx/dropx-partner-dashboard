export type PaymentReleaseReview = {
  fingerprint: string;
  station: string;
  month: string;
  sourceCount: number;
  pendingCount: number;
  pendingAmount: number;
  missingDeductionCount: number;
  missingDeductionAmount: number;
  pending: Array<{ report: string; month: string; reference: string; amount: number; status: string }>;
  missingDeductions: Array<{ reference: string; amount: number; worker: string }>;
  approval: { id: string; actor: string; at: string; mode: string; reason: string } | null;
};
