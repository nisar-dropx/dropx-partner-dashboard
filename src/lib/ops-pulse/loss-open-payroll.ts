import type { RecoveryPerson } from "./nl-loss-policy";
export type RecoveryPayrollWindow = {
  employee_ref: string; salary_month: string; payroll_open: boolean;
  payable: number | string | null; paid: number | string; processing: boolean;
};

/**
 * People payroll can remain in review while its unpaid bank balance is already
 * authoritative. Keep the stricter calculated amount when it is available,
 * but do not erase an open unpaid balance merely because the calculation row
 * has not moved from review to ready yet.
 */
export function peopleRecoveryPayableForWindow(
  calculatedPayable: number | null,
  window?: RecoveryPayrollWindow,
) {
  if (!window) return calculatedPayable;
  if (!window.payroll_open || window.processing) return 0;
  const windowPayable = window.payable == null ? null : Number(window.payable);
  const calculated = calculatedPayable == null ? null : Number(calculatedPayable);
  const openBalance = windowPayable != null && Number.isFinite(windowPayable)
    ? Math.max(0, windowPayable)
    : null;
  const verifiedCalculation = calculated != null && Number.isFinite(calculated)
    ? Math.max(0, calculated)
    : null;
  if (openBalance == null) return verifiedCalculation;
  if (verifiedCalculation == null) return openBalance;
  return Math.min(verifiedCalculation, openBalance);
}

export function availablePayrollMonths(windows: RecoveryPayrollWindow[], ref: string) {
  return [...new Set(windows.filter(w => w.employee_ref === ref && w.payroll_open &&
    (w.payable == null || Number(w.payable) > 0)).map(w => w.salary_month))].sort().reverse();
}
export function recoveryDirectoryWithPayroll(people: RecoveryPerson[], windows: RecoveryPayrollWindow[]) {
  return people.map(p => ({ ...p, open_payroll_months: availablePayrollMonths(windows,p.ref) }))
    .filter(p => p.is_active || p.open_payroll_months.length > 0);
}
export function commonOpenPayrollMonths(people: RecoveryPerson[], refs: string[]) {
  if (!refs.length) return [];
  const selected = refs.map(ref => people.find(p => p.ref === ref));
  if (selected.some(p => !p)) return [];
  return (selected[0]?.open_payroll_months || []).filter(m => selected.every(p => p?.open_payroll_months?.includes(m))).sort().reverse();
}
