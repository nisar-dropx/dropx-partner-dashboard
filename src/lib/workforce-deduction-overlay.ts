import {
  calculateAutomaticDeductionLines,
  type AutomaticDeductionHead,
  type AutomaticDeductionLine,
  type DeductionWorkerContext
} from "./workforce-deductions.ts";

export type WorkforcePayoutDeductionValue = {
  id: string;
  deduction_head_id: string;
  workforce_id: string;
  station_id?: string | null;
  head_code_snapshot: string;
  head_name_snapshot: string;
  amount: number | string;
};

export type WorkforcePayoutDeductionOptions = {
  includeAutomaticDeductions?: boolean;
};

function rounded(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Combines automatic fixed/percentage deductions with exact-period manual
 * deductions uploaded for one Workforce payout row. A stored row owns that
 * head for the period even if its live definition is later made automatic, so
 * the live automatic version is excluded instead of charging the head twice.
 */
export function workforcePayoutDeductionLines(
  grossPayment: number,
  heads: AutomaticDeductionHead[],
  worker: DeductionWorkerContext,
  uploadedValues: WorkforcePayoutDeductionValue[] = [],
  options: WorkforcePayoutDeductionOptions = {}
): AutomaticDeductionLine[] {
  const uploadedHeadIds = new Set(uploadedValues.map((value) => String(value.deduction_head_id)).filter(Boolean));
  const automaticHeads = heads.filter((head) => !head.id || !uploadedHeadIds.has(String(head.id)));
  const automatic = options.includeAutomaticDeductions === false
    ? []
    : calculateAutomaticDeductionLines(grossPayment, automaticHeads, worker);
  const headById = new Map(heads.flatMap((head) => head.id ? [[head.id, head] as const] : []));
  const manual = uploadedValues.map((value) => {
    const head = headById.get(value.deduction_head_id);
    return {
      code: String(value.head_code_snapshot || head?.code || "DEDUCTION"),
      label: String(value.head_name_snapshot || head?.name || value.head_code_snapshot || "Deduction"),
      amount: rounded(Math.max(0, Number(value.amount) || 0))
    } satisfies AutomaticDeductionLine;
  });
  return [...automatic, ...manual];
}

export function workforcePayoutDeductionTotal(lines: AutomaticDeductionLine[]) {
  return rounded(lines.reduce((sum, line) => sum + Number(line.amount || 0), 0));
}
