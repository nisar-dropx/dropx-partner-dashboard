import { installmentThresholdError, type RecoveryPolicy } from './nl-loss-policy';

export const LOSS_EXCEPTION_LABELS = { redispute: 'Redispute', next_month: 'Deduct next month', installments: 'Recurring debit' } as const;
export type LossExceptionKind = keyof typeof LOSS_EXCEPTION_LABELS;
export type LossExceptionGrant = {
  month: string; case_key: string; kind: 'next_month' | 'installments'; enabled: boolean;
  version: number; deduction_month: string | null; source_amount: number; source_status: string;
  reason: string; updated_by_name: string; updated_at: string;
};

/** Every selected person's share must support the chosen schedule. Never offer a blanket 24 months. */
export function eligibleInstallmentCounts(amounts: number[], policy?: Partial<RecoveryPolicy>) {
  if (!amounts.length || amounts.some(a => !Number.isFinite(a) || a <= 0)) return [];
  const max = Math.max(2, Math.min(60, Number(policy?.max_installments) || 24));
  return Array.from({length: max - 1}, (_, i) => i + 2).filter(n =>
    amounts.every(a => Math.round(a * 100) >= n * 100 && !installmentThresholdError(a, n, policy)));
}

export function hasStationSubmission(w: { submitted_by?: string | null; response_details?: Record<string, unknown> | null }) {
  return !!w.submitted_by && typeof w.response_details?.reason === 'string' && !!w.response_details.reason.trim();
}
