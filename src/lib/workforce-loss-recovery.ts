/**
 * Ops loss recoveries (Team Ops → Losses) deducted from the monthly Workforce payout.
 * The database decides which plan lines are due for a salary month (nl_loss_recovery_due):
 * settled before the payroll cutoff day → the previous month, an NL loss never before the month
 * after it, SLP only after its Final file, and never a line another period's latest publication
 * already carries. A line the payout cannot carry stays due and moves to the next month.
 */

export const LOSS_RECOVERY_CODE = "LOSS_RECOVERY";

export type WorkforceLossRecoveryLine = {
  recovery_key: string;
  month: string;
  case_key: string;
  report: string;
  worker_id: string;
  employee_code: string | null;
  amount: number | string;
  deduction_month: string | null;
  label: string;
  installment_no?: number | null;
  installment_count?: number | null;
  /** A recorded cap override or an exit's final settlement: may use the whole net payout. */
  cap_exempt?: boolean | null;
  /** Share of the net payout all capped loss recoveries of one month may take (Loss Recovery Master). */
  cap_percent?: number | string | null;
  final_settlement?: boolean | null;
};

type LossRecoveryRow = {
  reviewSubjectType?: string;
  reviewSubjectId?: string | null;
  grossPayment: number;
  deductions: number;
  netAmount: number;
  deductionBreakdown: Array<{ code: string; label: string; amount: number; recoveryKey?: string }>;
};

function rounded(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Only a whole calendar month carries salary deductions; daily and custom-range views never do. */
export function workforceLossRecoveryMonth(fromDate: string, toDate: string) {
  const match = /^(\d{4})-(\d{2})-01$/.exec(fromDate);
  if (!match) return null;
  const last = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10);
  return toDate === last ? `${match[1]}-${match[2]}` : null;
}

function capShare(lines: WorkforceLossRecoveryLine[]) {
  const value = Number(lines.find((line) => line.cap_percent != null)?.cap_percent);
  return Number.isFinite(value) && value > 0 ? Math.min(100, value) : 100;
}

/**
 * Adds each worker's due lines to that worker's largest payout row, whole lines only and only while
 * they fit, oldest salary month first. Capped lines together take at most cap_percent of the net
 * amount; a cap override or a final settlement may use the rest. Mutates the rows in place.
 */
export function applyWorkforceLossRecoveries<Row extends LossRecoveryRow>(rows: Row[], lines: WorkforceLossRecoveryLine[]) {
  const byWorker = new Map<string, WorkforceLossRecoveryLine[]>();
  for (const line of lines) {
    if (!line.worker_id) continue;
    const list = byWorker.get(line.worker_id);
    if (list) list.push(line); else byWorker.set(line.worker_id, [line]);
  }
  const carried: WorkforceLossRecoveryLine[] = [];
  // A worker can have several station/provider rows. Recalculation must find keys on all of them.
  const appliedKeys = new Set(rows.flatMap(row => row.deductionBreakdown.flatMap(item => item.recoveryKey ? [item.recoveryKey] : [])));
  for (const [workerId, workerLines] of byWorker) {
    const target = rows
      .filter((row) => (row.reviewSubjectType ?? "workforce") === "workforce" && String(row.reviewSubjectId ?? "") === workerId)
      .sort((a, b) => b.netAmount - a.netAmount)[0];
    const ordered = [...workerLines].sort((a, b) =>
      String(a.deduction_month ?? "").localeCompare(String(b.deduction_month ?? "")) || a.recovery_key.localeCompare(b.recovery_key));
    if (!target) { carried.push(...ordered); continue; }
    let capLeft = rounded(Math.max(0, target.netAmount) * capShare(workerLines) / 100);
    for (const line of ordered) {
      const amount = rounded(Number(line.amount) || 0);
      if (amount <= 0) continue;
      if (appliedKeys.has(line.recovery_key)) continue;
      if (amount > rounded(target.netAmount) || (!line.cap_exempt && amount > capLeft)) { carried.push(line); continue; }
      if (!line.cap_exempt) capLeft = rounded(capLeft - amount);
      target.deductionBreakdown = [...target.deductionBreakdown, { code: LOSS_RECOVERY_CODE, label: `Loss recovery · ${line.label}`, amount, recoveryKey: line.recovery_key }];
      appliedKeys.add(line.recovery_key);
      target.deductions = rounded(target.deductions + amount);
      target.netAmount = rounded(target.netAmount - amount);
    }
  }
  return { carried };
}

/** True when the shared database does not have the loss recovery function yet, so payouts still load. */
export function isMissingLossRecoveryFunction(error: { code?: string | null; message?: string | null } | null | undefined) {
  if (!error) return false;
  const message = String(error.message ?? "");
  return error.code === "PGRST202" || error.code === "42883" || (/nl_loss_recovery_due/.test(message) && /not find|does not exist/i.test(message));
}
