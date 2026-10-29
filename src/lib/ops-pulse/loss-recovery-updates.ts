import { hasFinalLossOutcome } from './loss-recovery-controls';
import { isRecoverable, type NlCase } from './nl-loss-policy';
import { recoveryQueueState } from './loss-recovery-queue-policy';
import type { LedgerLine } from './nl-recovery-ledger-view';

const cents = (value: number) => Math.round(Number(value || 0) * 100);
const caseKey = (row: { month: string; case_key: string }) => `${row.month}|${row.case_key}`;

/** Saved final-case updates exist before a payroll run. Never infer collections from assignments. */
export function recoveryUpdates(rows: NlCase[], lines: LedgerLine[], accepted: string[], period: string) {
  const byCase = new Map<string, LedgerLine[]>();
  const seenLines = new Set<string>();
  for (const line of lines) {
    const key = caseKey(line), identity = `${key}|${line.employee_ref}`;
    if (seenLines.has(identity)) continue;
    seenLines.add(identity);
    byCase.set(key, [...(byCase.get(key) || []), line]);
  }
  const seen = new Set<string>();
  return rows.flatMap(row => {
    const plan = row.recovery, key = caseKey(row);
    if (!plan || plan.is_deleted || seen.has(key)) return [];
    const final = row.report === 'station' ? row.source_status === 'Approved'
      : row.report === 'slp' ? Boolean((row as NlCase & { final_seen_at?: string }).final_seen_at || row.details.in_final)
      : hasFinalLossOutcome(isRecoverable(row.source_status, accepted), row.source_status, row.details.case_status, row.details.extra?.current_sla_stage);
    // Missing source data must retain a saved balance for review; ongoing source cases stay in Disputes.
    if (!final && row.source_present !== false) return [];
    seen.add(key);
    const ledger = byCase.get(key) || [];
    const state = recoveryQueueState(row, ledger, period);
    const receipt = state.verifiedReceipt ? cents(Number(plan.recovery_details?.received_amount || 0)) : 0;
    const collected = Math.max(cents(state.deducted), receipt) / 100;
    return [{
      key, month: row.month, station: row.station_code, report: row.report || 'nl',
      tid: row.details.tid || row.case_key.replace(/^slp:/, ''), caseKey: row.case_key,
      amount: cents(row.amount) / 100, collected, outstanding: state.outstanding,
      deducted: state.deducted, waived: state.waived,
      draft: ledger.reduce((sum, line) => sum + cents(line.in_payroll), 0) / 100,
      assigned: (plan.allocations || []).reduce((sum, line) => sum + cents(line.amount), 0) / 100,
      people: (plan.allocations || []).map(person => ({ ref: person.ref, name: person.full_name, code: person.employee_code, designation: person.designation,
        amount: cents(person.amount) / 100,
        salaryMonth: person.salary_month || plan.deduction_month || ledger.find(line => line.employee_ref === person.ref)?.first_salary_month || null,
      })),
      recurring: plan.recovery_mode === 'installments',
      status: state.status, payrollMonth: state.nextDue, outcome: plan.outcome_label,
      updatedAt: plan.updated_at || '', updatedBy: plan.updated_by_name || '',
    }];
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
}
export type RecoveryUpdate = ReturnType<typeof recoveryUpdates>[number];

export function filterRecoveryUpdates(rows: RecoveryUpdate[], filter: { station?: string; month?: string; status?: string; query?: string; salaryScope?: string; currentMonth?: string }) {
  const query = (filter.query || '').trim().toLowerCase();
  return rows.filter(row => (!filter.station || row.station === filter.station) && (!filter.month || row.month === filter.month)
    && (!filter.status || row.status === filter.status)
    && (filter.salaryScope !== 'earlier' || row.people.some(person => person.salaryMonth && filter.currentMonth && person.salaryMonth < filter.currentMonth))
    && [row.tid, row.caseKey, row.station, ...row.people.flatMap(person => [person.name, person.code, person.designation])].join(' ').toLowerCase().includes(query));
}
export function totalRecoveryUpdates(rows: RecoveryUpdate[]) {
  const sum = (field: 'amount' | 'assigned' | 'collected' | 'outstanding' | 'draft' | 'waived') => rows.reduce((value, row) => value + cents(row[field]), 0) / 100;
  return { count: rows.length, amount: sum('amount'), assigned: sum('assigned'), collected: sum('collected'), outstanding: sum('outstanding'),
    draft: sum('draft'), waived: sum('waived'), people: new Set(rows.flatMap(row => row.people.map(person => person.ref))).size,
    review: rows.filter(row => ['approval', 'review', 'returned'].includes(row.status)).length,
    updatedAt: rows.map(row => row.updatedAt).sort().at(-1) || '' };
}

/** Export assignments, never label a saved plan as a completed payroll debit. */
export function recoveryUpdateExportRows(rows: RecoveryUpdate[]) {
  return [
    ['Station', 'Employee ID', 'Name', 'Designation', 'Shipment ID', 'Loss month', 'Salary month (planned start)', 'Assigned amount', 'Schedule', 'Recovery status', 'Updated by', 'Updated at'],
    ...rows.flatMap(row => row.people.map(person => [row.station, person.code, person.name, person.designation || '', row.tid, row.month, person.salaryMonth || 'Not recorded', person.amount, row.recurring ? 'Recurring' : 'Full debit', row.status, row.updatedBy, row.updatedAt])),
  ];
}
