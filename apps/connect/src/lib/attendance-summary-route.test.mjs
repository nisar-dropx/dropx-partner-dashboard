import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { summarizeAttendance } from './attendance-summary.ts';
import { resolveAttendancePayDayType } from '../../../../src/lib/attendance-pay-day.ts';
import { approvedLeaveDays } from './leave-calendar-days.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixedNow = '2026-10-09T17:00:00Z';
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return Date.parse(fixedNow); }
}
const company = 'company-a';
const workerId = 'worker-a';
const bio = '230001';
const shift = { id: 'shift', code: 'SHIFT_09', name: '09:00 shift', start_time: '09:00', end_time: '18:00', break_minutes: 0, grace_in_minutes: 0, grace_out_minutes: 0 };
const weekly = { id: 'weekly', company_id: company, status: 'approved', roster_kind: 'recurring_weekly', effective_from: '2026-08-31', superseded_at: null, revision_no: 1 };
const dated = { id: 'dated', company_id: company, status: 'approved', roster_kind: 'dated', effective_from: '2026-09-28', superseded_at: null, revision_no: 5 };
const date = n => `2026-10-${String(n).padStart(2, '0')}`;
const at = (day, clock) => `${date(day)}T${clock}:00+05:30`;
const daily = (day, minutes = 540, extra = {}) => ({ company_id: company, employee_id: workerId, worker_type: 'employee', enrolment_id: bio, punch_date: date(day), in_time: at(day, '09:00'), out_time: at(day, '18:00'), punch_count: 2, work_minutes: minutes, status: 'P', work_mode: 'onsite', remark: '', ...extra });
function tables() {
  return {
    employees: [{ id: workerId, company_id: company, biometric_id: bio, employee_code: 'TEST001', full_name: 'Test worker', location_id: 'station-a', employment_type: 'full_time' }],
    hr_company_settings: [{ company_id: company, attendance_grace_minutes: 0, no_punch_treatment: 'absent', single_punch_treatment: 'review', odd_punch_treatment: 'first_last', full_day_minutes: 480, half_day_minutes: 240, work_duration_basis: 'fixed', partial_day_treatment: 'half_day', below_half_day_treatment: 'absent', unassigned_shift_treatment: 'fixed_minutes', regularization_max_backdate_days: 30 }],
    hr_roster_plans: [weekly, dated],
    hr_roster_entries: [
      ...['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'].map((d, i) => ({ company_id: company, plan_id: weekly.id, worker_id: workerId, worker_type: 'employee', roster_date: d, day_type: i === 3 ? 'weekly_off' : 'working', hr_shifts: i === 3 ? null : shift, hr_roster_plans: weekly })),
      ...[1, 2, 3, 4].map(d => ({ company_id: company, plan_id: dated.id, worker_id: workerId, worker_type: 'employee', roster_date: date(d), day_type: 'working', hr_shifts: { ...shift, start_time: '12:00', end_time: '21:00' }, hr_roster_plans: dated }))
    ],
    attendance_daily: [daily(1, 735), daily(2, 504, { punch_count: 3 }), daily(5, 331), daily(6, 659, { punch_count: 7 }), daily(7, 656), daily(8, 777, { punch_count: 3 }), daily(9, 678)],
    attendance_punches: [], hr_leave_requests: [], hr_leave_types: [], hr_payroll_calendar_days: [], attendance_regularization_requests: []
  };
}

/** Run the real GET, real biometric evaluator and real roster resolver.
 * Only transport/auth/time are mocked; no precomputed calendar classifications. */
function fixture() {
  const data = tables(); const queries = []; const cache = new Map();
  const get = (row, field) => field.split('.').reduce((v, key) => v?.[key], row);
  const db = {
    from(table) {
      const conditions = []; queries.push({ table, conditions }); const orders = [];
      const result = () => {
        let rows = (data[table] ?? []).filter(row => conditions.every(test => test(row)));
        for (const [field, asc] of [...orders].reverse()) rows = [...rows].sort((a, b) => String(get(a, field)).localeCompare(String(get(b, field))) * (asc ? 1 : -1));
        return { data: rows, error: null };
      };
      const q = {
        select() { return q; }, eq(k, v) { conditions.push(r => get(r, k) === v); return q; },
        in(k, v) { conditions.push(r => v.includes(get(r, k))); return q; },
        gte(k, v) { conditions.push(r => get(r, k) >= v); return q; }, lte(k, v) { conditions.push(r => get(r, k) <= v); return q; },
        order(k, o = {}) { orders.push([k, o.ascending !== false]); return q; },
        async maybeSingle() { return { data: result().data[0] ?? null, error: null }; },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
      };
      return q;
    },
    async rpc(name) { assert.equal(name, 'hr_regularization_rules'); return { data: null, error: null }; }
  };
  const worker = { companyId: company, profileId: workerId, profileType: 'employee', biometricId: bio, dateOfJoin: '2025-01-01', locationId: 'station-a' };
  const mocks = {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/connect-attendance-worker': { resolveConnectAttendanceWorker: async () => worker },
    '@/lib/supabase-admin': { supabaseAdmin: db },
    '@/lib/attendance-pay-day': { resolveAttendancePayDayType },
    '@/lib/attendance-summary': { summarizeAttendance },
    '@/lib/leave-calendar-days': { approvedLeaveDays },
    '@/lib/user-facing-error': { userFacingError: (e, fallback) => e.message || fallback },
    '@/lib/regularization-input': {},
    '@/lib/connect-regularization-cancel': { cancellableRegularizationStatuses: ['pending_manager', 'pending_hr', 'returned'], regularizationIdsWithApproval: async () => new Set(), canCancelRegularization: () => true },
    '../../../../../../src/lib/attendance-regularization-workflow': {},
    '../../../../../../src/lib/connect-attendance-notifications': {}
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const source = fs.readFileSync(file, 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} }; cache.set(file, mod.exports);
    new Function('require', 'module', 'exports', 'Date', js)(id => {
      if (id in mocks) return mocks[id];
      if (id === '../supabase-admin') return { supabaseAdmin: db };
      assert.ok(id.startsWith('.'), `Unexpected dependency: ${id}`);
      return load(path.resolve(path.dirname(file), `${id}.ts`));
    }, mod, mod.exports, FixedDate);
    return mod.exports;
  }
  const route = load(path.join(root, 'apps/connect/app/api/connect/attendance/route.ts'));
  return { data, worker, queries, async run() {
    const response = await route.GET({ nextUrl: new URL('https://one.example/api/connect/attendance?accountId=worker-a&profileType=employee&month=2026-10') });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  } };
}

test('real backend: 7 punch days + approved roster gaps => 6 full / 1 half / 2 absent / 0 review', async () => {
  const f = fixture(); const before = JSON.stringify(f.data); const body = await f.run();
  assert.equal(body.summary.fullDay, 6); assert.equal(body.summary.halfDay, 1);
  assert.equal(body.summary.absent, 2); assert.equal(body.summary.needsReview, 0);
  for (const d of [3, 4]) {
    const row = body.rows.find(r => r.date === date(d));
    assert.equal(row.payDayType, 'absent'); assert.equal(row.punchCount, 0);
    assert.equal(row.scheduledStart, '12:00'); assert.equal(row.shiftSource, 'Roster');
  }
  assert.equal(body.rows.find(r => r.date === date(8)).attendanceStatus, 'Present (Weekly Off)');
  assert.equal(body.summary.totalRows, 9); assert.equal(JSON.stringify(f.data), before, 'GET must not alter source data');
});

test('real backend overlays approved leave and station holiday BEFORE counts', async () => {
  const f = fixture();
  f.data.hr_leave_types.push({ company_id: company, id: 'CL', name: 'Casual leave', attendance_code: 'CL', attendance_label: 'Casual leave', is_paid: true });
  f.data.hr_leave_requests.push({ company_id: company, employee_id: workerId, leave_type_id: 'CL', start_date: date(3), end_date: date(3), status: 'approved' });
  f.data.hr_payroll_calendar_days.push({ company_id: company, is_active: true, calendar_date: date(4), day_type: 'paid_holiday', name: 'Test holiday', location_id: 'station-a' });
  const body = await f.run(); assert.equal(body.summary.absent, 0); assert.equal(body.summary.needsReview, 0);
  assert.equal(body.rows.find(r => r.date === date(3)).payDayType, 'paid_leave');
  assert.equal(body.rows.find(r => r.date === date(4)).payDayType, 'paid_holiday');
});

test('real backend respects configured no-punch review and odd-punch rules, not hardcoded absence', async () => {
  const f = fixture(); Object.assign(f.data.hr_company_settings[0], { no_punch_treatment: 'review', odd_punch_treatment: 'review' });
  const body = await f.run(); assert.equal(body.summary.absent, 0); assert.equal(body.summary.needsReview, 4);
  assert.equal(body.rows.find(r => r.date === date(2)).attendanceStatus, 'Needs Review');
});

test('real backend retains approved manual times when raw punches are shorter', async () => {
  const f = fixture(); f.data.attendance_daily[2] = daily(5, 331, { manual_out_request_id: 'approved-correction', out_source: 'regularization' });
  f.data.attendance_punches.push({ company_id: company, enrolment_id: bio, punch_date: date(5), punch_time: at(5, '09:05'), calculated: true, punch_label: 'IN' });
  const body = await f.run(); const row = body.rows.find(r => r.date === date(5));
  assert.equal(row.inTime, '09:00'); assert.equal(row.outTime, '18:00'); assert.equal(row.attendanceStatus, 'Full Day');
  assert.equal(body.summary.fullDay, 7); assert.equal(body.summary.halfDay, 0);
});

test('pending replacement roster cannot replace the approved baseline', async () => {
  const f = fixture(); const pending = { ...weekly, id: 'pending', effective_from: '2026-10-05', revision_no: 20, status: 'pending' };
  f.data.hr_roster_plans.push(pending);
  f.data.hr_roster_entries.push({ ...f.data.hr_roster_entries[0], plan_id: pending.id, hr_roster_plans: pending, day_type: 'weekly_off', roster_date: date(5) });
  const body = await f.run(); assert.equal(body.rows.find(r => r.date === date(5)).attendanceStatus, 'Half Day');
});

test('other-company leave, punches and holidays cannot affect this worker', async () => {
  const f = fixture(); f.data.attendance_daily.push(daily(3, 600, { company_id: 'other' }));
  f.data.hr_payroll_calendar_days.push({ company_id: 'other', is_active: true, calendar_date: date(3), day_type: 'paid_holiday', location_id: null });
  const body = await f.run(); assert.equal(body.summary.absent, 2);
});

test('pending, rejected and cancelled requests never replace no-punch policy outcome', async () => {
  for (const status of ['pending_manager', 'rejected', 'cancelled']) {
    const f = fixture();
    f.data.attendance_regularization_requests.push({ company_id: company, profile_type: 'employee', profile_id: workerId, id: 'request', attendance_date: date(3), status, created_at: at(4, '09:00'), request_kind: null });
    const body = await f.run(); const row = body.rows.find(r => r.date === date(3));
    assert.equal(row.payDayType, 'absent'); assert.equal(row.regularization.status, status);
    assert.equal(body.summary.absent, 2); assert.equal(body.summary.needsReview, 0);
  }
});

test('single-punch absent configuration is not silently changed to review by the UI helper', async () => {
  const f = fixture(); f.data.hr_company_settings[0].single_punch_treatment = 'absent';
  f.data.attendance_daily[2] = daily(5, 0, { punch_count: 1, out_time: null });
  const body = await f.run(); assert.equal(body.summary.absent, 3); assert.equal(body.summary.needsReview, 0);
});

test('approved correction with stale missing-punch remark still uses corrected complete times', async () => {
  const f = fixture(); f.data.attendance_daily[2] = daily(5, 331, { manual_out_request_id: 'approved-correction', out_source: 'regularization', remark: 'Single punch before correction' });
  const body = await f.run(); assert.equal(body.summary.fullDay, 7); assert.equal(body.summary.needsReview, 0);
});

test('WFH credit lifecycle is evaluated by backend before summary', async () => {
  const f = fixture();
  f.data.attendance_daily[2] = daily(5, 480, { work_mode: 'wfh', punch_count: 0, in_time: null, out_time: null, wfh_scheduled_start_at: at(5, '09:00'), wfh_scheduled_end_at: at(5, '18:00'), wfh_credit_finalized_at: at(5, '18:05') });
  f.data.attendance_daily[6] = daily(9, 480, { work_mode: 'wfh', punch_count: 0, in_time: null, out_time: null, wfh_scheduled_start_at: at(9, '09:00'), wfh_scheduled_end_at: at(9, '23:00'), wfh_credit_finalized_at: null });
  const body = await f.run();
  assert.equal(body.rows.find(r => r.date === date(5)).payDayType, 'present_wfh');
  assert.equal(body.rows.find(r => r.date === date(9)).payDayType, 'no_record');
  assert.equal(body.summary.fullDay, 6); assert.equal(body.summary.needsReview, 0);
});

test('independent contractors use their own approved roster and the same outcome rules', async () => {
  const f = fixture(); f.worker.profileType = 'contractor';
  f.data.contractors = f.data.employees.map(e => ({ ...e, dropx_id: e.employee_code })); f.data.employees = [];
  f.data.attendance_daily.forEach(d => { d.employee_id = null; d.worker_type = 'contractor'; });
  f.data.hr_roster_entries.forEach(e => { e.worker_type = 'contractor'; });
  const body = await f.run(); assert.equal(body.summary.fullDay, 6); assert.equal(body.summary.halfDay, 1);
  assert.equal(body.summary.absent, 2); assert.equal(body.summary.needsReview, 0);
});
