import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as salary from './interim-salary.ts';
import { peopleDocumentsAvailable } from './dropx-one-pages.ts';
import { visibleDashboardNotices } from './dashboard-notices.ts';

const account = { id: 'worker', companyId: 'company', profileType: 'employee', workspace: 'people', pageAccess: [] };
const run = { id: 'run', label: 'Period', period_start: '2026-09-01', period_end: '2026-09-30', status: 'calculated' };
const item = (code, amount, item_type = 'deduction') => ({ code, name: code, amount, item_type, display_order: 1 });
const person = { id: 'person', run_id: 'run', gross_pay: 20000, other_earnings: 0, net_pay: 18000, adjusted_net_pay: null, payable_days: 26, hr_payroll_run_items: [item('BASIC', 20000, 'earning'), item('PF', 2000), item('EMPLOYER_PF', 2000, 'employer_contribution')] };
const payment = (status, amount, overrides = {}) => ({ id: status, run_id: 'run', amount, status, attempt: 1, reference: status, value_date: '2026-10-09', ...overrides });
test('Salary Calculation is the desktop/mobile label while the interim warning remains', () => {
  const flow = fs.readFileSync(new URL('../components/connect-login-flow.tsx', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../components/connect-interim-salary.tsx', import.meta.url), 'utf8');
  assert.match(flow, /salary: "Salary Calculation"/);
  assert.match(flow, /<IndianRupee \/>Salary Calculation<\/button>/);
  assert.match(flow, /<span \/>Salary Calculation<ChevronRight \/>/);
  assert.match(page, /<h1>Salary Calculation<\/h1>/);
  assert.match(page, /This is not your final salary/);
  assert.match(page, /This is only an interim view/);
  assert.match(page, /Paid leave/);
  assert.match(page, /View split/);
  assert.match(page, /id="paid-leave-split"/);
  assert.doesNotMatch(page, /each counted on its own/);
  assert.doesNotMatch(flow + page, /Interim salary|interim salary/);
});
function load(file, mocks) {
  const mod = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', js)(id => { assert.ok(id in mocks, `Unmocked ${id}`); return mocks[id]; }, mod, mod.exports);
  return mod.exports;
}
test('salary and Documents apply to People employees and ICs, never Workforce or activation-only', () => {
  for (const profileType of ['employee', 'contractor']) {
    assert.equal(salary.canViewInterimSalary({ ...account, profileType }), true);
    assert.equal(peopleDocumentsAvailable({ ...account, profileType }), true);
  }
  for (const overrides of [{ workspace: 'workforce' }, { profileType: 'workforce' }, { profileType: 'user' }, { activationOnly: true }, { workspace: undefined }]) {
    assert.equal(salary.canViewInterimSalary({ ...account, ...overrides }), false);
    assert.equal(peopleDocumentsAvailable({ ...account, ...overrides }), false);
  }
});
test('issued is not paid; failures and returns never inflate paid amounts; instalments sum', () => {
  const result = salary.buildInterimSalary(run, person, [payment('issued', 8000), payment('paid', 5000), payment('paid', 2000), payment('failed', 8000), payment('returned', 8000), payment('paid', 50000, { run_id: 'other' })], null);
  assert.equal(result.paid, 7000); assert.equal(result.awaitingConfirmation, 8000);
  assert.equal(result.unconfirmedBalance, 11000); assert.deepEqual(result.history.map(row => row.status), ['paid', 'paid']);
  assert.equal(result.deductionTotal, 2000); assert.equal(result.earnings.length, 1);
  assert.equal(result.reconciliation, 0); assert.equal(result.provisional, true);
});
test('hold calculations mirror current and legacy People payroll, including manual adjustments', () => {
  for (const [holdType, net, adjusted, expected] of [['hold', 18000, null, 17000], ['deduction', 17000, null, 17000], ['deduction', 17000, 17500, 17500], ['hold', 18000, 19000, 18000]]) {
    const result = salary.buildInterimSalary(run, { ...person, net_pay: net, adjusted_net_pay: adjusted, hr_payroll_run_items: [...person.hr_payroll_run_items, item('SALARY_HOLD', 1000, holdType)] }, [], null);
    assert.equal(result.payable, expected); assert.equal(result.hold, 1000); assert.equal(result.deductionTotal, 2000);
  }
});
test('paid days split work from home, business trip, casual leave, sick leave and public holiday', () => {
  const fractions = [
    { date: '2026-09-01', fraction: 1, kind: 'wfh' },
    { date: '2026-09-02', fraction: 1, kind: 'payable_work_mode' },
    { date: '2026-09-03', fraction: 1, kind: 'paid_leave' },
    { date: '2026-09-04', fraction: 1, kind: 'paid_leave' },
    { date: '2026-09-05', fraction: 1, kind: 'paid_holiday' },
    { date: '2026-09-06', fraction: 1, kind: 'present' },
    { date: '2026-09-07', fraction: 1, kind: 'weekoff' }
  ];
  const detailed = { ...person, present_days: 20, half_days: 1, absence_days: 2, weekoff_days: 4, missing_punch_days: 1, paid_leave_days: 5, payable_days: 30, calculation_snapshot: { payable_fractions: fractions } };
  const leaves = [
    { start: '2026-09-03', end: '2026-09-03', code: 'CL', name: 'Casual leave' },
    { start: '2026-09-04', end: '2026-09-04', code: 'SL', name: 'Sick leave' }
  ];
  const result = salary.buildInterimSalary(run, detailed, [], null, leaves);
  assert.deepEqual(result.attendance.paidDays.map(row => [row.label, row.days]), [
    ['Work from home', 1], ['Business trip', 1], ['Casual leave', 1], ['Sick leave', 1], ['Public holiday', 1]
  ]);
  assert.equal(result.attendance.present, 20); assert.equal(result.attendance.half, 1); assert.equal(result.attendance.absent, 2);
  assert.equal(result.attendance.weekoff, 4); assert.equal(result.attendance.missingPunches, 1);
  assert.equal(JSON.stringify(result).includes('payable_fractions'), false);
  const coded = salary.paidDayBreakdown([
    { date: '2026-09-08', fraction: 1, kind: 'paid_leave' },
    { date: '2026-09-09', fraction: 1, kind: 'paid_leave' },
    { date: '2026-09-10', fraction: 1, kind: 'paid_leave' }
  ], [
    { start: '2026-09-08', end: '2026-09-08', code: 'CASUAL', name: 'Casual Leave' },
    { start: '2026-09-09', end: '2026-09-09', code: 'SICK', name: 'Sick Leave' },
    { start: '2026-09-10', end: '2026-09-10', code: 'PUBLIC', name: 'Public Holiday' }
  ]);
  assert.equal(coded.find(row => row.label === 'Casual leave').days, 1);
  assert.equal(coded.find(row => row.label === 'Sick leave').days, 1);
  assert.equal(coded.find(row => row.label === 'Public holiday').days, 1);
  const unnamed = salary.buildInterimSalary(run, { ...detailed, paid_leave_days: 6 }, [], null, [leaves[0]]);
  assert.equal(unnamed.attendance.paidDays.find(row => row.label === 'Paid leave').days, 2);
  const legacy = salary.buildInterimSalary(run, { ...person, paid_leave_days: 4 }, [], null);
  assert.equal(legacy.attendance.paidDays, null); assert.equal(legacy.attendance.leave, 4);
});
test('missing snapshot does not invent zero salary; overpayment is flagged, private bank fields omitted', () => {
  const missing = salary.buildInterimSalary(run, null, [payment('paid', 50, { credit_account: 'private-bank', remarks: 'private-notes' })], null);
  assert.equal(missing.net, null); assert.equal(missing.attendance, null); assert.equal(missing.paid, 50);
  assert.doesNotMatch(JSON.stringify(missing), /private-bank|private-notes/);
  const over = salary.buildInterimSalary(run, person, [payment('paid', 19000)], { id: 'doc', run_id: 'run' });
  assert.equal(over.exceedsCurrentCalculation, true); assert.equal(over.unconfirmedBalance, 0); assert.equal(over.documentId, 'doc');
});
function dataFixture() {
  const queries = [];
  const tables = { hr_payroll_bank_lines: [payment('issued', 18000)], hr_pay_documents: [], hr_payroll_runs: [run], hr_payroll_run_people: [person] };
  const state = { fail: '' };
  const db = { from(table) {
    const entry = { table, filters: [] }; queries.push(entry);
    const q = { select() { return q; }, eq(...args) { entry.filters.push(['eq', ...args]); return q; }, is(...args) { entry.filters.push(['is', ...args]); return q; }, in(...args) { entry.filters.push(['in', ...args]); return q; }, order() { return q; }, limit() { return q; }, then(resolve, reject) { return Promise.resolve({ data: tables[table], error: state.fail === table ? { message: 'private database details' } : null }).then(resolve, reject); } };
    return q;
  } };
  const { loadInterimSalaries } = load('./interim-salary-data.ts', { './interim-salary': salary });
  return { queries, tables, state, load: (a = account) => loadInterimSalaries(db, a) };
}
test('loader scopes every worker read by company/type/ID and limits runs to issued/published history', async () => {
  const f = dataFixture(); assert.equal((await f.load())[0].awaitingConfirmation, 18000);
  for (const query of f.queries) {
    assert.ok(query.filters.some(x => JSON.stringify(x) === JSON.stringify(['eq', 'company_id', 'company'])));
    if (query.table !== 'hr_payroll_runs') for (const [key, value] of [['worker_type', 'employee'], ['worker_id', 'worker']]) assert.ok(query.filters.some(x => x[1] === key && x[2] === value));
  }
  assert.ok(f.queries.find(q => q.table === 'hr_pay_documents').filters.some(x => x[0] === 'is' && x[1] === 'revoked_at' && x[2] === null));
  assert.deepEqual(f.queries.find(q => q.table === 'hr_payroll_runs').filters.find(x => x[0] === 'in')[2], ['run']);
});
test('loader classifies paid leave for the signed-in worker only', async () => {
  const f = dataFixture();
  f.tables.hr_payroll_run_people = [{ ...person, paid_leave_days: 1, calculation_snapshot: { payable_fractions: [{ date: '2026-09-03', fraction: 1, kind: 'paid_leave' }] } }];
  f.tables.hr_leave_requests = [{ start_date: '2026-09-03', end_date: '2026-09-03', hr_leave_types: { code: 'CL', attendance_code: 'CL', name: 'Casual leave' } }];
  const rows = await f.load();
  assert.equal(rows[0].attendance.paidDays.find(row => row.label === 'Casual leave').days, 1);
  const leaveQuery = f.queries.find(query => query.table === 'hr_leave_requests');
  assert.deepEqual(leaveQuery.filters.filter(row => row[0] === 'eq').map(row => row.slice(1)), [['company_id', 'company'], ['employee_id', 'worker'], ['status', 'approved']]);
});
test('unreleased drafts stay private, Workforce performs no reads, failures do not become zero payroll', async () => {
  const f = dataFixture(); await assert.rejects(f.load({ ...account, workspace: 'workforce' })); assert.equal(f.queries.length, 0);
  f.tables.hr_payroll_bank_lines = []; assert.deepEqual(await f.load(), []); assert.equal(f.queries.length, 2);
  f.state.fail = 'hr_payroll_bank_lines'; await assert.rejects(f.load(), /Unable to load salary/);
});
test('salary API enforces session ownership and People scope, and uses no-store', async () => {
  const state = { denied: false, selected: account, loads: 0, fails: false };
  const api = load('../../app/api/connect/salary/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/connect-auth': { requireConnectAccount: async () => { if (state.denied) throw Error('forged account'); return state.selected; } },
    '@/lib/supabase-admin': { supabaseAdmin: {} }, '@/lib/interim-salary': salary,
    '@/lib/interim-salary-data': { loadInterimSalaries: async () => { state.loads++; if (state.fails) throw Error('secret database details'); return []; } }
  });
  const req = (type = 'employee') => new Request(`https://one.example/api/connect/salary?profileType=${type}&accountId=worker`);
  assert.equal((await api.GET(req('workforce'))).status, 403);
  state.denied = true; assert.equal((await api.GET(req())).status, 403);
  state.denied = false; state.selected = { ...account, workspace: 'workforce' }; assert.equal((await api.GET(req('contractor'))).status, 403); assert.equal(state.loads, 0);
  state.selected = { ...account, readOnlyPreview: true }; const response = await api.GET(req()); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /private, no-store/);
  state.fails = true; const error = await api.GET(req()); assert.equal(error.status, 503); assert.doesNotMatch(await error.text(), /secret/);
});
test('dashboard notices are data driven, expire, and require an explicit valid display window', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const notice = { id: 'notice', data: { showOnDashboard: true, dashboardUntil: '2026-11-01T00:00:00Z' } };
  assert.deepEqual(visibleDashboardNotices([notice], now), [notice]);
  for (const data of [{}, { showOnDashboard: true }, { showOnDashboard: true, dashboardUntil: 'bad' }, { ...notice.data, dashboardUntil: '2026-10-09T12:00:00Z' }]) assert.equal(visibleDashboardNotices([{ ...notice, data }], now).length, 0);
});
test('dashboard preview verification uses target authorization and triple scoping; tampering is denied', async () => {
  const calls = []; const state = { preview: account, resolved: account, fail: false };
  const q = { select() { return q; }, eq(...args) { calls.push(args); return q; }, then(resolve) { return Promise.resolve({ data: [{ kind: 'pan', verified: true, details: {} }], error: null }).then(resolve); } };
  const api = load('../../app/api/connect/verification/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/connect-auth': { requireConnectAccount: async () => { if (state.fail) throw Error('unauthorized'); return state.resolved; } },
    '@/lib/connect-preview': { resolveConnectPreview: async () => state.preview },
    '@/lib/supabase-admin': { supabaseAdmin: { from: () => q } },
    '@/lib/vehicle-fuel': { vehicleFuelTypeForClient: () => '' }
  });
  const request = { nextUrl: new URL('https://one.example/api/connect/verification?profileType=employee&accountId=worker') };
  const response = await api.GET(request); assert.equal(response.status, 200); assert.equal((await response.json()).verifications[0].verified, true);
  assert.deepEqual(calls, [['company_id', 'company'], ['profile_type', 'employee'], ['account_id', 'worker']]);
  calls.length = 0;
  for (const override of [{ companyId: 'other' }, { id: 'other' }, { profileType: 'contractor' }]) { state.resolved = { ...account, ...override }; assert.equal((await api.GET(request)).status, 403); }
  state.fail = true; assert.equal((await api.GET(request)).status, 403); assert.equal(calls.length, 0);
});
test('notification inbox and dashboard CTA are independently scoped; preview makes no writes', async () => {
  const reads = []; let selected = account;
  const db = { from(table) {
    assert.equal(table, 'mob_app_notifications'); const filters = []; reads.push(filters);
    const q = { select() { return q; }, eq(...args) { filters.push(args); return q; }, is(...args) { filters.push(args); return q; }, contains(...args) { filters.push(args); return q; }, gt(...args) { filters.push(args); return q; }, order() { return q; }, limit() { return q; }, then(resolve) { return Promise.resolve({ data: [{ id: 'notice', title: 'Test notice', body: 'Test', route: 'salary', created_at: '2026-10-09', data: { showOnDashboard: true, dashboardUntil: '2099-01-01T00:00:00.000Z' } }], error: null }).then(resolve); } };
    return q;
  } };
  const api = load('../../app/api/connect/notifications/route.ts', {
    'next/headers': { cookies: () => ({ get: () => ({ value: 'preview' }) }) },
    '@/lib/connect-preview-policy': { connectPreviewCookieName: 'preview' },
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '../../../../src/lib/connect-auth': { requireConnectAccount: async () => { if (!selected) throw Error('Login expired'); return selected; } },
    '../../../../src/lib/connect-approver-identity': { resolveConnectActorUserId: async () => 'actor' },
    '../../../../src/lib/supabase-admin': { supabaseAdmin: db }, '@/lib/dashboard-notices': { visibleDashboardNotices },
    '@/lib/announcement-personalization-data': { personalizeNotices: async (_db, _account, rows) => rows }
  });
  const req = new Request('https://one.example/api/connect/notifications?profileType=employee&accountId=worker');
  const response = await api.GET(req); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.notifications.length, 1); assert.equal(result.dashboardNotices[0].route, 'salary');
  assert.equal(reads.length, 2);
  for (const filters of reads) for (const [key, value] of [['company_id', 'company'], ['recipient_profile_type', 'employee'], ['recipient_account_id', 'worker'], ['archived_at', null]]) assert.ok(filters.some(row => row[0] === key && row[1] === value));
  assert.ok(reads[1].some(row => row[0] === 'data->>dashboardUntil'));
  selected = null; assert.equal((await api.GET(req)).status, 401); assert.equal(reads.length, 2);
});
