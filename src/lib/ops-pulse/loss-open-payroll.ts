import type { RecoveryPerson } from "./nl-loss-policy";
export type RecoveryPayrollWindow = {
  employee_ref: string; salary_month: string; payroll_open: boolean;
  payable: number | string | null; paid: number | string; processing: boolean;
};
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
