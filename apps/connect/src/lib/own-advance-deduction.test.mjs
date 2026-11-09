import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';

const secret = 'test-only-key';
function load(fetch, env = { SUPABASE_SERVICE_ROLE_KEY: secret }, dueResult = {data:[{advance_id:'due'}],error:null}, queries = [], client = null) {
  const source = readFileSync(new URL('./own-advance-deduction.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'exports', 'process', 'fetch', output)(name => {
    if (name === 'server-only') return {};
    if (name === '@/lib/supabase-admin' && client) return {supabaseAdmin:client};
    if (name === '@/lib/supabase-admin') return {
      supabaseAdmin: {
        rpc(name, args, options) {
          queries.push({ name, args, options });
          return {
            eq(column, value) {
              queries.push({ column, value });
              return { limit: async limit => { queries.push({ limit }); return dueResult; } };
            }
          };
        }
      }
    };
    assert.equal(name, 'node:crypto'); return crypto;
  }, module.exports, { env }, fetch);
  return module.exports.loadOwnAdvanceDeduction;
}

test('verified empty personal advance ledger avoids a duplicate payout calculation', async () => {
  const queries = [];
  const lookup = load(() => assert.fail('must not recalculate payout'), undefined, { data: [], error: null }, queries);
  assert.equal(await lookup('company', 'canonical-worker', '2026-11'), 0);
  assert.deepEqual(queries, [
    { name: 'pay_advance_period_due', args: { p_company: 'company', p_period: '2026-11-01', p_target: 'workforce', p_run: null }, options: {get:true} },
    { column: 'worker_id', value: 'canonical-worker' }, { limit: 1 }
  ]);
});

test('real Supabase advance reads work through preview guard; financial writes remain blocked', async () => {
  let preview = true;
  const guard = {exports:{}};
  const source = readFileSync(new URL('./connect-preview-fetch.ts', import.meta.url), 'utf8');
  new Function('require','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name => {
    if (name === 'next/headers') return {cookies:()=>({get:()=>preview?{value:'preview'}:undefined})};
    if (name === './connect-preview-policy') return {connectPreviewCookieName:'preview',previewReadOnlyMessage:'Read-only preview'};
    assert.fail(name);
  },guard.exports);
  const calls=[];
  const client=createClient('https://example.supabase.co','test-only-key',{
    auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:guard.exports.previewSafeFetch(async (input,init)=>{
      calls.push({url:new URL(String(input)),method:init.method});
      return Response.json([]);
    })}
  });
  const lookup=load(()=>assert.fail('empty ledger must not recalculate'),undefined,undefined,[],client);
  for(const active of [true,false]) {
    preview=active;
    assert.equal(await lookup('company','worker','2026-11'),0);
    assert.equal(calls.at(-1).method,'GET');
    assert.equal(calls.at(-1).url.pathname,'/rest/v1/rpc/pay_advance_period_due');
    assert.equal(calls.at(-1).url.searchParams.get('worker_id'),'eq.worker');
    assert.equal(calls.at(-1).url.searchParams.get('p_company'),'company');
  }
  preview=true;
  const count=calls.length;
  const mutation=await client.rpc('workforce_raise_payout_dispute',{p_company:'company'});
  assert.equal(mutation.status,403);
  assert.equal(calls.length,count);
});

test('unavailable or malformed advance ledger never hides a deduction', async () => {
  for (const due of [{ data: [], error: { message: 'timeout' } }, { data: null, error: null }]) {
    await assert.rejects(load(() => assert.fail('must not fetch'), undefined, due)('company', 'worker', '2026-11'),
      { message: 'Your advance deductions could not be verified. Please retry.' });
  }
});
test('service lookup binds the canonical company, worker and month; never forwards actor cookies or secret', async () => {
  for (const amount of [0, 78.12]) {
    let calls = 0;
    const lookup = load(async (url, options) => {
      calls++;
      assert.equal(url.toString(), 'https://dashboard.dropxlogistics.com/api/internal/workforce-advance-deduction');
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
      assert.deepEqual(JSON.parse(options.body), { companyId: 'company', workforceId: 'canonical-worker', month: '2026-10' });
      assert.deepEqual(Object.keys(options.headers).sort(), ['content-type', 'x-dropx-signature', 'x-dropx-time']);
      assert.equal(options.headers['x-dropx-signature'], crypto.createHmac('sha256', secret)
        .update(`dropx:workforce-advance-deduction:v1.${options.headers['x-dropx-time']}.${options.body}`).digest('hex'));
      assert.equal(JSON.stringify(options).includes(secret), false);
      return Response.json({ advanceRecoveryAmount: amount });
    });
    assert.equal(await lookup('company', 'canonical-worker', '2026-10'), amount); assert.equal(calls, 1);
  }
});
test('invalid amounts, downstream errors and network failure never become zero deductions', async () => {
  for (const response of [() => Response.json({ error: 'PRIVATE' }, { status: 401 }),
    () => Response.json({}), () => Response.json(null), () => Response.json({ advanceRecoveryAmount: '50' }),
    () => Response.json({ advanceRecoveryAmount: -1 }), () => new Response('PRIVATE HTML'),
    () => { throw Error('PRIVATE network'); }]) {
    await assert.rejects(load(response)('company', 'worker', '2026-10'), error => {
      assert.equal(error.message, 'Your advance deductions could not be verified. Please retry.'); return true;
    });
  }
});
test('missing key fails without making a request; configured Dashboard origin is used', async () => {
  await assert.rejects(load(() => assert.fail('must not fetch'), {})('company', 'worker', '2026-10'));
  const lookup = load(async url => {
    assert.equal(url.origin, 'https://configured.example'); return Response.json({ advanceRecoveryAmount: 0 });
  }, { SUPABASE_SERVICE_ROLE_KEY: secret, DASHBOARD_URL: 'https://configured.example/base' });
  assert.equal(await lookup('company', 'worker', '2026-10'), 0);
});
