import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {NextRequest,NextResponse} from 'next/server.js';
process.env.NEXT_PUBLIC_SUPABASE_URL='https://routing-test.example';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='test-only';
function moduleAt(path, mocks) {
 const js=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod={exports:{}};
 new Function('require','module','exports',js)(id=>{assert.ok(id in mocks, id);return mocks[id];},mod,mod.exports);
 return mod.exports;
}
const sessionVerification=moduleAt('src/lib/session-verification.ts',{'./with-timeout':moduleAt('src/lib/with-timeout.ts',{})});
let signedIn=true, transientAuthFailures=0, claimsAvailable=true;
const js=ts.transpileModule(fs.readFileSync('src/middleware.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};
const mocks={
 'next/server':{NextRequest,NextResponse},
 '@supabase/supabase-js':{createClient:()=>({auth:{getUser:async()=>transientAuthFailures-- > 0?{data:{user:null},error:Object.assign(new Error('This operation was aborted'),{name:'AbortError'})}:{data:{user:signedIn?{id:'test-user'}:null},error:null},getClaims:async()=>({data:{claims:claimsAvailable?{sub:'test-user'}:null}})}})},
 '@/lib/people/surface':{isPeopleHostName:()=>false,isPeoplePortalPath:()=>false},
 '@/lib/finance/surface':{isFinanceHostName:()=>false,isFinancePortalPath:()=>false},
 '@/lib/provider-mapping-host':{providerMappingPageCodeForHost:()=>null},
 '@/lib/timeout-fetch':{timeoutFetch:()=>fetch},
 '@/lib/session-verification':sessionVerification,
 '@/lib/session-recovery':moduleAt('src/lib/session-recovery.ts',{})
};
new Function('require','module','exports',js)(id=>{assert.ok(id in mocks);return mocks[id];},mod,mod.exports);
const request=path=>new NextRequest('https://ops.dropxlogistics.com'+path,{headers:{host:'ops.dropxlogistics.com'}});
const settings=await mod.exports.middleware(request('/settings/notifications'));
assert.equal(settings.headers.get('location'),null);
assert.equal(settings.headers.get('x-middleware-next'),'1');
assert.equal(settings.headers.get('x-middleware-rewrite'),null,'settings uses its own route, not /ops-pulse');
for (const [path, target] of [['/audits', '/ops-pulse/audits'], ['/master/audits', '/ops-pulse/master/audits']]) {
  const result = await mod.exports.middleware(request(path));
  assert.equal(result.headers.get('location'), null, `${path} remains on the OpsPulse surface`);
  assert.match(result.headers.get('x-middleware-rewrite') ?? '', new RegExp(`${target}$`), `${path} rewrites to its OpsPulse page`);
}
const other=await mod.exports.middleware(request('/settings/payments'));
assert.match(other.headers.get('location'),/reason=surface/,'other portal settings stay blocked');
transientAuthFailures=1;
assert.equal((await mod.exports.middleware(request('/settings/notifications'))).headers.get('location'),null,'a signed session survives a transient Auth API error');
claimsAvailable=false;
transientAuthFailures=1;
assert.equal((await mod.exports.middleware(request('/settings/notifications'))).headers.get('location'),null,'a signed session survives when the claims fallback is unavailable but the bounded retry succeeds');
transientAuthFailures=2;
assert.equal((await mod.exports.middleware(request('/settings/notifications'))).status,503,'an unverified transient session gets a retryable response instead of a login redirect');
transientAuthFailures=1;
signedIn=false;
assert.match((await mod.exports.middleware(request('/settings/notifications'))).headers.get('location'),/login/,'a definitive missing session on retry still redirects to login');
transientAuthFailures=0;
claimsAvailable=true;
assert.match((await mod.exports.middleware(request('/settings/notifications'))).headers.get('location'),/login/,'settings still requires a session');
assert.equal((await mod.exports.middleware(request('/api/cron/portal-notifications'))).headers.get('x-middleware-next'),'1','cron reaches its secret-protected route without a session');
const route=fs.readFileSync('src/app/api/cron/portal-notifications/route.ts','utf8');
assert.match(route,/cronAuthorized\(request\)/);
assert.match(route,/isEddCronHost/);
console.log('Portal notification routing passed: exact settings path, session protection, other-settings isolation, secret-protected Ops-only cron.');
