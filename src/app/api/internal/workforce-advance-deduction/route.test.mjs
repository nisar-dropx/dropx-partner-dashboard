import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';

const secret = 'test-only-service-key';
const input = { companyId: '11111111-1111-4111-8111-111111111111', workforceId: '22222222-2222-4222-8222-222222222222', month: '2026-10' };
const purpose = 'dropx:workforce-advance-deduction:v1';
function request(value = input, options = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const timestamp = options.timestamp ?? String(Date.now());
  const signature = crypto.createHmac('sha256', secret).update(`${options.purpose ?? purpose}.${timestamp}.${body}`).digest('hex');
  return new Request('https://dashboard.example/api/internal/workforce-advance-deduction', {
    method: 'POST', body: options.sentBody ?? body,
    headers: { 'x-dropx-time': timestamp, 'x-dropx-signature': options.signature ?? signature }
  });
}
function fixture({ found = true, dbError = null, amount = 45.5, failure = false } = {}) {
  const queries = [], calculations = [];
  const db = { from(table) {
    const ops = [['from', table]]; queries.push(ops);
    const chain = {};
    for (const method of ['select', 'eq', 'is', 'neq']) chain[method] = (...args) => { ops.push([method, ...args]); return chain; };
    chain.maybeSingle = async () => ({ data: found ? { id: input.workforceId } : null, error: dbError });
    return chain;
  } };
  const imports = {
    'node:crypto': crypto,
    '@/lib/supabase-admin': { supabaseAdmin: db },
    '@/lib/pay-advance-capacity': { loadOwnWorkforceAdvanceDeduction: async (...args) => {
      calculations.push(args); if (failure) throw Error('PRIVATE DATABASE FAILURE'); return amount;
    } }
  };
  const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'exports', 'process', output)(name => { assert.ok(imports[name], name); return imports[name]; }, module.exports, { env: { SUPABASE_SERVICE_ROLE_KEY: secret } });
  return { POST: module.exports.POST, queries, calculations };
}

test('signed read uses one company, canonical worker and month with the existing payout calculation', async () => {
  for (const amount of [0, 45.5]) {
    const f = fixture({ amount }), response = await f.POST(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { advanceRecoveryAmount: amount });
    assert.deepEqual(f.calculations, [[input.companyId, input.workforceId, input.month]]);
    assert.deepEqual(f.queries, [[['from', 'workforce'], ['select', 'id'], ['eq', 'company_id', input.companyId], ['eq', 'id', input.workforceId], ['is', 'deleted_at', null], ['neq', 'migration_state', 'reclassified']]]);
  }
});
test('missing, wrong-purpose, expired, future, forged and tampered signatures cannot read payroll', async () => {
  for (const options of [
    { signature: '' }, { signature: 'x'.repeat(64) }, { signature: '0'.repeat(64) },
    { purpose: 'dropx:advance-context:v1' }, { timestamp: String(Date.now() - 120_000) },
    { timestamp: String(Date.now() + 120_000) }, { timestamp: 'NaN' }, { timestamp: '9'.repeat(400) },
    { sentBody: JSON.stringify({ ...input, workforceId: input.companyId }) }
  ]) {
    const f = fixture(), response = await f.POST(request(input, options));
    assert.equal(response.status, 401); assert.equal(f.queries.length, 0); assert.equal(f.calculations.length, 0);
  }
});
test('invalid company, worker, month or body cannot start a payout calculation', async () => {
  for (const value of [null, {}, '{', { ...input, companyId: 'other' }, { ...input, workforceId: null },
    { ...input, month: '2026-13' }, { ...input, month: '2026-10-01' }, { ...input, month: ['2026-10'] }]) {
    const f = fixture(), response = await f.POST(request(value));
    assert.equal(response.status, 400); assert.equal(f.queries.length, 0); assert.equal(f.calculations.length, 0);
  }
  const f = fixture(); assert.equal((await f.POST(request(' '.repeat(2001)))).status, 401);
});
test('a worker absent from the company (or deleted/reclassified) is rejected before calculation', async () => {
  const f = fixture({ found: false }), response = await f.POST(request());
  assert.equal(response.status, 404); assert.equal(f.calculations.length, 0);
});
test('database failures and invalid financial results fail closed without leaking details', async () => {
  for (const options of [{ dbError: { message: 'PRIVATE' } }, { failure: true }, { amount: NaN }, { amount: Infinity }, { amount: -1 }]) {
    const f = fixture(options), response = await f.POST(request()), body = await response.json();
    assert.equal(response.status, 503); assert.equal('advanceRecoveryAmount' in body, false);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});
