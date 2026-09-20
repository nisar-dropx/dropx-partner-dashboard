import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { payAdvanceDecision, payAdvanceFinanceTerms } from './connect-pay-advance-approval.ts';

function fixture() {
  const state = { actors:['actor-a'], rpcCalls:[], error:null,
    hr_pay_advance_steps:[{id:'step-a',company_id:'company-a',request_id:'request-a',approver_user_id:'actor-a',status:'pending',step_name:'Reporting manager'},
      {id:'step-b',company_id:'company-b',request_id:'request-b',approver_user_id:'actor-a',status:'pending'},
      {id:'step-c',company_id:'company-a',request_id:'request-c',approver_user_id:'other-actor',status:'pending'}],
    hr_pay_advance_requests:[{id:'request-a',company_id:'company-a',status:'pending',request_number:'ADV001',worker_name:'Test Person',requested_amount:2000,recovery_mode:'one_time',requested_installments:1,reason:'Test request'}] };
  const db = { from(table) {
    let rows = state[table] ?? [];
    const query = {select(){return query},eq(key,value){rows=rows.filter(row=>row[key]===value);return query},in(key,values){rows=rows.filter(row=>values.includes(row[key]));return query},order(){return query},limit(n){rows=rows.slice(0,n);return query},
      maybeSingle(){return Promise.resolve({data:state.error?null:rows[0]??null,error:state.error})},then(resolve,reject){return Promise.resolve({data:state.error?null:rows,error:state.error}).then(resolve,reject)}};
    return query;
  }, async rpc(name,args){state.rpcCalls.push({name,args});return {data:'pending',error:state.error}} };
  const mod={exports:{}};
  const source=ts.transpileModule(fs.readFileSync(new URL('./connect-pay-advance-approval-data.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mocks={'server-only':{},'./connect-approver-identity':{resolveConnectActorUserIds:async()=>state.actors},'./connect-pay-advance-approval':{payAdvanceDecision,payAdvanceFinanceTerms},'./supabase-admin':{supabaseAdmin:db}};
  new Function('require','module','exports',source)(id=>{assert.ok(id in mocks,id);return mocks[id]},mod,mod.exports);
  return {state,...mod.exports};
}
const account={companyId:'company-a',id:'account-a',profileType:'employee'};
test('pay advances are scoped to the authenticated company and pending assigned actor',async()=>{
  const f=fixture();
  const rows=await f.listConnectPayAdvanceApprovals(account);
  assert.deepEqual(rows.map(row=>row.requestId),['request-a']);
  assert.equal(rows[0].requestedAmount,2000);
  for(const id of ['request-b','request-c','unknown']) await assert.rejects(f.decideConnectPayAdvanceApproval(account,id,'approved',''),/assigned/);
  assert.equal(f.state.rpcCalls.length,0);
  await f.decideConnectPayAdvanceApproval(account,'request-a','approved','Reviewed');
  assert.deepEqual(f.state.rpcCalls[0],{name:'hr_decide_pay_advance_step',args:{p_company_id:'company-a',p_request_id:'request-a',p_actor_user_id:'actor-a',p_decision:'approved',p_note:'Reviewed',p_approved_amount:null,p_approved_installments:null}});
});
test('removed assignment and database failures never call the decision RPC',async()=>{
  const f=fixture(); f.state.hr_pay_advance_steps[0].status='approved';
  await assert.rejects(f.decideConnectPayAdvanceApproval(account,'request-a','approved',''),/no longer assigned/);
  f.state.error={message:'Database unavailable'};
  await assert.rejects(f.decideConnectPayAdvanceApproval(account,'request-a','approved',''),/Database unavailable/);
  assert.equal(f.state.rpcCalls.length,0);
});
test('unlinked accounts have no pay-advance approvals',async()=>{
  const f=fixture(); f.state.actors=[];
  assert.deepEqual(await f.listConnectPayAdvanceApprovals(account),[]);
  await assert.rejects(f.decideConnectPayAdvanceApproval(account,'request-a','approved',''),/not assigned/);
});

test('Finance approval validates amounts and installments before recording the decision',async()=>{
  const f=fixture(); f.state.hr_pay_advance_steps[0].step_type='finance';
  for(const [amount,installments] of [[null,1],[2001,1],[-1,1],[1500,0],[1500,13],[1500,1.5]]) await assert.rejects(f.decideConnectPayAdvanceApproval(account,'request-a','approved','',amount,installments));
  assert.equal(f.state.rpcCalls.length,0);
  await f.decideConnectPayAdvanceApproval(account,'request-a','approved','',1500,2);
  assert.equal(f.state.rpcCalls[0].args.p_approved_amount,1500);
  assert.equal(f.state.rpcCalls[0].args.p_approved_installments,2);
});
