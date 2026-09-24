import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function fixture() {
  const state={tables:{},actor:'manager',canFinalize:true,allowed:new Set(['person-a']),error:null};
  const db={from(table){
    let rows=state.tables[table]??[];
    const q={select(){return q},order(){return q},limit(n){rows=rows.slice(0,n);return q},
      eq(k,v){rows=rows.filter(r=>r[k]===v);return q},is(k,v){return q.eq(k,v)},
      in(k,vs){rows=rows.filter(r=>vs.includes(r[k]));return q},
      maybeSingle(){return Promise.resolve({data:rows[0]??null,error:state.error})},
      then(resolve,reject){return Promise.resolve({data:rows,error:state.error}).then(resolve,reject)}};return q;
  },rpc(){throw Error('Tests must not mutate approval state')},storage:{from(){return {createSignedUrl:async()=>({data:{signedUrl:'signed-fixture'}})}}}};
  const scope={loadConnectAttendanceApproveScope:async()=>({canFinalize:state.canFinalize,actorUserIds:[state.actor]}),
    loadConnectAccessibleWorkforceIds:async()=>({allowAll:false,employeeIds:state.allowed,contractorIds:new Set()}),
    connectWorkforceMatches:(access,type,id)=>type==='employee'&&access.employeeIds.has(id)};
  function load(file,extra='') {
    const mod={exports:{}};
    const source=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8')+extra,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function('require','module','exports',source)(name=>{
      if(name.endsWith('supabase-admin')) return {supabaseAdmin:db};
      if(name.endsWith('connect-approver-identity'))return {resolveConnectActorUserIds:async()=>[state.actor],resolveConnectActorUserId:async()=>state.actor};
      if(name.endsWith('connect-people-attendance-access'))return scope;
      if(name.endsWith('connect-approval-journey'))return {loadApprovalJourneySteps:async()=>new Map(),approvalJourneySummary:()=>({})};
      if(name.endsWith('connect-time-off-attachments'))return {loadTimeOffAttachments:async()=>new Map()};
      if(name.endsWith('expense-request-form'))return {normalizeExpectedExpenses:value=>value??{}};
      if(name.endsWith('connect-reportee-scope'))return {connectReporteeMatches:()=>false};
      return {};
    },mod,mod.exports);return mod.exports;
  }
  return {state,manager:load('./connect-manager-approvals.ts'),wfh:load('./connect-wfh-data.ts'),trip:load('./connect-business-trip-data.ts'),
    expense:load('../../app/api/connect/reimbursements/route.ts','\nexport { approvalPayload, preRequestApprovalPayload };')};
}
const account={companyId:'company',id:'viewer',profileType:'employee'};
test('all HR finalization queues use granted worker scope, not personal reporting lines',async()=>{
  const f=fixture();
  const row={company_id:'company',profile_type:'employee',profile_id:'person-a',status:'pending_hr',request_kind:null,start_date:'2026-09-01',end_date:'2026-09-01'};
  for(const table of ['attendance_regularization_requests','hr_wfh_requests','hr_business_trip_requests']) f.state.tables[table]=[
    {...row,id:'visible'},{...row,id:'outside-scope',profile_id:'person-b'},{...row,id:'other-company',company_id:'other'},
    {...row,id:'finished',status:'approved'},{...row,id:'manager-stage',status:'pending_manager'}];
  const lists=[()=>f.manager.listConnectAttendanceHrApprovals(account,{}),()=>f.wfh.listConnectWfhHrApprovals(account),()=>f.trip.listConnectBusinessTripHrApprovals(account)];
  for(const list of lists) assert.deepEqual((await list()).map(x=>x.id),['visible']);
  f.state.canFinalize=false;
  for(const list of lists) assert.deepEqual(await list(),[],'no grant means no HR queue');
});
test('legacy attendance is visible only when there is no manager approval chain',async()=>{
  const f=fixture();
  f.state.tables.attendance_regularization_requests=['legacy','has-manager'].map(id=>({id,company_id:'company',profile_type:'employee',profile_id:'person-a',request_kind:null,status:'pending'}));
  f.state.tables.attendance_regularization_approval_steps=[{id:'step',company_id:'company',request_id:'has-manager'}];
  assert.deepEqual((await f.manager.listConnectAttendanceHrApprovals(account,{})).map(x=>x.id),['legacy']);
});
test('a shift swap assigned to an actor survives reporting-line changes, without leaking another actor or company',async()=>{
  const f=fixture();
  f.state.tables.hr_roster_swap_requests=[
    {id:'assigned',company_id:'company',approver_user_id:'manager',status:'pending_manager'},
    {id:'someone-else',company_id:'company',approver_user_id:'other',status:'pending_manager'},
    {id:'other-company',company_id:'other',approver_user_id:'manager',status:'pending_manager'}];
  assert.deepEqual((await f.manager.listConnectRosterSwapApprovals(account,{})).map(x=>x.id),['assigned']);
});
test('pre-requests show the same single manager ownership for every viewer',async()=>{
  const f=fixture();
  const request={id:'request',status:'pending',created_at:'2026-09-01',expected_expenses:{travel:400}};
  f.state.tables.hr_expense_claim_request_assignees=[
    {id:'manager-row',company_id:'company',request_id:'request',approver_user_id:'manager',assignee_role:'reporting_manager',status:'pending',hr_expense_claim_requests:request},
    {id:'partner-row',company_id:'company',request_id:'request',approver_user_id:'partner',assignee_role:'managing_partner',status:'pending',hr_expense_claim_requests:request}];
  assert.deepEqual((await f.expense.preRequestApprovalPayload('company',['manager'])).map(x=>x.id),['manager-row']);
  for(const actor of ['partner','finance','unrelated']) assert.deepEqual(await f.expense.preRequestApprovalPayload('company',[actor]),[]);
  assert.deepEqual(await f.expense.preRequestApprovalPayload('other',['manager']),[]);
  request.status='approved';assert.deepEqual(await f.expense.preRequestApprovalPayload('company',['manager']),[]);
});
test('claim queue contains only the current pending stage, never future or stale rows',async()=>{
  const f=fixture();
  f.state.tables.hr_expense_approval_steps=[
    {id:'current',step_order:1},{id:'future',step_order:2},{id:'finished',step_order:1,closed:true}
  ].map(x=>({...x,company_id:'company',approver_user_id:'manager',status:'pending',hr_expense_claims:{id:x.id,status:x.closed?'paid':'pending_approval',current_step:1,hr_expense_attachments:[]}}));
  assert.deepEqual((await f.expense.approvalPayload('company',['manager'])).map(x=>x.id),['current']);
});
test('database failure does not masquerade as an empty approval queue',async()=>{
  const f=fixture();f.state.error={message:'Database unavailable'};
  await assert.rejects(f.manager.listConnectAttendanceHrApprovals(account,{}),/Database unavailable/);
  await assert.rejects(f.expense.preRequestApprovalPayload('company',['manager']),/Database unavailable/);
});
