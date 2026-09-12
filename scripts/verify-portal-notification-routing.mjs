import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {NextRequest,NextResponse} from 'next/server.js';
process.env.NEXT_PUBLIC_SUPABASE_URL='https://routing-test.example';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='test-only';
let signedIn=true;
const js=ts.transpileModule(fs.readFileSync('src/middleware.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};
const mocks={
 'next/server':{NextRequest,NextResponse},
 '@supabase/supabase-js':{createClient:()=>({auth:{getUser:async()=>({data:{user:signedIn?{id:'test-user'}:null}})}})},
 '@/lib/people/surface':{isPeopleHostName:()=>false,isPeoplePortalPath:()=>false},
 '@/lib/timeout-fetch':{timeoutFetch:()=>fetch},
 '@/lib/with-timeout':{TimeoutError:class extends Error{},withTimeout:promise=>promise}
};
new Function('require','module','exports',js)(id=>{assert.ok(id in mocks);return mocks[id];},mod,mod.exports);
const request=path=>new NextRequest('https://ops.dropxlogistics.com'+path,{headers:{host:'ops.dropxlogistics.com'}});
const settings=await mod.exports.middleware(request('/settings/notifications'));
assert.equal(settings.headers.get('location'),null);
assert.equal(settings.headers.get('x-middleware-next'),'1');
assert.equal(settings.headers.get('x-middleware-rewrite'),null,'settings uses its own route, not /ops-pulse');
const other=await mod.exports.middleware(request('/settings/payments'));
assert.match(other.headers.get('location'),/reason=surface/,'other portal settings stay blocked');
signedIn=false;
assert.match((await mod.exports.middleware(request('/settings/notifications'))).headers.get('location'),/login/,'settings still requires a session');
assert.equal((await mod.exports.middleware(request('/api/cron/portal-notifications'))).headers.get('x-middleware-next'),'1','cron reaches its secret-protected route without a session');
const route=fs.readFileSync('src/app/api/cron/portal-notifications/route.ts','utf8');
assert.match(route,/cronAuthorized\(request\)/);
assert.match(route,/isEddCronHost/);
console.log('Portal notification routing passed: exact settings path, session protection, other-settings isolation, secret-protected Ops-only cron.');
