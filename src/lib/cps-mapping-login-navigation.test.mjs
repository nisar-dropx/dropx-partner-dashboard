import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function load(path, deps={}) {
 const module={exports:{}};
 new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{if(id in deps)return deps[id];throw Error(id)},module.exports,module);
 return module.exports;
}
const {safeOpsNextPath}=load('./ops-pulse/auth.ts',{'@/lib/connect-otp':{},'@/lib/access-surface':{},'@/lib/supabase-admin':{}});
const destination='/provider-id-mapping?q=AM1&station=A%20%26%20B&month=2026-09&mapping=all';
function redirect(url){return {location:String(url),cookies:{values:[],set(...args){this.values.push(args)}}};}
function transfer({next=destination,sessionError=null,validToken=true}={}) {
 let verified=false,sessionSet=false;
 const route=load('../app/auth/ops-transfer/route.ts',{
  'next/server':{NextResponse:{redirect}},
  '@/lib/ops-pulse/auth':{safeOpsNextPath},
  '@/lib/ops-auth-transfer':{readOpsAuthTransfer:()=>{verified=true;if(!validToken)throw Error('Invalid transfer');return {access_token:'test',refresh_token:'test'}}},
  '@/lib/supabase-server':{createServerSupabaseClient:()=>({auth:{setSession:async()=>{sessionSet=true;return {data:{session:sessionError?null:{}},error:sessionError}}}})}
 });
 const url='https://ops.dropxlogistics.com/auth/ops-transfer?token=test';
 return {run:()=>route.GET({url,nextUrl:new URL(url),cookies:{get:()=>({value:next})}}),verified:()=>verified,sessionSet:()=>sessionSet};
}
test('successful verified login returns to the exact CPS mapping record and consumes the destination cookie',async()=>{
 const t=transfer(),response=await t.run();
 assert.equal(t.verified(),true);assert.equal(t.sessionSet(),true);
 assert.equal(response.location,'https://ops.dropxlogistics.com'+destination);
 assert.ok(response.cookies.values.some(([name,value,options])=>name==='dropx_ops_auth_next'&&value===''&&options.maxAge===0&&!options.domain));
});
test('a failed session transfer preserves the destination for retry and never authenticates the request',async()=>{
 const response=await transfer({sessionError:Error('Database unavailable')}).run();
 const url=new URL(response.location);
 assert.equal(url.pathname,'/login');assert.equal(url.searchParams.get('next'),destination);
 assert.equal(url.searchParams.get('error'),'Database unavailable');
 assert.equal(response.cookies.values.length,0);
 const bad=transfer({validToken:false});await bad.run();assert.equal(bad.sessionSet(),false);
});
test('missing or unsafe return destinations cannot escape OpsPulse',async()=>{
 for(const next of ['', 'https://example.com', '//example.com', '/login', '/\\example.com']) {
  const result=await transfer({next}).run();assert.equal(new URL(result.location).origin,'https://ops.dropxlogistics.com');
 }
});
function signIn(unreachable=null) {
 const writes=[];let options;
 const module=load('../app/login/actions.ts',{
  'next/headers':{headers:()=>new Headers({origin:'https://ops.dropxlogistics.com'}),cookies:()=>({set:(...args)=>writes.push(args)})},
  'next/navigation':{redirect:url=>{throw Object.assign(Error('redirect'),{url})}},
  '@/lib/auth-reachable':{authUnreachableMessage:async()=>unreachable},
  '@/lib/supabase-server':{createServerSupabaseClient:()=>({auth:{signInWithOAuth:async input=>{options=input;return {data:{url:'https://auth.example.com/oauth'},error:null}}}})}
 });
 const form=new FormData();form.set('next',destination);
 return {run:()=>module.signInWithGoogle(form),writes,options:()=>options};
}
test('Ops Google login retains a short-lived host-only destination without changing the existing callback',async()=>{
 const login=signIn();await assert.rejects(login.run(),e=>e.url==='https://auth.example.com/oauth');
 const [,value,settings]=login.writes.find(([key])=>key==='dropx_ops_auth_next');
 assert.equal(value,destination);assert.equal(settings.httpOnly,true);assert.equal(settings.secure,true);assert.equal(settings.domain,undefined);assert.equal(settings.maxAge,600);
 assert.equal(login.options().options.redirectTo,'https://dashboard.dropxlogistics.com/auth/callback');
});
test('an unavailable authentication service keeps the selected ID and month on the retry screen',async()=>{
 const login=signIn('The database is not reachable right now.');
 await assert.rejects(login.run(),e=>{const url=new URL(e.url,'https://ops.dropxlogistics.com');return url.pathname==='/login'&&url.searchParams.get('next')===destination&&url.searchParams.get('error').includes('not reachable')});
});
test('middleware preserves query filters at both genuine signed-out redirects',()=>{
 const source=readFileSync(new URL('../middleware.ts',import.meta.url),'utf8');
 assert.equal((source.match(/loginUrl.searchParams.set\("next", request.nextUrl.pathname \+ request.nextUrl.search\)/g)||[]).length,2);
 assert.ok(source.includes('return unavailableSessionResponse()'),'Transient failures remain retryable, not a sign-out');
});
