import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { NextRequest } from 'next/server.js';
import { readPaymentPages, approvalQueueCondition } from './payment-query-policy.ts';
import { sharedAuthStorageKey, LEGACY_OPS_AUTH_KEY, SessionUnavailableError, isTransientAuthFailure } from './auth-session-policy.ts';
const require = createRequire(import.meta.url);
const projectUrl = 'https://test-project.supabase.co';
const key = sharedAuthStorageKey(projectUrl);
const policy = { sharedAuthStorageKey, LEGACY_OPS_AUTH_KEY, SessionUnavailableError, isTransientAuthFailure };
function load(file, mocks = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { exports: module.exports, module, require: id => {
    if (id in mocks) return mocks[id];
    if (id.includes('auth-session-policy')) return policy;
    if (id === 'next/server') return require('next/server');
    if (id.includes('with-timeout')) return { withTimeout: p => p };
    if (id.includes('timeout-fetch')) return { timeoutFetch: () => fetch };
    if (id.includes('people/surface')) return { isPeopleHostName: () => false, isPeoplePortalPath: () => false };
    if (id.includes('finance/surface')) return { isFinanceHostName: () => false, isFinancePortalPath: () => false };
    if (id.includes('provider-mapping-host')) return { providerMappingPageCodeForHost: () => 'test' };
    if (id === 'react') return { cache: fn => fn };
    if (id.startsWith('@/')) return {};
    return require(id);
  }, process: { env: { NEXT_PUBLIC_SUPABASE_URL: projectUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-public-key', NODE_ENV: 'production' } }, console, URL, TextEncoder, TextDecoder, btoa, atob, setTimeout, clearTimeout });
  return module.exports;
}
const encode = value => 'b64-' + Buffer.from(value).toString('base64url');
const decode = value => Buffer.from(value.slice(4), 'base64url').toString();
function middleware(auth) {
  return load('../middleware.ts', { '@supabase/supabase-js': { createClient: (_url, _key, opts) => ({ auth: auth(opts.auth) }) } }).middleware;
}
for (const [host, path, rewrite] of [
  ['ops.dropxlogistics.com', '/payments/approvals', null],
  ['ops.dropxlogistics.com', '/reports', '/ops-pulse/reports'],
  ['dashboard.dropxlogistics.com', '/payments/approvals', null],
  ['admin-panel.dropxlogistics.com', '/', '/platform-admin']
]) test(`refresh reaches current request and browser on ${host}${path}`, async () => {
  const run = middleware(opts => ({ getClaims: async () => {
    assert.equal(opts.storageKey, key);
    assert.equal(opts.storage.getItem(key), 'old');
    opts.storage.setItem(key, 'fresh');
    return { data: { claims: { sub: 'user-id' } }, error: null };
  } }));
  const request = new NextRequest(`https://${host}${path}`, { headers: { host, cookie: `${key}.0=${encode('old')}` } });
  const response = await run(request);
  const forwarded = response.headers.get('x-middleware-request-cookie');
  assert.ok(forwarded.includes(`${key}.0=${encode('fresh')}`));
  assert.equal(decode(response.cookies.get(`${key}.0`).value), 'fresh');
  assert.equal(response.cookies.get(`${key}.0`).domain, '.dropxlogistics.com');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('x-middleware-rewrite'), rewrite ? `https://${host}${rewrite}` : null);
});
test('two successive portal requests use the current shared refresh token', async () => {
  let expected = 'token-1';
  const run = middleware(opts => ({ getClaims: async () => {
    assert.equal(opts.storage.getItem(key), expected);
    expected = expected === 'token-1' ? 'token-2' : 'token-3';
    opts.storage.setItem(key, expected);
    return { data: { claims: { sub: 'user-id' } } };
  } }));
  let cookie = `${key}.0=${encode(expected)}`;
  for (const host of ['ops.dropxlogistics.com','dashboard.dropxlogistics.com']) {
    const result = await run(new NextRequest(`https://${host}/payments/approvals`, { headers: { host, cookie } }));
    assert.equal(result.status, 200);
    cookie = `${key}.0=${result.cookies.get(`${key}.0`).value}`;
  }
  assert.equal(expected, 'token-3');
});
test('legacy Ops cookie migrates once; existing shared session always wins', async () => {
  for (const shared of [false,true]) {
    const run = middleware(opts => ({ getClaims: async () => {
      assert.equal(opts.storage.getItem(key), shared ? 'canonical' : 'legacy');
      return { data: { claims: { sub: 'user-id' } } };
    } }));
    const response = await run(new NextRequest('https://ops.dropxlogistics.com/payments/approvals', { headers: { host:'ops.dropxlogistics.com', cookie: `${LEGACY_OPS_AUTH_KEY}.0=${encode('legacy')}${shared ? `; ${key}.0=${encode('canonical')}` : ''}` } }));
    assert.equal(response.cookies.get(`${LEGACY_OPS_AUTH_KEY}.0`).maxAge, 0);
    const forwarded = response.headers.get('x-middleware-request-cookie');
    assert.ok(!forwarded.includes(LEGACY_OPS_AUTH_KEY));
    assert.ok(forwarded.includes(encode(shared ? 'canonical' : 'legacy')));
  }
});
test('temporary Auth failure is 503 with no logout or second refresh', async () => {
  const run = middleware(() => ({ getClaims: async () => ({ error: { status: 503 } }), getUser: async () => assert.fail('must not start overlapping refresh') }));
  const result = await run(new NextRequest('https://ops.dropxlogistics.com/payments/approvals', { headers: { host:'ops.dropxlogistics.com' } }));
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('location'), null);
});
test('missing/invalid session still redirects to login', async () => {
  const run = middleware(() => ({ getClaims: async () => ({ data:null }), getUser: async () => ({ data: { user:null }, error: { status:401 } }) }));
  const result = await run(new NextRequest('https://ops.dropxlogistics.com/payments/approvals', { headers: { host:'ops.dropxlogistics.com' } }));
  assert.match(result.headers.get('location'), /\/login\?next=/);
});
test('server action session checks distinguish backend failure from missing login', async () => {
  for (const error of [{ status:503 }, { status:429 }, { name:'AbortError' }, { name:'AuthRetryableFetchError' }]) {
    const { getSessionUser } = load('./session-user.ts', { '@/lib/supabase-server': { createServerSupabaseClient: () => ({ auth: { getClaims: async () => ({ error }) } }) } });
    await assert.rejects(getSessionUser(), SessionUnavailableError);
  }
  const { getSessionUser } = load('./session-user.ts', { '@/lib/supabase-server': { createServerSupabaseClient: () => ({ auth: { getClaims: async () => ({ error: { status:401 } }) } }) } });
  assert.equal(await getSessionUser(), null);
});
test('queue pagination retains old pending records and fails on partial results', async () => {
  const rows=Array.from({length:1201},(_,id)=>({id}));
  const ranges=[];
  const result=await readPaymentPages(async (from,to)=>{ranges.push([from,to]);return {data:rows.slice(from,to+1),error:null};});
  assert.equal(result.data.length,1201);
  assert.deepEqual(ranges,[[0,499],[500,999],[1000,1499]]);
  await assert.rejects(readPaymentPages(async from=>from===0?{data:rows.slice(0,500),error:null}:{data:null,error:{message:'temporarily unavailable'}}),/temporarily unavailable/);
});
test('queue filters keep legacy status fallback and resubmitted approvals',()=>{
  assert.match(approvalQueueCondition('pending'),/approval_status.is.null/);
  assert.doesNotMatch(approvalQueueCondition('pending'),/RESUBMITTED|RE_PENDING|OWNER_APPROVED/);
  assert.equal(approvalQueueCondition('all'),null);
  assert.equal(approvalQueueCondition('acted'),null);
  assert.match(approvalQueueCondition('returned'),/status.eq.returned/);
});
test('authorization database errors remain retryable; disabled accounts still denied', async () => {
  for (const mode of ['profile-error','company-error','inactive']) {
    const { getAuthorization } = load('./authorization.ts', {
      'next/cache': { unstable_cache: fn => fn },
      '@/lib/access-pages': { accessPages: [] },
      '@/lib/session-user': { getSessionUser: async () => ({id:'user',email:'user@example.com'}), loadSessionProfile: async () => ({ data: mode==='profile-error' ? null : {id:'user',company_id:'company',is_active:mode!=='inactive'}, error:mode==='profile-error'?{message:'network timeout'}:null }) },
      '@/lib/supabase-admin': { supabaseAdmin: {} },
      '@/lib/access-cutoff': { enforceAccessCutoffIfDue: async () => true },
      '@/lib/portal-preview': { getPreviewViewer: async () => null, selectedPreviewUserId: () => null },
      '@/lib/access-surface': { currentAdminAccessSurface: () => 'dashboard' },
      '@/lib/access-cache': { loadCompanyAccessRow: async () => { throw new Error('network failure'); } }
    });
    if(mode==='inactive') assert.equal(await getAuthorization(),null);
    else await assert.rejects(getAuthorization(),SessionUnavailableError);
  }
});
test('approval wrapper returns retryable session error without redirecting or saving', async()=>{
  const {handleApprovePaymentApproval}=load('../app/payments/approvals/actions.ts', {
    'next/cache': {revalidatePath:()=>assert.fail('must not invalidate on auth failure')},
    'next/navigation': {redirect:()=>assert.fail('must not navigate away on transient failure')},
    '@vercel/functions': {waitUntil:()=>assert.fail('must not send without saving')},
    '@/lib/authorization': {requirePagePermissionOrThrow:async()=>{throw new SessionUnavailableError();}}
  });
  const result=await handleApprovePaymentApproval(new FormData());
  assert.match(result.error,/not been signed out/);
});
test('two approval decisions save without waiting for SMTP; duplicate submission remains blocked', async()=>{
  const saved=[], logs=[], background=[], mailResolvers=[];
  const admin={from:table=>{
    let id, requestId, update, insert;
    const q={
      select:()=>q, eq:(field,value)=>{if(field==='id')id=value; if(field==='request_id')requestId=value; return q;},
      or:value=>{requestId=value.split('.eq.')[1]?.split(',')[0];return q;},
      update:value=>{update=value;return q;}, insert:value=>{insert=value;return q;},
      single:async()=>({data:{id,requested_by:'requester',location_id:'station',approval_cycle:1,current_step_order:1,current_approver_user_id:'owner'},error:null}),
      maybeSingle:async()=>({data:{code:'OWNER'},error:null}),
      then:resolve=>{
        if(update)saved.push({id,...update});
        if(insert)logs.push(insert);
        return Promise.resolve({data:[],error:null,count:logs.filter(row=>row.payment_request_id===requestId).length}).then(resolve);
      }
    };return q;
  }};
  const {approvePaymentRequest}=load('../app/payments/approvals/actions.ts',{
    'next/cache':{revalidatePath:()=>{}}, '@vercel/functions':{waitUntil:p=>background.push(p)},
    '@/lib/authorization':{requirePagePermissionOrThrow:async()=>({userId:'owner',roleCode:'OWNER',isMasterOwner:true,companyId:'company'})},
    '@/lib/company-scope':{requireCompanyId:()=> 'company',withCompany:(payload,company_id)=>({...payload,company_id})},
    '@/lib/payment-approval-scope':{canActOnPaymentRequest:async()=>true},
    '@/lib/supabase-admin':{supabaseAdmin:admin},
    '@/lib/payment-email-notifications':{sendPaymentNotification:()=>new Promise(resolve=>mailResolvers.push(resolve))}
  });
  for(const id of ['request-one','request-two']) {
    const form=new FormData();form.set('request_id',id);
    await Promise.race([approvePaymentRequest(form),new Promise((_,reject)=>setTimeout(()=>reject(new Error('decision blocked by mail')),250))]);
  }
  assert.equal(saved.length,2);assert.ok(saved.every(row=>row.status==='approved'));
  assert.equal(background.length,2);assert.equal(logs.length,2);
  const repeat=new FormData();repeat.set('request_id','request-one');
  await assert.rejects(approvePaymentRequest(repeat),/already acted/);
  assert.equal(saved.length,2);
  mailResolvers.forEach(resolve=>resolve({sent:true}));await Promise.all(background);
});
