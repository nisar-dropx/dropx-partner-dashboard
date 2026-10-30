import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { test } from 'node:test';
import { NextRequest, NextResponse } from 'next/server.js';
function moduleAt(path, mocks={}) {
 const js=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod={exports:{}};
 new Function('require','module','exports',js)(id=>{assert.ok(id in mocks,id);return mocks[id];},mod,mod.exports);
 return mod.exports;
}
const timeouts=moduleAt('src/lib/with-timeout.ts');
const {verifySession}=moduleAt('src/lib/session-verification.ts',{'./with-timeout':timeouts});
const recovery=moduleAt('src/lib/session-recovery.ts');
const timing={initialMs:5,claimsMs:5,totalMs:120};
const user={id:'verified-user',email:'test@example.invalid'};
const valid={data:{user},error:null};
const transient={data:{user:null},error:Object.assign(new Error('Aborted'),{name:'AbortError'})};
const missing={data:{user:null},error:{status:401,message:'Invalid token'}};
const delay=(ms,value)=>new Promise(resolve=>setTimeout(()=>resolve(value),ms));

test('a slow successful request is reused, without another user check',async()=>{
 let calls=0;
 const result=await verifySession({getUser:()=>{calls++;return delay(35,valid)},getClaims:async()=>({data:null})},timing);
 assert.equal(result.status,'verified');assert.equal(calls,1);
});
test('a completed transient failure gets one actual retry',async()=>{
 let calls=0;
 const result=await verifySession({getUser:async()=>++calls===1?transient:valid},timing);
 assert.equal(result.status,'verified');assert.equal(calls,2);
});
test('slow failure finishes before a fresh retry starts',async()=>{
 let calls=0,inflight=0,max=0;
 const result=await verifySession({getUser:async()=>{calls++;inflight++;max=Math.max(max,inflight);const result=await delay(15,calls===1?transient:valid);inflight--;return result;}},timing);
 assert.equal(result.status,'verified');assert.equal(calls,2);assert.equal(max,1);
});
test('verified claims can recover a transient user failure',async()=>{
 const result=await verifySession({getUser:async()=>transient,getClaims:async()=>({data:{claims:{sub:user.id,email:user.email}},error:null})},timing);
 assert.deepEqual(result,{status:'verified',user});
});
test('claims accompanied by verification errors cannot authorize',async()=>{
 const result=await verifySession({getUser:async()=>transient,getClaims:async()=>({data:{claims:{sub:user.id}},error:new Error('Invalid signature')})},timing);
 assert.equal(result.status,'unavailable');
});
test('an invalid session does not fall back to cached claims',async()=>{
 let claims=0;
 const result=await verifySession({getUser:async()=>missing,getClaims:async()=>{claims++;return {data:{claims:{sub:user.id}}}}},timing);
 assert.equal(result.status,'missing');assert.equal(claims,0);
});
test('a rejection arriving during claims verification wins',async()=>{
 const result=await verifySession({getUser:()=>delay(8,missing),getClaims:()=>delay(4,{data:{claims:{sub:user.id}}})},timing);
 assert.equal(result.status,'missing');
});
test('a stuck check ends within the total budget without queuing another check',async()=>{
 let calls=0;const started=Date.now();
 const result=await verifySession({getUser:()=>{calls++;return new Promise(()=>{})}}, {...timing,totalMs:35});
 assert.equal(result.status,'unavailable');assert.equal(calls,1);assert.ok(Date.now()-started<200);
});

process.env.NEXT_PUBLIC_SUPABASE_URL='https://session-test.example';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='test-only';
let authOutcome=valid;
const middleware=moduleAt('src/middleware.ts',{
 'next/server':{NextRequest,NextResponse},
 '@supabase/supabase-js':{createClient:(_url,_key,options)=>({auth:{getUser:async()=>{options.auth.storage.setItem('test-session','refreshed-value');return authOutcome;}}})},
 '@/lib/people/surface':{isPeopleHostName:()=>false,isPeoplePortalPath:()=>false},
 '@/lib/finance/surface':{isFinanceHostName:host=>host==='fin.dropxlogistics.com',isFinancePortalPath:()=>true},
 '@/lib/provider-mapping-host':{providerMappingPageCodeForHost:()=>null},
 '@/lib/timeout-fetch':{timeoutFetch:()=>fetch},
 '@/lib/session-verification':{verifySession:auth=>verifySession(auth,timing)},
 '@/lib/session-recovery':recovery
}).middleware;
const request=()=>new NextRequest('https://fin.dropxlogistics.com/finance/profitability?period=last-month',{headers:{host:'fin.dropxlogistics.com'}});
test('Finance forwards refreshed session cookies to the next handler and browser',async()=>{
 authOutcome=valid;const result=await middleware(request());
 assert.equal(result.headers.get('x-middleware-next'),'1');
 assert.match(result.headers.get('x-middleware-request-cookie'),/test-session.0=/);
 assert.ok(result.cookies.get('test-session.0').value);
 assert.equal(result.headers.get('Cache-Control'),'private, no-store');
});
test('login redirects keep refreshed cookies and the full return path',async()=>{
 authOutcome=missing;const result=await middleware(request());
 const url=new URL(result.headers.get('location'));
 assert.equal(url.pathname,'/login');assert.equal(url.searchParams.get('next'),'/finance/profitability?period=last-month');
 assert.ok(result.cookies.get('test-session.0').value);
});
test('unavailable Finance sessions fail closed with usable non-cacheable recovery',async()=>{
 authOutcome=transient;const result=await middleware(request());const html=await result.text();
 assert.equal(result.status,503);assert.match(result.headers.get('Content-Type'),/text\/html/);
 assert.equal(result.headers.get('Cache-Control'),'private, no-store');assert.equal(result.headers.get('Retry-After'),'5');
 assert.match(html,/Try again/);assert.match(html,/Open sign-in/);assert.match(html,/Finance · by DropX/);
 assert.ok(result.cookies.get('test-session.0').value);
});
test('recovery URL and branding cannot inject markup or external redirects',()=>{
 const html=recovery.sessionRecoveryHtml('/finance?x="/><script>alert(1)</script>','<Finance>');
 assert.doesNotMatch(html,/<script>|<Finance>/);assert.match(html,/&lt;Finance&gt;/);
 assert.doesNotMatch(recovery.sessionRecoveryHtml('//evil.example','Finance'),/href="\/\/evil/);
 assert.doesNotMatch(recovery.sessionRecoveryHtml('/\\evil.example','Finance'),/evil.example/);
});
