import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadPayoutMappingRevisionState } from './payout-mapping-relocks.ts';
import * as policy from './connect-preview-policy.ts';
import * as signing from './connect-preview-cookie.ts';
const company='11111111-1111-1111-1111-111111111111';
const target={companyId:company,profileType:'workforce',id:'22222222-2222-2222-2222-222222222222'};
function load(file,mocks){const mod={exports:{}};const code=ts.transpileModule(fs.readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(id=>{assert.ok(id in mocks,`Unmocked ${id}`);return mocks[id]},mod,mod.exports);return mod.exports;}
function fixture({owner=true,role='admin',designation=null,expired=false,revoked=false,preview=null,otherCompany=false}={}){
 const jar=new Map([['dropx_connect_session','private-session-token']]);if(preview)jar.set(policy.connectPreviewCookieName,preview);
 const own={companyId:company,profileType:'employee',id:'actor',designationCode:designation};
 const selected={...target,name:'DA test',onboardingBeta:false,pageAccess:['dashboard','payments'],activationOnly:false};
 const tables={connect_login_sessions:[{id:'session',country_code:'91',mobile_number:'911234567890',expires_at:new Date(Date.now()+(expired?-1000:86400000)).toISOString(),revoked_at:revoked?'now':null,session_hash:createHash('sha256').update('private-session-token').digest('hex')}],profiles:[{id:'actor',company_id:company,is_active:true,is_master_owner:owner,role_id:'role',mobile:'1234567890',mobile_country_code:'91'}],user_roles:[{id:'role',company_id:company,code:role,is_active:true}],workforce:[{id:target.id,company_id:otherCompany?'33333333-3333-3333-3333-333333333333':company,is_active:true,mobile:'9999999999',mobile_country_code:'91',deleted_at:null}]};
 const db={from(table){let rows=[...(tables[table]||[])],single=false;const q={select(){return q},eq(k,v){rows=rows.filter(r=>r[k]===v);return q},in(k,vs){rows=rows.filter(r=>vs.includes(r[k]));return q},is(k,v){rows=rows.filter(r=>(r[k]??null)===v);return q},or(){return q},order(){return q},limit(){return q},maybeSingle(){single=true;return q},then(resolve,reject){return Promise.resolve({data:single?rows[0]??null:rows,error:null}).then(resolve,reject)}};return q}};
 const api=load('./connect-preview.ts',{'server-only':{},crypto:{createHash},'next/headers':{cookies:()=>({get:k=>jar.has(k)?{value:jar.get(k)}:undefined})},react:{cache:f=>f},'./supabase-admin':{supabaseAdmin:db},'./connect-auth':{connectSessionCookieName:'dropx_connect_session',findConnectPreviewAccounts:async(_c,m)=>m==='911234567890'?[own]:[selected,{...selected,id:'different-role',profileType:'contractor'}]},'./connect-preview-policy':policy,'./connect-preview-cookie':signing});
 return {...api,jar,tables,selected};
}
test('eligibility is limited to owner, Tech and active FSD/Finance Manager designation codes',()=>{
 for(const input of [[true,null,null],[false,'OWNER',null],[false,'TECH',null],[false,null,'FSD'],[false,null,'FINMGR']])assert.equal(policy.previewRoleAllowed(...input),true);
 for(const input of [[false,'admin',null],[false,'HR',null],[false,'FINANCE_HEAD',null],[false,'OPERATIONS_TECH',null],[false,null,'DA']])assert.equal(policy.previewRoleAllowed(...input),false);
});
test('signed preview expires, rejects tampering and is bound to original session',()=>{
 const signed=signing.signPreview(target,'token',1000);assert.deepEqual({...signing.readPreview(signed,'token',2000),expiresAt:undefined},{...target,expiresAt:undefined});
 assert.equal(signing.readPreview(signed,'other',2000),null);assert.equal(signing.readPreview(signed+'bad','token',2000),null);assert.equal(signing.readPreview(signed,'token',3601000),null);
 assert.equal(signing.readPreview(signing.signPreview({...target,profileType:'__proto__'},'token',1000),'token',2000),null);
});
test('actor authorization uses original session and denies expired/revoked/ordinary accounts',async()=>{
 for(const options of [{expired:true},{revoked:true}])assert.equal(await fixture(options).getConnectPreviewActor(),null);
 assert.deepEqual((await fixture({owner:false}).getConnectPreviewActor()).companyIds,[]);
 for(const options of [{},{owner:false,role:'TECH'},{owner:false,designation:'FINMGR'}])assert.deepEqual((await fixture(options).getConnectPreviewActor()).companyIds,[company]);
});
test('target resolution preserves profile type, denies cross-company and inactive targets, and excludes beta',async()=>{
 const f=fixture();const actor=await f.getConnectPreviewActor();const account=await f.loadPreviewAccount(target,actor);
 assert.equal(account.id,target.id);assert.equal(account.profileType,'workforce');assert.equal(account.readOnlyPreview,true);assert.equal(account.activationOnly,false);
 await assert.rejects(f.loadPreviewAccount({...target,companyId:'33333333-3333-3333-3333-333333333333'},actor));
 f.tables.workforce[0].is_active=false;await assert.rejects(f.loadPreviewAccount(target,actor));f.tables.workforce[0].is_active=true;
 f.selected.onboardingBeta=true;await assert.rejects(f.loadPreviewAccount(target,actor));
});
test('every preview request rechecks the actor and target; no preview leaves normal resolution alone',async()=>{
 const signed=signing.signPreview(target,'private-session-token');
 const f=fixture({preview:signed});assert.equal((await f.resolveConnectPreview()).id,target.id);
 f.tables.profiles[0].is_master_owner=false;await assert.rejects(f.resolveConnectPreview());
 assert.equal(await fixture().resolveConnectPreview(),null);
 await assert.rejects(fixture({preview:'forged'}).resolveConnectPreview());
});
test('middleware denies every write including uploads, approvals, device tokens and worker actions',()=>{
 for(const path of ['/api/connect/attendance/punch','/api/connect/notifications','/api/connect/profile','/api/connect/advances','/api/connect/workforce-joining','/api/connect/preferences','/api/connect/auth/set-pin'])for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal(policy.blocksPreviewMutation(method,path,true),true);
 assert.equal(policy.blocksPreviewMutation('GET','/api/connect/earnings',true),false);
 assert.equal(policy.blocksPreviewMutation('POST','/api/connect/preview',true),false);
 assert.equal(policy.blocksPreviewMutation('DELETE','/api/connect/auth/session',true),false);
 assert.equal(policy.blocksPreviewMutation('POST','/api/connect/attendance/punch',false),false);
});
test('database guard blocks GET-side mutations and unreviewed RPCs, permits reads and signed downloads',async()=>{
 let active=true;const calls=[];
 const {previewSafeFetch}=load('./connect-preview-fetch.ts',{'next/headers':{cookies:()=>({get:()=>active?{value:'preview'}:null})},'./connect-preview-policy':policy});
 const fetch=previewSafeFetch(async(...args)=>{calls.push(args);return new Response('{}')});
 for(const [path,method] of [['/rest/v1/workforce','PATCH'],['/auth/v1/admin/users','POST'],['/rest/v1/rpc/unknown','POST'],['/storage/v1/object/documents/file','POST']])assert.equal((await fetch('https://example.com'+path,{method})).status,403);
 assert.equal(calls.length,0);
 for(const [path,method] of [['/rest/v1/workforce','GET'],['/storage/v1/object/sign/documents/file','POST']])assert.equal((await fetch('https://example.com'+path,{method})).status,200);
 active=false;assert.equal((await fetch('https://example.com/rest/v1/workforce',{method:'PATCH'})).status,200);assert.equal(calls.length,3);
});
test('preview API requires same-origin POST, rejects unauthorized/cross-company picks, and exits without a target write',async()=>{
 const writes=[];let eligible=true;const cookies={set:(...args)=>writes.push(args)};
 const api=load('../../app/api/connect/preview/route.ts',{'next/headers':{cookies:()=>cookies},'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},'@/lib/connect-preview':{getConnectPreviewActor:async()=>eligible?{companyIds:[company],sessionId:'actor',token:'token'}:null,loadPreviewAccount:async(t,a)=>{assert.ok(a.companyIds.includes(t.companyId));return t},previewNoStore:{'Cache-Control':'private, no-store'},searchConnectPreviewUsers:async()=>[]},'@/lib/connect-preview-policy':policy,'@/lib/connect-preview-cookie':signing});
 const req=(body,origin='https://one.example')=>{const r=new Request('https://one.example/api/connect/preview',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});r.nextUrl=new URL(r.url);return r};
 assert.equal((await api.POST(req(target,'https://evil.example'))).status,403);assert.equal(writes.length,0);
 eligible=false;assert.equal((await api.POST(req(target))).status,403);assert.equal(writes.length,0);
 eligible=true;assert.equal((await api.POST(req({...target,companyId:'33333333-3333-3333-3333-333333333333'}))).status,403);assert.equal(writes.length,0);
 assert.equal((await api.POST(req(target))).status,200);assert.equal(writes.length,1);assert.equal(writes[0][2].httpOnly,true);assert.equal(writes[0][2].sameSite,'strict');
 eligible=false;assert.equal((await api.POST(req({exit:true}))).status,200);assert.equal(writes[1][2].maxAge,0);
});

test('payout mapping lookup uses a real Supabase GET in preview and normal mode without enabling writes', async () => {
 let active = true;
 const calls = [];
 const {previewSafeFetch} = load('./connect-preview-fetch.ts', {
  'next/headers': {cookies: () => ({get: () => active ? {value: 'preview'} : null})},
  './connect-preview-policy': policy,
 });
 const fetch = previewSafeFetch(async (input, init) => {
  calls.push({url: new URL(String(input)), method: init.method});
  return Response.json([]);
 });
 const db = createClient('https://example.supabase.co', 'test-only-key', {
  global: {fetch}, auth: {persistSession: false, autoRefreshToken: false},
 });
 for (const preview of [true, false]) {
  active = preview;
  const state = await loadPayoutMappingRevisionState(db, company, target.id);
  assert.equal(state.openPeriodKeys.size, 0);
  const call = calls.at(-1);
  assert.equal(call.method, 'GET');
  assert.equal(call.url.pathname, '/rest/v1/rpc/workforce_payout_mapping_revision_state');
  assert.equal(call.url.searchParams.get('p_company_id'), company);
  assert.equal(call.url.searchParams.get('p_workforce_id'), target.id);
 }
 active = true;
 const count = calls.length;
 const mutation = await db.rpc('workforce_raise_payout_dispute', {p_company: company});
 assert.equal(mutation.status, 403);
 assert.equal(mutation.error.code, 'read_only_preview');
 assert.equal(calls.length, count, 'no mutation reaches the database');
});
