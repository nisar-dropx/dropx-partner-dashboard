import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { payAdvanceApprovalPayContext, payAdvanceDecision, payAdvanceFinanceTerms } from './connect-pay-advance-approval.ts';

function fixture() {
  const state = { actors:['actor-a'], visible:['actor-a'], rpcCalls:[], reads:[], error:null,
    hr_pay_advance_steps:[{id:'step-a',company_id:'company-a',request_id:'request-a',approver_user_id:'actor-a',status:'pending',step_name:'Reporting manager',step_type:'manager'},
      {id:'step-b',company_id:'company-b',request_id:'request-b',approver_user_id:'actor-a',status:'pending',step_name:'Reporting manager',step_type:'manager'},
      {id:'step-c',company_id:'company-a',request_id:'request-c',approver_user_id:'other-actor',status:'pending',step_name:'Reporting manager',step_type:'manager'}],
    hr_pay_advance_requests:[
      {id:'request-a',company_id:'company-a',status:'pending',request_number:'ADV001',worker_type:'workforce',worker_name:'Test Person',worker_code:'W1',requested_amount:2000,outstanding_pay_snapshot:12000,eligibility_percent_snapshot:25,max_eligible_amount_snapshot:3000,recovery_mode:'one_time',requested_installments:1,reason:'Test request'},
      {id:'request-c',company_id:'company-a',status:'pending',request_number:'ADV003',worker_type:'employee',worker_name:'Team Member',worker_code:'E1',requested_amount:1000,outstanding_pay_snapshot:8000,eligibility_percent_snapshot:25,max_eligible_amount_snapshot:2000,recovery_mode:'one_time',requested_installments:1,reason:'Team advance'}
    ] };
  const db = { from(table) {
    state.reads.push(table);
    let rows = state[table] ?? [];
    const query = {select(){return query},eq(key,value){rows=rows.filter(row=>row[key]===value);return query},in(key,values){rows=rows.filter(row=>values.includes(row[key]));return query},order(){return query},limit(n){rows=rows.slice(0,n);return query},range(from,to){rows=rows.slice(from,to+1);return query},
      maybeSingle(){return Promise.resolve({data:state.error?null:rows[0]??null,error:state.error})},then(resolve,reject){return Promise.resolve({data:state.error?null:rows,error:state.error}).then(resolve,reject)}};
    return query;
  }, async rpc(name,args){if(name==='pay_advance_worker_summary') return {data:{monthPaidCount:2,monthPaidAmount:3000,outstandingAdvance:1200,reservedRecovery:800},error:state.error};state.rpcCalls.push({name,args});return {data:'pending',error:state.error}} };
  const mod={exports:{}};
  const source=ts.transpileModule(fs.readFileSync(new URL('./connect-pay-advance-approval-data.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mocks={'./connect-advance-context':{loadCurrentAdvanceCapacity:async()=>({outstandingPay:12000,maxEligibleAmount:state.liveMaximum??3000,committedAdvance:0,eligibilityPercent:25,breakdown:[{month:'2026-09',outstanding:4000},{month:'2026-10',outstanding:8000}]})},'server-only':{},'./connect-approver-identity':{
    resolveConnectActorUserIds:async()=>state.actors,
    resolveConnectVisibleApproverUserIds:async()=>state.visible,
    adoptPendingStepForHigherManager:async({parentId})=>{
      const step=(state.hr_pay_advance_steps??[]).find(row=>row.request_id===parentId&&row.status==='pending');
      if(!step||!state.actors.length) return;
      if(state.actors.includes(step.approver_user_id)) return;
      if(!(state.visible??[]).includes(step.approver_user_id)) return;
      step.approver_user_id=state.actors[0];
      state.adopted=true;
    }
  },'./connect-pay-advance-approval':{payAdvanceApprovalPayContext,payAdvanceDecision,payAdvanceFinanceTerms},'./supabase-admin':{supabaseAdmin:db}};
  new Function('require','module','exports',source)(id=>{assert.ok(id in mocks,id);return mocks[id]},mod,mod.exports);
  return {state,...mod.exports};
}
const account={companyId:'company-a',id:'account-a',profileType:'employee'};
test('pay advances are scoped to the authenticated company and pending assigned actor',async()=>{
  const f=fixture();
  const rows=await f.listConnectPayAdvanceApprovals(account);
  assert.deepEqual(rows.map(row=>row.requestId),['request-a']);
  assert.equal(rows[0].requestedAmount,2000);
  assert.equal(rows[0].outstandingPay,12000);
  assert.equal(rows[0].maxEligibleAmount,3000);
  assert.equal(rows[0].eligibilityWithinLimit,true);
  for(const id of ['request-b','request-c','unknown']) await assert.rejects(f.decideConnectPayAdvanceApproval(account,id,'approved',''),/assigned/);
  assert.equal(f.state.rpcCalls.length,0);
  await f.decideConnectPayAdvanceApproval(account,'request-a','approved','Reviewed',1500,1);
  assert.deepEqual(f.state.rpcCalls[0],{name:'hr_decide_pay_advance_step',args:{p_company_id:'company-a',p_request_id:'request-a',p_actor_user_id:'actor-a',p_decision:'approved',p_note:'Reviewed',p_approved_amount:1500,p_approved_installments:1}});
});
test('removed assignment and database failures never call the decision RPC',async()=>{
  const f=fixture(); f.state.hr_pay_advance_steps[0].status='approved';
  await assert.rejects(f.decideConnectPayAdvanceApproval(account,'request-a','approved',''),/no longer pending/);
  f.state.error={message:'Database unavailable'};
  await assert.rejects(f.decideConnectPayAdvanceApproval(account,'request-a','approved',''),/Database unavailable/);
  assert.equal(f.state.rpcCalls.length,0);
});
test('unlinked accounts have no pay-advance approvals',async()=>{
  const f=fixture(); f.state.actors=[];
  assert.deepEqual(await f.listConnectPayAdvanceApprovals(account),[]);
  await assert.rejects(f.decideConnectPayAdvanceApproval(account,'request-a','approved',''),/not assigned/);
});

test('assigned People approvers see live pay and previous advance balances',async()=>{
  const f=fixture(); f.state.hr_pay_advance_requests[0].worker_type='employee';
  const [row]=await f.listConnectPayAdvanceApprovals(account);
  assert.equal(row.outstandingPay,12000);
  assert.equal(row.monthPaidCount,2);
  assert.equal(row.monthPaidAmount,3000);
  assert.equal(row.outstandingAdvance,1200);
  assert.equal(row.maxEligibleAmount,3000);
  assert.equal(row.eligibilityPercent,25);
  assert.equal(row.eligibilityWithinLimit,true);
});

test('Finance approval may adjust above the request but never above the eligibility cap',async()=>{
  const f=fixture(); f.state.hr_pay_advance_steps[0].step_type='finance';
  for(const [amount,installments] of [[null,1],[3001,1],[-1,1],[1500,0],[1500,13],[1500,1.5]]) await assert.rejects(f.decideConnectPayAdvanceApproval(account,'request-a','approved','',amount,installments));
  assert.equal(f.state.rpcCalls.length,0);
  await f.decideConnectPayAdvanceApproval(account,'request-a','approved','',2500,2);
  assert.equal(f.state.rpcCalls[0].args.p_approved_amount,2500);
  assert.equal(f.state.rpcCalls[0].args.p_approved_installments,2);
});
test('operational manager may reduce but cannot increase the requested amount',async()=>{
  const f=fixture(); f.state.hr_pay_advance_steps[0].step_type='manager';
  await assert.rejects(f.decideConnectPayAdvanceApproval(account,'request-a','approved','',2001,1),/25% outstanding-pay limit/);
  await f.decideConnectPayAdvanceApproval(account,'request-a','approved','',1500,1);
  assert.equal(f.state.rpcCalls[0].args.p_approved_amount,1500);
});

test('team advances waiting with reportees appear only in All-team and stay actionable',async()=>{
  const f=fixture();
  f.state.visible=['actor-a','other-actor'];
  assert.deepEqual((await f.listConnectPayAdvanceApprovals(account)).map(row=>row.requestId),['request-a']);
  const oversight=await f.listConnectPayAdvanceOversight(account);
  assert.deepEqual(oversight.map(row=>row.requestId),['request-c']);
  await f.decideConnectPayAdvanceApproval(account,'request-c','returned','Talk to CM');
  assert.equal(f.state.adopted,true);
  assert.equal(f.state.rpcCalls[0].args.p_request_id,'request-c');
  assert.equal(f.state.rpcCalls[0].args.p_decision,'returned');
});

test('approval rechecks current capacity instead of relying on the request snapshot',async()=>{
  const f=fixture();f.state.liveMaximum=800;
  await assert.rejects(f.decideConnectPayAdvanceApproval(account,'request-a','approved','',1000,1),/outstanding-pay limit/);
  assert.equal(f.state.rpcCalls.length,0);
});

function reviewFixture(){
  const f=fixture();
  Object.assign(f.state.hr_pay_advance_requests[0],{worker_id:'worker-a',requested_by:'submitter',requested_at:'2026-10-20T10:00:00Z'});
  f.state.hr_pay_advance_steps.unshift({id:'earlier',company_id:'company-a',request_id:'request-a',step_order:1,step_name:'Head Operations approval',status:'approved',approver_user_id:'head',approved_amount:2000,decided_at:'2026-10-21T10:00:00Z',decision_note:'Reviewed'});
  f.state.profiles=[{id:'head',company_id:'company-a',full_name:'Earlier manager'},{id:'submitter',company_id:'company-a',full_name:'Applicant'}];
  f.state.pay_advances=[{id:'paid-a',company_id:'company-a',worker_type:'workforce',worker_id:'worker-a',amount:5000,paid_at:'2026-10-01T10:00:00Z',first_due_period:'2026-10-01',installments:1,evidence_type:'bank_confirmed',bank_reference:'UTR-123',provenance:{advance_number:'ADV-PAID'}},
    {id:'other-company',company_id:'company-b',worker_type:'workforce',worker_id:'worker-a',amount:9000},
    {id:'other-worker',company_id:'company-a',worker_type:'workforce',worker_id:'worker-b',amount:9000}];
  f.state.pay_advance_deductions=[{id:'confirmed',company_id:'company-a',advance_id:'paid-a',period_start:'2026-10-01',amount:1000,status:'confirmed',target_kind:'workforce'},
    {id:'reserved',company_id:'company-a',advance_id:'paid-a',period_start:'2026-10-01',amount:500,status:'reserved',target_kind:'workforce'},
    {id:'reversed',company_id:'company-a',advance_id:'paid-a',period_start:'2026-10-01',amount:400,status:'reversed',target_kind:'workforce'},
    {id:'foreign',company_id:'company-b',advance_id:'paid-a',amount:9999,status:'confirmed'}];
  return f;
}

test('expanded review shows real approval, period and paid history; reservations are still outstanding',async()=>{
  const f=reviewFixture();
  const result=await f.loadConnectPayAdvanceReviewDetails(account,'request-a');
  assert.equal(result.submittedBy,'Applicant');
  assert.equal(result.steps[0].actorName,'Earlier manager');
  assert.equal(result.steps[0].approvedAmount,2000);
  assert.deepEqual(result.capacity.breakdown,[{month:'2026-09',outstanding:4000},{month:'2026-10',outstanding:8000}]);
  assert.equal(result.requestLimit,2000,'Managers cannot increase the requested amount');
  assert.equal(result.advances.length,1);
  assert.equal(result.advances[0].recovered,1000);
  assert.equal(result.advances[0].reserved,500);
  assert.equal(result.advances[0].outstanding,4000);
  assert.deepEqual(result.advances[0].deductions.map(d=>d.id),['confirmed','reserved','reversed']);
  assert.equal(f.state.rpcCalls.length,0,'Viewing history must not change approval or payment state');
  f.state.hr_pay_advance_steps.find(s=>s.id==='step-a').step_type='finance';
  assert.equal((await f.loadConnectPayAdvanceReviewDetails(account,'request-a')).requestLimit,3000,'Finance may use the original eligibility limit');
});

test('expanded review denies unrelated, cross-company and completed requests before reading paid history',async()=>{
  for(const id of ['request-b','request-c','missing']){
    const f=reviewFixture();
    await assert.rejects(f.loadConnectPayAdvanceReviewDetails(account,id),/assigned/);
    assert.ok(!f.state.reads.includes('pay_advances'));
  }
  const f=reviewFixture();f.state.hr_pay_advance_requests[0].status='approved';
  await assert.rejects(f.loadConnectPayAdvanceReviewDetails(account,'request-a'),/no longer pending/);
  assert.ok(!f.state.reads.includes('pay_advances'));
});

test('reporting-line oversight can expand history without adopting the step',async()=>{
  const f=reviewFixture(); f.state.actors=['higher']; f.state.visible=['higher','actor-a'];
  await f.loadConnectPayAdvanceReviewDetails(account,'request-a');
  assert.equal(f.state.adopted,undefined);
  assert.equal(f.state.rpcCalls.length,0);
});

test('expanded review reads recovery history beyond the first page and preserves empty history',async()=>{
  const f=reviewFixture();
  f.state.pay_advance_deductions=Array.from({length:501},(_,i)=>({id:`recovery-${i}`,company_id:'company-a',advance_id:'paid-a',period_start:'2026-10-01',amount:1,status:'confirmed',target_kind:'workforce'}));
  const result=await f.loadConnectPayAdvanceReviewDetails(account,'request-a');
  assert.equal(result.advances[0].recovered,501);
  assert.equal(result.advances[0].deductions.length,501);
  f.state.pay_advances=[];
  assert.deepEqual((await f.loadConnectPayAdvanceReviewDetails(account,'request-a')).advances,[]);
});

test('review endpoint authenticates the selected account before loading financial details',async()=>{
  const mod={exports:{}};const calls=[];
  const source=ts.transpileModule(fs.readFileSync(new URL('../../app/api/connect/approvals/pay-advance/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mocks={'@/lib/connect-auth':{requireConnectAccount:async()=>{throw Error('Session required')}},
    '@/lib/connect-pay-advance-approval-data':{loadConnectPayAdvanceReviewDetails:async()=>calls.push('loaded')},
    '@/lib/user-facing-error':{userFacingError:(_error,fallback)=>fallback}};
  new Function('require','module','exports',source)(name=>mocks[name],mod,mod.exports);
  const r=await mod.exports.GET(new Request('https://one.example/api/connect/approvals/pay-advance?profileType=employee&accountId=another-person&requestId=private-request'));
  assert.equal(r.status,403);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.deepEqual(calls,[]);
  const invalid=await mod.exports.GET(new Request('https://one.example/api/connect/approvals/pay-advance?profileType=workforce&accountId=x&requestId=y'));
  assert.equal(invalid.status,400);
});

test('review presentation distinguishes prior approval, unpaid payroll periods and paid recovery history',async()=>{
  const f=reviewFixture(); const details=await f.loadConnectPayAdvanceReviewDetails(account,'request-a');
  const require=createRequire(import.meta.url), React=require('react'), {renderToStaticMarkup}=require('react-dom/server');
  const mod={exports:{}};const states=[details,'',0];
  const source=ts.transpileModule(fs.readFileSync(new URL('../components/connect-pay-advance-review.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','module','exports',source)(name=>name==='react'?{...React,useEffect(){},useState(){return [states.shift(),()=>{}]}}:name==='lucide-react'?{ChevronDown:()=>null}:require(name),mod,mod.exports);
  const html=renderToStaticMarkup(React.createElement(mod.exports.ConnectPayAdvanceReview,{accountId:'account-a',profileType:'employee',approval:{id:'step-a',requestId:'request-a',stepName:'Finance processing',requestedAmount:2000,approvedAmount:2000,outstandingPay:12000,maxEligibleAmount:3000,outstandingAdvance:4000,reservedRecovery:500,monthPaidCount:1,monthPaidAmount:5000,recoveryMode:'one_time',reason:'Travel'}}));
  for(const text of ['Previously approved amount','Earlier manager','Approval history','September 2026','October 2026','Available advance now','Advance payment and recovery history','UTR-123','Scheduled','Recovered'])assert.ok(html.includes(text),text);
  assert.ok(!html.includes('Amount from previous review'));
  assert.ok(html.includes('This is an approval amount, not a paid advance.'));
  assert.ok(html.includes('<details'),'sections can expand without changing approval state');
});
