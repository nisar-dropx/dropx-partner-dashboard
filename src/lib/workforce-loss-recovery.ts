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
  /** Legacy audit metadata; all recoveries use available pay. */
  cap_exempt?: boolean | null;
  /** Legacy API field; percentage limits no longer affect payroll. */
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

/**
 * Adds each worker's due lines to that worker's largest payout row, whole lines only and only while
 * they fit in available pay, oldest salary month first. Unpaid lines carry forward. Mutates the rows in place.
 */
export function applyWorkforceLossRecoveries<Row extends LossRecoveryRow>(rows: Row[], lines: WorkforceLossRecoveryLine[], payments: {worker_id:string;paid:number;processing:boolean}[] = []) {
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
    const payment=payments.find(p=>p.worker_id===workerId);
    let unpaid=payment?.processing ? 0 : Math.max(0,rounded(rows.filter(r=>String(r.reviewSubjectId??"")===workerId).reduce((sum,r)=>sum+r.netAmount,0)-(payment?.paid||0)));
    const ordered = [...workerLines].sort((a, b) =>
      String(a.deduction_month ?? "").localeCompare(String(b.deduction_month ?? "")) || a.recovery_key.localeCompare(b.recovery_key));
    if (!target) { carried.push(...ordered); continue; }
    for (const line of ordered) {
      const amount = rounded(Number(line.amount) || 0);
      if (amount <= 0) continue;
      if (appliedKeys.has(line.recovery_key)) continue;
      if (amount > rounded(target.netAmount) || amount > unpaid) { carried.push(line); continue; }
      target.deductionBreakdown = [...target.deductionBreakdown, { code: LOSS_RECOVERY_CODE, label: `Loss recovery · ${line.label}`, amount, recoveryKey: line.recovery_key }];
      appliedKeys.add(line.recovery_key);
      target.deductions = rounded(target.deductions + amount);
      target.netAmount = rounded(target.netAmount - amount);
      unpaid=rounded(unpaid-amount);
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

/** Presentation only: keep every recoveryKey in the underlying payroll snapshot. */
export function groupWorkforceDeductionDisplay<T extends { code: string; label: string; amount: number; recoveryKey?: string }>(items: T[]) {
  const losses = items.filter(item => item.code === LOSS_RECOVERY_CODE && item.amount !== 0);
  return {
    other: items.filter(item => item.code !== LOSS_RECOVERY_CODE && item.amount !== 0),
    losses,
    lossTotal: rounded(losses.reduce((total, item) => total + item.amount, 0)),
  };
}
