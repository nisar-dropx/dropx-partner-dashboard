/** Read-only People payroll presentation. Bank-file issue is never proof of payment. */
export function canViewInterimSalary(account: { profileType: string; workspace?: string; activationOnly?: boolean }) {
  return !account.activationOnly && account.workspace === "people" && ["employee", "contractor"].includes(account.profileType);
}

type Money = number | string | null;
export type SalaryItem = { code: string; name: string; item_type: string; amount: Money; display_order: number };
export type SalaryPerson = {
  id: string; run_id: string; gross_pay: Money; other_earnings: Money; net_pay: Money; adjusted_net_pay: Money;
  payable_days: Money; expected_days: Money; present_days: Money; half_days: Money; absence_days: Money;
  paid_leave_days: Money; weekoff_days: Money; missing_punch_days: Money;
  hr_payroll_run_items: SalaryItem[];
};
export type SalaryRun = { id: string; label: string; period_start: string; period_end: string; calculation_from: string | null; calculation_through: string | null; calculated_at: string | null; status: string };
export type SalaryPayment = { id: string; run_id: string; amount: Money; status: string; value_date: string; reference: string; utr: string | null; attempt: number };
export type SalaryDocument = { id: string; run_id: string; published_at: string };
const money = (value: Money) => Math.round((Number(value) || 0) * 100) / 100;

export function buildInterimSalary(run: SalaryRun, person: SalaryPerson | null, payments: SalaryPayment[], document: SalaryDocument | null) {
  const history = payments.filter(row => row.run_id === run.id).sort((a, b) => a.attempt - b.attempt || a.reference.localeCompare(b.reference));
  const paid = money(history.filter(row => row.status === "paid").reduce((sum, row) => sum + money(row.amount), 0));
  const awaitingConfirmation = money(history.filter(row => row.status === "issued").reduce((sum, row) => sum + money(row.amount), 0));
  const items = [...(person?.hr_payroll_run_items ?? [])].sort((a, b) => a.display_order - b.display_order);
  const hold = money(items.filter(row => row.code.toUpperCase() === "SALARY_HOLD").reduce((sum, row) => sum + money(row.amount), 0));
  // Match People payroll's earnedNet/finalPayableAmount, including legacy holds stored as deductions.
  const legacyHold = items.some(row => row.code.toUpperCase() === "SALARY_HOLD" && row.item_type === "deduction" && money(row.amount) > 0);
  const net = person ? money(money(person.adjusted_net_pay ?? person.net_pay) + (person.adjusted_net_pay == null && legacyHold ? hold : 0)) : null;
  const payable = net == null ? null : Math.max(0, money(legacyHold && person?.adjusted_net_pay != null ? person.adjusted_net_pay : net - hold));
  const earnings = items.filter(row => row.item_type === "earning" && money(row.amount) !== 0).map(row => ({ name: row.name, amount: money(row.amount) }));
  const deductions = items.filter(row => row.item_type === "deduction" && row.code.toUpperCase() !== "SALARY_HOLD" && money(row.amount) !== 0).map(row => ({ name: row.name, amount: money(row.amount) }));
  const totalEarnings = person ? money(money(person.gross_pay) + money(person.other_earnings)) : null;
  const deductionTotal = money(deductions.reduce((sum, row) => sum + row.amount, 0));
  // Explicitly reconcile manual net changes/legacy snapshots instead of inventing a deduction label.
  const reconciliation = net == null || totalEarnings == null ? 0 : money(net - (totalEarnings - deductionTotal));
  return {
    id: run.id, label: run.label, periodStart: run.period_start, periodEnd: run.period_end,
    calculatedFrom: run.calculation_from ?? run.period_start, calculatedThrough: run.calculation_through ?? run.period_end,
    calculatedAt: run.calculated_at, provisional: !document, documentId: document?.id ?? null,
    net, payable, hold, totalEarnings, deductionTotal, reconciliation, earnings, deductions,
    paid, awaitingConfirmation,
    // A provisional difference is not a promised second payment or a payroll debt.
    unconfirmedBalance: payable == null ? null : money(Math.max(0, payable - paid)),
    exceedsCurrentCalculation: payable != null && paid > payable,
    attendance: person ? {
      payable: money(person.payable_days), expected: money(person.expected_days), present: money(person.present_days),
      half: money(person.half_days), absent: money(person.absence_days), leave: money(person.paid_leave_days),
      weekoff: money(person.weekoff_days), missingPunches: money(person.missing_punch_days)
    } : null,
    history: history.map(row => ({ id: row.id, amount: money(row.amount), status: row.status, date: row.value_date, reference: row.reference, utr: row.utr }))
  };
}

export type InterimSalary = ReturnType<typeof buildInterimSalary>;
