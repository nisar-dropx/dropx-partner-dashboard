import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function fixture() {
  const account = {id:'gokul',companyId:'dropx',profileType:'employee',pageAccess:['advances']};
  const state = {account,eligible:true,calls:[],authError:null,upstreamError:null,missingEligibility:false,preview:false};
  const tables = {
    payment_advance_requests:[{id:'11111111-1111-1111-1111-111111111111',company_id:'dropx',account_id:'gokul',purpose:'Travel',amount:500,status:'submitted',requested_at:'2026-10-01T09:00:00.000Z',updated_at:'2026-10-01T09:00:00.000Z'},
      {id:'other',company_id:'other',account_id:'gokul',amount:999}],
    hr_pay_advance_requests:[{id:'payroll',request_number:'ADV-202610-00001',company_id:'dropx',worker_type:'employee',worker_id:'gokul',reason:'Pay',requested_amount:200,status:'pending',requested_at:'2026-10-01T09:00:00.000Z'}]
  };
  const db = {from(table) {
    let rows=tables[table]??[];
    const q={select(){return q},eq(key,value){rows=rows.filter(r=>r[key]===value);return q},order(){return q},limit(){return q},then(resolve,reject){return Promise.resolve({data:rows,error:null}).then(resolve,reject)}};
    return q;
  }};
  const mod={exports:{}};
  class NextResponse extends Response {static json(body,init){return Response.json(body,init)}}
  const mocks={
    'next/server':{NextResponse},
    'next/headers':{cookies:()=>({get:()=>state.preview?{value:'preview'}:undefined})},
    '../../../../src/lib/connect-preview-policy':{connectPreviewCookieName:'preview',previewReadOnlyMessage:'Preview is read-only'},
    '../../../../src/lib/own-advance-capacity':{loadOwnAdvanceCapacity:async(companyId,id)=>{state.calls.push({capacity:[companyId,id]});return {account:{eligibleForAdvance:true,outstandingPay:2000,committedAdvance:0,eligibilityPercent:25,maxEligibleAmount:500}}}},
    '@/lib/user-facing-error':{userFacingError:e=>e.message},
    '../../../../src/lib/connect-auth':{requireConnectAccount:async(type,id)=>{if(state.authError)throw Error(state.authError);assert.equal(id,account.id);assert.equal(type,account.profileType);return account}},
    '../../../../src/lib/connect-approval-journey':{loadApprovalJourneySteps:async()=>new Map()},
    '../../../../src/lib/supabase-admin':{supabaseAdmin:db}
  };
  const source=ts.transpileModule(fs.readFileSync(new URL('../../app/api/connect/advances/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const fetch=async(url,options)=>{
    state.calls.push({url:String(url),...options});
    if(state.upstreamError)return Response.json({error:state.upstreamError},{status:403});
    return Response.json(options.method==='GET' ? (state.missingEligibility?{}:{account:{eligibleForAdvance:state.eligible}}) : {ok:true},{status:options.method==='POST'?201:200});
  };
  new Function('require','module','exports','fetch',source)(id=>{assert.ok(id in mocks,id);return mocks[id]},mod,mod.exports,fetch);
  return {state,tables,...mod.exports};
}
const getRequest=()=>new Request('https://one.dropxlogistics.com/api/connect/advances?accountId=gokul&profileType=employee',{headers:{cookie:'dropx_connect_session=test-only'}});
const mutation=method=>new Request('https://one.dropxlogistics.com/api/connect/advances',{method,headers:{cookie:'dropx_connect_session=test-only','content-type':'application/json'},body:JSON.stringify({accountId:'gokul',profileType:'employee',amount:500,purpose:'Travel',requestId:'advance'})});

test('Workforce preview reads use authorized account scope, never administrator mobile cookies',async()=>{
  const f=fixture();f.state.account.profileType='workforce';f.state.preview=true;
  const response=await f.GET(new Request('https://one.example/api/connect/advances?accountId=gokul&profileType=workforce'));
  assert.equal(response.status,200);assert.equal((await response.json()).account.maxEligibleAmount,500);
  assert.deepEqual(f.state.calls,[{capacity:['dropx','gokul']}]);
});
test('preview cannot submit or withdraw even if actor and selected worker share a mobile',async()=>{
  const f=fixture();f.state.preview=true;
  assert.equal((await f.POST(mutation('POST'))).status,403);
  assert.equal((await f.PATCH(mutation('PATCH'))).status,403);
  assert.equal(f.state.calls.length,0);
});

test('active account is eligible; both advances screen and My Requests contracts survive',async()=>{
  const f=fixture();const response=await f.GET(getRequest());const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.account.eligibleForAdvance,true);
  assert.deepEqual(body.requests.map(r=>r.id),['11111111-1111-1111-1111-111111111111','payroll']);
  assert.equal(body.requests[0].purpose,'Travel');assert.equal(body.requests[0].title,'Travel');
  assert.equal(body.requests[0].reference,'ADV-1111111111');
  assert.equal(body.requests[1].reference,'ADV-202610-00001');
  assert.equal(body.requests[0].requested_at,body.requests[0].requestedAt);
  assert.equal(body.requests[0].canWithdraw,false);assert.equal(body.requests[1].canWithdraw,true);
  assert.equal(f.state.calls[0].cache,'no-store');assert.match(f.state.calls[0].url,/accountId=gokul/);
});
test('cutover duplicate is suppressed when the canonical payroll row lacks an external reference',async()=>{
  const f=fixture();
  Object.assign(f.tables.hr_pay_advance_requests[0],{reason:'Travel',requested_amount:500,external_source:null,external_reference:null});
  const response=await f.GET(getRequest());const body=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(body.requests.map(r=>r.id),['payroll']);
  assert.equal(body.requests[0].reference,'ADV-202610-00001');
});
test('inactive and missing eligibility are distinct and fail closed',async()=>{
  const f=fixture();f.state.eligible=false;
  assert.equal((await(await f.GET(getRequest())).json()).account.eligibleForAdvance,false);
  f.state.missingEligibility=true;
  const response=await f.GET(getRequest());assert.equal(response.status,400);
  assert.match((await response.json()).error,/verify advance eligibility/);
});
test('POST and PATCH preserve canonical validation, ownership, notifications and status',async()=>{
  for(const method of ['POST','PATCH']){
    const f=fixture();const response=await f[method](mutation(method));
    assert.equal(response.status,method==='POST'?201:200);
    assert.equal(f.state.calls[0].method,method);
    assert.equal(JSON.parse(f.state.calls[0].body).accountId,'gokul');
    assert.equal(f.state.calls[0].headers.cookie,'dropx_connect_session=test-only');
    f.state.upstreamError='Profile status is Active';
    assert.equal((await f[method](mutation(method))).status,403);
  }
});
test('unauthorized account or missing advance access never reaches mutation service',async()=>{
  for(const method of ['POST','PATCH']){
    const f=fixture();f.state.authError='Account unavailable';
    assert.equal((await f[method](mutation(method))).status,400);assert.equal(f.state.calls.length,0);
    f.state.authError=null;f.state.account.pageAccess=[];
    assert.equal((await f[method](mutation(method))).status,403);assert.equal(f.state.calls.length,0);
  }
});
test('client does not label failed/missing eligibility responses as inactive',()=>{
  const source=fs.readFileSync(new URL('../components/connect-advances.tsx',import.meta.url),'utf8');
  assert.match(source,/typeof payload.account\?\.eligibleForAdvance !== "boolean"/);
  assert.match(source,/!error && eligibleForAdvance === false/);
  assert.match(source,/setEligibleForAdvance\(null\)/);
});
test('advance cards show a request reference and keep details and lifecycle collapsed by default',()=>{
  const advances=fs.readFileSync(new URL('../components/connect-advances.tsx',import.meta.url),'utf8');
  const myRequests=fs.readFileSync(new URL('../components/connect-my-requests.tsx',import.meta.url),'utf8');
  assert.match(advances,/Request ID/);
  assert.match(advances,/Approval lifecycle/);
  assert.match(advances,/aria-expanded=\{expanded\}/);
  assert.match(myRequests,/dx-approval-reference/);
  assert.match(myRequests,/View details & lifecycle/);
  assert.match(myRequests,/dx-request-expanded-details/);
});
