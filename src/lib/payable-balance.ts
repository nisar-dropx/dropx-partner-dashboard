export const PAYABLE_BALANCE_SOURCES = [
  "people_payroll",
  "workforce",
  "helpers"
] as const;

export type PayableBalanceSource = (typeof PAYABLE_BALANCE_SOURCES)[number];

export const PAYABLE_BALANCE_SOURCE_LABELS: Record<PayableBalanceSource, string> = {
  people_payroll: "People Payroll",
  workforce: "Workforce payouts",
  helpers: "Helpers"
};

export type PayableBalanceTarget = {
  source: PayableBalanceSource;
  month: string;
  identity: string;
  targetAmount: number;
};

export type PayableBalancePayment = {
  source: PayableBalanceSource;
  month: string;
  identity: string;
  paidAmount: number;
};

export type PayableBalanceGrain = {
  source: PayableBalanceSource;
  month: string;
  identity: string;
  grandTotal: number;
  actualPaidAmount: number;
  paidAmount: number;
  payableBalance: number;
  overpaidAmount: number;
};

export type PayableBalanceSummary = {
  grandTotal: number;
  actualPaidAmount: number;
  paidAmount: number;
  payableBalance: number;
  overpaidAmount: number;
  recordCount: number;
};

export type PayrollSalaryHoldItem = {
  code?: string | null;
  item_type?: string | null;
  amount?: number | string | null;
};

export type PayrollPayablePerson = {
  net_pay?: number | string | null;
  adjusted_net_pay?: number | string | null;
  hr_payroll_run_items?: PayrollSalaryHoldItem[] | null;
};

export function roundPayableMoney(value: number) {
  return Math.round(((Number.isFinite(value) ? value : 0) + Number.EPSILON) * 100) / 100;
}

function nonNegativeMoney(value: number) {
  return Math.max(0, roundPayableMoney(value));
}

function grainKey(row: Pick<PayableBalanceTarget, "source" | "month" | "identity">) {
  return `${row.source}|${row.month}|${row.identity.trim().toLowerCase()}`;
}

/**
 * Reconciles every source at its natural person/location grain. Targets can be
 * repeated by a live worksheet, so the highest current target wins. Settled
 * bank rows are additive. Paid shown in the summary is capped at the current
 * target so an overpayment can never hide somebody else's payable balance.
 */
export function reconcilePayableBalance(
  targets: readonly PayableBalanceTarget[],
  payments: readonly PayableBalancePayment[]
) {
  const targetByKey = new Map<string, PayableBalanceTarget>();
  const paidByKey = new Map<string, PayableBalancePayment>();

  for (const target of targets) {
    const key = grainKey(target);
    const amount = nonNegativeMoney(Number(target.targetAmount));
    const existing = targetByKey.get(key);
    if (!existing || amount > existing.targetAmount) {
      targetByKey.set(key, { ...target, identity: target.identity.trim().toLowerCase(), targetAmount: amount });
    }
  }

  for (const payment of payments) {
    const key = grainKey(payment);
    const amount = nonNegativeMoney(Number(payment.paidAmount));
    const existing = paidByKey.get(key);
    paidByKey.set(key, {
      ...payment,
      identity: payment.identity.trim().toLowerCase(),
      paidAmount: roundPayableMoney((existing?.paidAmount ?? 0) + amount)
    });
  }

  const keys = new Set([...targetByKey.keys(), ...paidByKey.keys()]);
  return [...keys].map((key): PayableBalanceGrain => {
    const target = targetByKey.get(key);
    const payment = paidByKey.get(key);
    // A historical paid row can outlive a live profile/worksheet. Preserve it
    // as a fully paid grain instead of dropping settled cash from the report.
    const grandTotal = nonNegativeMoney(target?.targetAmount ?? payment?.paidAmount ?? 0);
    const actualPaidAmount = nonNegativeMoney(payment?.paidAmount ?? 0);
    const paidAmount = Math.min(grandTotal, actualPaidAmount);
    return {
      source: (target?.source ?? payment!.source),
      month: target?.month ?? payment!.month,
      identity: target?.identity ?? payment!.identity,
      grandTotal,
      actualPaidAmount,
      paidAmount: roundPayableMoney(paidAmount),
      payableBalance: nonNegativeMoney(grandTotal - paidAmount),
      overpaidAmount: nonNegativeMoney(actualPaidAmount - grandTotal)
    };
  }).sort((left, right) => right.month.localeCompare(left.month)
    || PAYABLE_BALANCE_SOURCES.indexOf(left.source) - PAYABLE_BALANCE_SOURCES.indexOf(right.source)
    || left.identity.localeCompare(right.identity));
}

export function summarizePayableBalance(
  grains: readonly PayableBalanceGrain[],
  { pendingOnly = false }: { pendingOnly?: boolean } = {}
): PayableBalanceSummary {
  // Known zero targets are retained during reconciliation so a settlement
  // against them is classified correctly, but empty zero/zero rows should not
  // inflate the record count shown to users.
  const visible = grains.filter((grain) => grain.grandTotal > 0 || grain.actualPaidAmount > 0);
  const included = pendingOnly ? visible.filter((grain) => grain.payableBalance > 0) : visible;
  return included.reduce<PayableBalanceSummary>((summary, grain) => ({
    grandTotal: roundPayableMoney(summary.grandTotal + grain.grandTotal),
    actualPaidAmount: roundPayableMoney(summary.actualPaidAmount + grain.actualPaidAmount),
    paidAmount: roundPayableMoney(summary.paidAmount + grain.paidAmount),
    payableBalance: roundPayableMoney(summary.payableBalance + grain.payableBalance),
    overpaidAmount: roundPayableMoney(summary.overpaidAmount + grain.overpaidAmount),
    recordCount: summary.recordCount + 1
  }), { grandTotal: 0, actualPaidAmount: 0, paidAmount: 0, payableBalance: 0, overpaidAmount: 0, recordCount: 0 });
}

export function summarizePayableBalanceBySource(
  grains: readonly PayableBalanceGrain[],
  options: { pendingOnly?: boolean } = {}
) {
  return PAYABLE_BALANCE_SOURCES.map((source) => ({
    source,
    ...summarizePayableBalance(grains.filter((grain) => grain.source === source), options)
  }));
}

export function summarizePayableBalanceByMonthAndSource(
  grains: readonly PayableBalanceGrain[],
  options: { pendingOnly?: boolean } = {}
) {
  const months = [...new Set(grains.map((grain) => grain.month))].sort((left, right) => right.localeCompare(left));
  return months.flatMap((month) => PAYABLE_BALANCE_SOURCES.map((source) => ({
    month,
    source,
    ...summarizePayableBalance(
      grains.filter((grain) => grain.month === month && grain.source === source),
      options
    )
  }))).filter((summary) => !options.pendingOnly || summary.payableBalance > 0);
}

/** Mirrors People Payroll's finalPayableAmount, including legacy holds. */
export function peoplePayrollFinalPayable(person: PayrollPayablePerson) {
  const items = Array.isArray(person.hr_payroll_run_items) ? person.hr_payroll_run_items : [];
  const holdItems = items.filter((item) => String(item.code ?? "").trim().toUpperCase() === "SALARY_HOLD");
  const holdAmount = roundPayableMoney(holdItems.reduce((sum, item) => sum + Number(item.amount ?? 0), 0));
  const salaryHoldAlreadyInNet = holdItems.some((item) =>
    String(item.item_type ?? "").trim().toLowerCase() === "deduction" && Number(item.amount ?? 0) > 0
  );
  const hasAdjustment = person.adjusted_net_pay != null;
  const storedNet = roundPayableMoney(Number(hasAdjustment ? person.adjusted_net_pay : person.net_pay) || 0);
  if (salaryHoldAlreadyInNet && hasAdjustment) return nonNegativeMoney(storedNet);
  const earnedNet = hasAdjustment || !salaryHoldAlreadyInNet
    ? storedNet
    : roundPayableMoney(storedNet + holdAmount);
  return nonNegativeMoney(earnedNet - holdAmount);
}

export function payableBalanceMonthRange(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const start = `${month}-01`;
  const endDate = new Date(`${start}T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  endDate.setUTCDate(0);
  return { start, end: endDate.toISOString().slice(0, 10) };
}

export function payableBalanceMonthLabel(month: string) {
  const range = payableBalanceMonthRange(month);
  if (!range) return month;
  return new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata"
  }).format(new Date(`${range.start}T00:00:00+05:30`));
}

export function payableBalanceMonthSequence(firstMonth: string, lastMonth: string) {
  const first = payableBalanceMonthRange(firstMonth);
  const last = payableBalanceMonthRange(lastMonth);
  if (!first || !last || firstMonth > lastMonth) return [];
  const cursor = new Date(`${first.start}T00:00:00Z`);
  const months: string[] = [];
  while (cursor.toISOString().slice(0, 7) <= lastMonth) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
