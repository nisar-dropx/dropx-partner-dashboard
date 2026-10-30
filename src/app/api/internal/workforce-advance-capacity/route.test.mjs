import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';
const input={companyId:'11111111-1111-4111-8111-111111111111',workforceId:'22222222-2222-4222-8222-222222222222'};
const secret='test-only-secret';
function request(value=input,options={}){
  const body=JSON.stringify(value),timestamp=String(options.timestamp??Date.now());
  const signature=crypto.createHmac('sha256',secret).update(`${options.purpose??'dropx:workforce-advance-capacity:v1'}.${timestamp}.${body}`).digest('hex');
  return new Request('https://dashboard.example/api/internal/workforce-advance-capacity',{method:'POST',body:options.body??body,headers:{'x-dropx-time':timestamp,'x-dropx-signature':options.signature??signature}});
}
function fixture({found=true,active=true,error=false}={}){
  const calls=[],filters=[];
  const chain={};for(const method of ['select','eq','is','neq'])chain[method]=(...args)=>{filters.push([method,...args]);return chain};
  chain.maybeSingle=async()=>({data:found?{id:input.workforceId,is_active:active,onboarding_status:'active'}:null,error:null});
  const mocks={'node:crypto':crypto,'@/lib/supabase-admin':{supabaseAdmin:{from:()=>chain}},
    '@/lib/advance-eligibility':{isAdvanceEligible:({profileActive})=>profileActive},
    '@/lib/pay-advance-capacity':{loadPayAdvanceCapacity:async scope=>{calls.push(scope);if(error)throw Error('PRIVATE');return {outstandingPay:2000,committedAdvance:0,eligibilityPercent:25,maxEligibleAmount:500,breakdown:[]}}}};
  const exports={};const source=ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','exports','process',source)(id=>{assert.ok(mocks[id],id);return mocks[id]},exports,{env:{SUPABASE_SERVICE_ROLE_KEY:secret}});
  return {...exports,calls,filters};
}
test('authorized own/preview reads use canonical capacity and exact company/worker scope',async()=>{
  const f=fixture();const response=await f.POST(request());assert.equal(response.status,200);
  assert.equal((await response.json()).account.maxEligibleAmount,500);
  assert.deepEqual(f.calls,[{companyId:input.companyId,profileType:'workforce',accountId:input.workforceId}]);
  assert.ok(f.filters.some(x=>x[1]==='company_id'&&x[2]===input.companyId));
  assert.ok(f.filters.some(x=>x[1]==='id'&&x[2]===input.workforceId));
  assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('wrong-purpose, expired, forged and tampered requests cannot read capacity',async()=>{
  for(const options of [{signature:''},{signature:'0'.repeat(64)},{purpose:'dropx:workforce-advance-deduction:v1'},
    {timestamp:Date.now()-120000},{timestamp:Date.now()+120000},{body:JSON.stringify({...input,workforceId:input.companyId})}]){
    const f=fixture();assert.equal((await f.POST(request(input,options))).status,401);assert.equal(f.calls.length,0);assert.equal(f.filters.length,0);
  }
});
test('missing worker, invalid scope, inactive account and failed calculation are distinct',async()=>{
  assert.equal((await fixture({found:false}).POST(request())).status,404);
  assert.equal((await fixture().POST(request({...input,companyId:'wrong'}))).status,400);
  assert.equal((await (await fixture({active:false}).POST(request())).json()).account.eligibleForAdvance,false);
  const response=await fixture({error:true}).POST(request());assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/PRIVATE/);
});
