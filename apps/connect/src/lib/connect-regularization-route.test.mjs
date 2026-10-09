import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { regularizationTimeInput } from './regularization-input.ts';
import { userFacingError } from './user-facing-error.ts';

function fixture() {
  const state = { existing: null, rpcError: null, routeError: null, authError: null, uploaded: [], removed: [], rpc: [], notifications: [], logs: [], queries: [], steps: [{ step_name: 'Manager approval', approver_user_id: 'manager', approver_person_id: 'person' }] };
  const db = {
    from(table) {
      state.queries.push(table);
      const q = { select() { return q; }, eq() { return q; }, is() { return q; }, in() { return q; }, order() { return q; }, limit() { return q; }, async maybeSingle() { return { data: state.existing, error: null }; } };
      return q;
    },
    storage: { from(bucket) {
      assert.equal(bucket, 'employee-profile-documents');
      return {
        async upload(path) { state.uploaded.push(path); return { error: null }; },
        async remove(paths) { state.removed.push(...paths); return { error: null }; }
      };
    } },
    async rpc(name, args) { state.rpc.push({ name, args }); return { data: state.rpcError ? null : 'request-id', error: state.rpcError }; }
  };
  const mocks = {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/connect-attendance-worker': { resolveConnectAttendanceWorker: async () => {
      if (state.authError) throw Error(state.authError);
      return { companyId: 'company', profileId: 'worker', profileType: 'employee', fullName: 'Test person' };
    } },
    '@/lib/supabase-admin': { supabaseAdmin: db },
    '@/lib/attendance-pay-day': {}, '@/lib/leave-calendar-days': {}, '@/lib/attendance-summary': {},
    '@/lib/user-facing-error': { userFacingError },
    '@/lib/regularization-input': { regularizationTimeInput },
    '@/lib/connect-regularization-cancel': {},
    '../../../../../../src/lib/biometric/attendance': {},
    '../../../../../../src/lib/attendance-regularization-workflow': { resolveAttendanceRegularizationApprovers: async () => { if (state.routeError) throw Error(state.routeError); return { steps: state.steps }; } },
    '../../../../../../src/lib/connect-attendance-notifications': { notifyAttendanceApprovalRequired: async (input) => state.notifications.push(input) }
  };
  const source = fs.readFileSync(new URL('../../app/api/connect/attendance/route.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'console', js)(id => { assert.ok(id in mocks, id); return mocks[id]; }, mod, mod.exports, { error: (...args) => state.logs.push(args) });
  return { state, POST: mod.exports.POST };
}
function request(overrides = {}, proofCount = 2) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ accountId: 'worker', profileType: 'employee', attendanceDate: '2026-09-29', currentInTime: '', currentOutTime: '', requestedInTime: '09:00', requestedOutTime: '18:00', reasonCode: 'missed_both', remarks: 'Test only: missing punches', ...overrides })) form.set(key, value);
  if (proofCount >= 1) form.set('attachment', new File(['unit-test fixture'], 'in.png', { type: 'image/png' }));
  if (proofCount >= 2) form.set('attachmentOut', new File(['unit-test fixture'], 'out.png', { type: 'image/png' }));
  return new Request('https://one.example/api/connect/attendance', { method: 'POST', body: form });
}
test('screenshot failure returns specific guidance before storage/RPC (also protects old clients)', async () => {
  const f = fixture(); const response = await f.POST(request({ reasonCode: 'other', requestedInTime: '', requestedOutTime: '' }, 1));
  assert.equal(response.status, 400); assert.match((await response.json()).error, /Select Missed both punches/);
  assert.equal(f.state.uploaded.length, 0); assert.equal(f.state.rpc.length, 0);
});
test('valid missed-both request keeps both proofs and enters manager approval, never auto-approves', async () => {
  const f = fixture(); const response = await f.POST(request());
  assert.equal(response.status, 200); assert.equal((await response.json()).request.status, 'pending_manager');
  assert.equal(f.state.rpc[0].name, 'hr_create_attendance_regularization_with_steps');
  assert.equal(f.state.rpc[0].args.p_requested_in_time, '09:00'); assert.equal(f.state.rpc[0].args.p_requested_out_time, '18:00');
  assert.equal(f.state.rpc[0].args.p_attachment_path, f.state.uploaded[0]); assert.equal(f.state.rpc[0].args.p_attachment_path_out, f.state.uploaded[1]);
  assert.equal(f.state.notifications[0].recipientUserId, 'manager'); assert.equal(f.state.removed.length, 0);
});
test('missing proof and missing OUT proof still block submission', async () => {
  for (const count of [0, 1]) {
    const f = fixture(); const response = await f.POST(request({}, count));
    assert.equal(response.status, 400); assert.match((await response.json()).error, /proof/);
    assert.equal(f.state.rpc.length, 0); assert.deepEqual(f.state.removed, f.state.uploaded);
  }
});
test('returned dual-proof request reuses both existing proofs, not only the IN proof', async () => {
  const f = fixture(); f.state.existing = { id: 'returned', status: 'returned', attachment_path: 'existing-in', attachment_path_out: 'existing-out' };
  assert.equal((await f.POST(request({}, 0))).status, 200);
  assert.equal(f.state.rpc[0].args.p_attachment_path_out, 'existing-out');
  f.state.existing.attachment_path_out = null; f.state.rpc = [];
  assert.equal((await f.POST(request({}, 0))).status, 400); assert.equal(f.state.rpc.length, 0);
});
test('returned Other keeps current times unchanged', async () => {
  const f = fixture(); f.state.existing = { status: 'returned', attachment_path: 'existing-proof' };
  assert.equal((await f.POST(request({ reasonCode: 'other', currentInTime: '09:30', currentOutTime: '17:45' }, 0))).status, 200);
  assert.equal(f.state.rpc[0].args.p_requested_in_time, '09:30'); assert.equal(f.state.rpc[0].args.p_requested_out_time, '17:45');
});
test('duplicate pending and unauthenticated requests cannot upload or create', async () => {
  const f = fixture(); f.state.existing = { status: 'pending_manager' };
  assert.equal((await f.POST(request())).status, 400); assert.equal(f.state.uploaded.length, 0);
  f.state.existing = null; f.state.authError = 'Login expired.';
  assert.equal((await f.POST(request())).status, 401); assert.equal(f.state.rpc.length, 0);
});
test('database and routing failure clean up only newly uploaded files; diagnostics omit private data', async () => {
  for (const failingStage of ['create_request', 'approval_route']) {
    const f = fixture();
    if (failingStage === 'create_request') f.state.rpcError = { code: '23502', message: 'null value violates not-null constraint' };
    else f.state.routeError = 'Database configuration failed';
    assert.equal((await f.POST(request())).status, 400);
    assert.deepEqual(f.state.removed, f.state.uploaded);
    assert.equal(f.state.logs[0][1].stage, failingStage);
    assert.doesNotMatch(JSON.stringify(f.state.logs), /Test person|missing punches|existing-proof/);
  }
});
test('no manager route retains existing HR queue fallback', async () => {
  const f = fixture(); f.state.steps = [];
  const response = await f.POST(request());
  assert.equal((await response.json()).request.status, 'pending_hr'); assert.equal(f.state.notifications.length, 0);
});
