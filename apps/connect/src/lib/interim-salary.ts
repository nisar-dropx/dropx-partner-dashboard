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
  calculation_snapshot?: { payable_fractions?: SalaryFraction[] | null } | null;
};
export type SalaryFraction = { date?: string; fraction?: Money; kind?: string };
export type LeaveCover = { start: string; end: string; code: string; name: string };
export type SalaryRun = { id: string; label: string; period_start: string; period_end: string; calculation_from: string | null; calculation_through: string | null; calculated_at: string | null; status: string };
export type SalaryPayment = { id: string; run_id: string; amount: Money; status: string; value_date: string; reference: string; utr: string | null; attempt: number };
export type SalaryDocument = { id: string; run_id: string; published_at: string };
const money = (value: Money) => Math.round((Number(value) || 0) * 100) / 100;

const roundDays = (value: number) => Math.round(value * 100) / 100;

/** Paid-leave total on payroll is WFH + business trip + CL + SL + public holiday. Split those for display. */
export function paidDayBreakdown(fractions: SalaryFraction[] | null | undefined, leaves: LeaveCover[]) {
  if (!Array.isArray(fractions)) return null;
  let wfh = 0, trip = 0, casual = 0, sick = 0, holiday = 0;
  const other = new Map<string, number>();
  for (const row of fractions) {
    const days = Number(row.fraction) || 0;
    if (days <= 0) continue;
    const date = String(row.date ?? "");
    if (row.kind === "wfh") wfh += days;
    else if (row.kind === "payable_work_mode") trip += days;
    else if (row.kind === "paid_holiday") holiday += days;
    else if (row.kind === "paid_leave") {
      const leave = leaves.find(item => item.start <= date && item.end >= date);
      const code = (leave?.code ?? "").toUpperCase();
      const name = (leave?.name ?? "").toLowerCase();
      if (code === "SL" || code === "SICK" || name.includes("sick")) sick += days;
      else if (code === "CL" || code === "CASUAL" || name.includes("casual")) casual += days;
      else if (code === "PUBLIC" || name.includes("public holiday")) holiday += days;
      else {
        const label = leave?.name?.trim() || "Paid leave";
        other.set(label, (other.get(label) ?? 0) + days);
      }
    }
  }
  return [
    ["Work from home", wfh], ["Business trip", trip], ["Casual leave", casual], ["Sick leave", sick], ["Public holiday", holiday],
    ...other
  ].map(([label, days]) => ({ label: String(label), days: roundDays(Number(days)) }));
}

export function buildInterimSalary(run: SalaryRun, person: SalaryPerson | null, payments: SalaryPayment[], document: SalaryDocument | null, leaves: LeaveCover[] = []) {
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
    attendance: person ? attendanceDays(person, leaves) : null,
    history: history.filter(row => row.status === "paid").map(row => ({ id: row.id, amount: money(row.amount), status: row.status, date: row.value_date, reference: row.reference, utr: row.utr }))
  };
}

function attendanceDays(person: SalaryPerson, leaves: LeaveCover[]) {
  const leave = money(person.paid_leave_days);
  const breakdown = paidDayBreakdown(person.calculation_snapshot?.payable_fractions, leaves);
  let paidDays = breakdown;
  if (paidDays) {
    const remainder = money(leave - paidDays.reduce((sum, row) => sum + row.days, 0));
    if (remainder > 0) {
      const matched = paidDays.find(row => row.label === "Paid leave");
      paidDays = matched
        ? paidDays.map(row => row === matched ? { ...row, days: money(row.days + remainder) } : row)
        : [...paidDays, { label: "Other paid leave", days: remainder }];
    }
    if (leave <= 0 && paidDays.every(row => row.days <= 0)) paidDays = null;
  }
  return {
    payable: money(person.payable_days), expected: money(person.expected_days), present: money(person.present_days),
    half: money(person.half_days), absent: money(person.absence_days), leave,
    weekoff: money(person.weekoff_days), missingPunches: money(person.missing_punch_days),
    paidDays
  };
}

export type InterimSalary = ReturnType<typeof buildInterimSalary>;
