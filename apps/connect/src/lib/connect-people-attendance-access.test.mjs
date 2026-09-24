import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function fixture() {
  const state = { tables: {}, error: null };
  const db = { from(table) {
    let rows = state.tables[table] ?? [];
    const q = {
      select() { return q; },
      eq(k, v) { rows = rows.filter(r => r[k] === v); return q; },
      is(k, v) { return q.eq(k, v); },
      in(k, vs) { rows = rows.filter(r => vs.includes(r[k])); return q; },
      lte(k, v) { rows = rows.filter(r => r[k] <= v); return q; },
      or() { rows = rows.filter(r => r.effective_to == null || r.effective_to >= '2026-09-25'); return q; },
      order(k, options = {}) { rows = [...rows].sort((a, b) => String(a[k]).localeCompare(String(b[k])) * (options.ascending === false ? -1 : 1)); return q; },
      range(from, to) { rows = rows.slice(from, to + 1); return q; },
      then(resolve, reject) { return Promise.resolve({ data: rows, error: state.error }).then(resolve, reject); }
    };
    return q;
  } };
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(new URL('./connect-people-attendance-access.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name.endsWith('supabase-admin')) return { supabaseAdmin: db };
    if (name.endsWith('india-date')) return { todayInIndia: () => '2026-09-25' };
    return {};
  }, module, module.exports);
  return { state, ...module.exports };
}
const account = { companyId: 'company' };
const scope = { canFinalize: true, allLocations: true, locationIds: [], actorUserIds: ['reviewer'] };
test('company HR scope excludes Workforce, missing and deleted profiles but retains inactive People history', async () => {
  const f = fixture();
  f.state.tables.employees = [
    { id: 'employee', company_id: 'company', deleted_at: null, is_active: false },
    { id: 'deleted', company_id: 'company', deleted_at: '2026-09-01' },
    { id: 'other-company', company_id: 'other', deleted_at: null }
  ];
  f.state.tables.contractors = [{ id: 'contractor', company_id: 'company', deleted_at: null }];
  const access = await f.loadConnectAccessibleWorkforceIds(account, scope);
  assert.equal(access.allowAll, false);
  assert.equal(f.connectWorkforceMatches(access, 'employee', 'employee'), true);
  assert.equal(f.connectWorkforceMatches(access, 'contractor', 'contractor'), true);
  for (const id of ['deleted', 'missing', 'other-company']) assert.equal(f.connectWorkforceMatches(access, 'employee', id), false);
  assert.equal(f.connectWorkforceMatches(access, 'workforce', 'employee'), false);
  assert.equal(f.connectWorkforceMatches({ ...access, allowAll: true }, 'workforce', 'employee'), false);
});
test('station scope follows current primary assignment, not a stale source location', async () => {
  const f = fixture();
  f.state.tables.employees = [{ id: 'e', company_id: 'company', deleted_at: null, location_id: 'old' }];
  f.state.tables.hr_engagements = [{ id: 'eng', company_id: 'company', worker_type: 'employee', employee_id: 'e', status: 'active' }];
  f.state.tables.hr_work_assignments = [
    { effective_from: '2026-09-01', effective_to: null, location_id: 'current' },
    { effective_from: '2026-08-01', effective_to: '2026-08-31', location_id: 'old' },
    { effective_from: '2026-10-01', effective_to: null, location_id: 'future' }
  ].map(row => ({ ...row, company_id: 'company', engagement_id: 'eng', is_primary: true }));
  const load = location => f.loadConnectAccessibleWorkforceIds(account, { ...scope, allLocations: false, locationIds: [location] });
  assert.deepEqual([...(await load('current')).employeeIds], ['e']);
  assert.equal((await load('old')).employeeIds.size, 0);
  assert.equal((await load('future')).employeeIds.size, 0);
});
test('large registers are paginated; errors and absent grants fail closed', async () => {
  const f = fixture();
  f.state.tables.employees = Array.from({ length: 1002 }, (_, i) => ({ id: String(i), company_id: 'company', deleted_at: null }));
  assert.equal((await f.loadConnectAccessibleWorkforceIds(account, scope)).employeeIds.size, 1002);
  assert.equal((await f.loadConnectAccessibleWorkforceIds(account, { ...scope, canFinalize: false })).employeeIds.size, 0);
  f.state.error = { message: 'Unavailable' };
  await assert.rejects(f.loadConnectAccessibleWorkforceIds(account, scope), /Unavailable/);
});
