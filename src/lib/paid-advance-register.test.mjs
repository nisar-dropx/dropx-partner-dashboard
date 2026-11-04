import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('./paid-advance-register.ts', import.meta.url), 'utf8')
  .replace('"./supabase-pagination"', JSON.stringify(new URL('./supabase-pagination.ts', import.meta.url).href));
const { loadPaidAdvanceRegister } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);

function fixture(data, failTable) {
  const reads = [];
  return { reads, db: { from(table) {
    reads.push(table);
    const filters = [];
    const query = {
      select() { return this; }, order() { return this; },
      eq(key, value) { filters.push(r => r[key] === value); return this; },
      in(key, values) { filters.push(r => values.includes(r[key])); return this; },
      result(from = 0, to = Infinity) {
        return table === failTable ? { data: null, error: { message: 'Read failed' } }
          : { data: (data[table] ?? []).filter(r => filters.every(f => f(r))).slice(from, to + 1), error: null };
      },
      range(from, to) { return Promise.resolve(this.result(from, to)); },
      then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
    };
    return query;
  } } };
}
const advance = (id, type, evidence = 'legacy_recorded', company = 'our-company') => ({
  id, company_id: company, worker_type: type, worker_id: `${type}-person`, worker_code: id,
  request_id: null, amount: '2000.00', paid_at: '2026-11-03T00:00:00Z', first_due_period: '2026-10-01', evidence_type: evidence
});

test('includes paid historical and bank advances across categories without reading unpaid requests', async () => {
  const f = fixture({ pay_advances: [advance('manual', 'employee'), advance('bank', 'workforce', 'bank_confirmed'),
    advance('other-company', 'employee', 'bank_confirmed', 'other'), advance('unsupported', 'employee', 'requested')],
    payment_requests: [{ status: 'approved', amount: 9000 }],
    employees: [{ id: 'employee-person', company_id: 'our-company', full_name: 'Employee', location_id: 's' }],
    workforce: [{ id: 'workforce-person', company_id: 'our-company', full_name: 'Workforce', location_id: 's' }],
    stations: [{ id: 's', company_id: 'our-company', station_code: 'KOZA' }] });
  const rows = await loadPaidAdvanceRegister(f.db, 'our-company');
  assert.deepEqual(rows.map(r => [r.id, r.name, r.station, r.amount]), [
    ['manual', 'Employee', 'KOZA', 2000], ['bank', 'Workforce', 'KOZA', 2000]]);
  assert.equal(f.reads.includes('payment_requests'), false);
});

test('reads every paid record beyond the API page size, retaining separate equal-value payments', async () => {
  const f = fixture({ pay_advances: Array.from({length: 1101}, (_, i) => advance(`a${i}`, 'contractor')) });
  const rows = await loadPaidAdvanceRegister(f.db, 'our-company');
  assert.equal(rows.length, 1101);
  assert.equal(new Set(rows.map(r => r.id)).size, 1101);
  assert.equal(rows.reduce((sum, r) => sum + r.amount, 0), 2202000);
});

test('fails visibly instead of showing an incomplete paid register after a database error', async () => {
  const f = fixture({ pay_advances: [advance('paid', 'employee')] }, 'employees');
  await assert.rejects(loadPaidAdvanceRegister(f.db, 'our-company'), /Read failed/);
});
