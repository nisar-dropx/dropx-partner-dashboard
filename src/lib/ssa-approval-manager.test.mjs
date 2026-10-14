import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const day='2026-10-09';
function fixture({ssa=true, cm=true}={}) {
  const state={tables:{},logins:new Map(),calls:[]};
  const roles=['SSA','TL','CLM','AOM','FINMGR','MANAGING_PARTNER','HRM'];
  state.tables.designations=roles.map(code=>({id:code,code,name:code,company_id:'company',is_active:true}));
  const ids=['worker','tl',...(cm?['cm']:[]),'aom','finance','hr'];
  state.tables.hr_engagements=ids.map(id=>({id:`e-${id}`,person_id:id,company_id:'company',worker_type:'employee',employee_id:id,status:'active',start_date:'2020-01-01',end_date:null}));
  state.tables.hr_people=ids.map(id=>({id,company_id:'company',display_name:id,status:'active'}));
  state.tables.profiles=ids.map(id=>({id:`${id}-login`,company_id:'company',is_active:true}));
  state.tables.hr_work_assignments=ids.map(id=>({id:`a-${id}`,company_id:'company',engagement_id:`e-${id}`,designation_id:({worker:ssa?'SSA':'TL',tl:'TL',cm:'CLM',aom:'AOM',finance:'FINMGR',hr:'HRM'})[id],location_id:'station',position_title:id,is_primary:true,effective_from:'2020-01-01',effective_to:null}));
  // Only worker/TL are posted at the station; managers are reached through its People hierarchy.
  for(const a of state.tables.hr_work_assignments) if(!['a-worker','a-tl'].includes(a.id)) a.location_id='office';
  const pairs=cm?[['worker','tl'],['tl','cm'],['cm','aom']]:[['worker','tl'],['tl','aom']];
  state.tables.hr_reporting_relationships=pairs.map(([a,b])=>({company_id:'company',subject_assignment_id:`a-${a}`,manager_assignment_id:`a-${b}`,relationship_type:'solid_line',is_primary:true,effective_from:'2020-01-01',effective_to:null}));
  for(const id of ids)state.logins.set(id,`${id}-login`);
  const route={id:'route',company_id:'company',route_name:'SSA leave',workflow_code:'leave_request',requester_designation_id:ssa?'SSA':'TL',location_id:null,requester_person_id:null,is_active:true,priority:100,level_1_designation_id:'TL',level_1_search_scope:'reporting_chain',level_1_fallback_mode:'next_reporting_manager',level_2_required:true,level_2_designation_id:'CLM',level_2_search_scope:'reporting_chain',level_2_fallback_mode:'next_reporting_manager',hr_final_required:false};
  state.tables.hr_approval_workflow_routes=[route];
  const db={from(table){
    state.calls.push(table);
    let rows=[...(state.tables[table]??[])];
    const q={select(){return q},eq(k,v){rows=rows.filter(r=>r[k]===v);return q},in(k,vs){rows=rows.filter(r=>vs.includes(r[k]));return q},
      lte(k,v){rows=rows.filter(r=>r[k]!=null&&r[k]<=v);return q},gte(k,v){rows=rows.filter(r=>r[k]!=null&&r[k]>=v);return q},
      or(text){const clauses=text.split(',').map(c=>c.split('.'));rows=rows.filter(r=>clauses.some(([k,op,...parts])=>op==='is'?r[k]==null:op==='gte'&&r[k]!=null&&r[k]>=parts.join('.')));return q},
      order(k,{ascending=true}={}){rows.sort((a,b)=>String(a[k]).localeCompare(String(b[k]))*(ascending?1:-1));return q},
      limit(n){rows=rows.slice(0,n);return q},range(a,b){rows=rows.slice(a,b+1);return q},
      maybeSingle(){assert.ok(rows.length<=1);return Promise.resolve({data:rows[0]??null,error:null})},
      then(resolve,reject){return Promise.resolve({data:rows,error:null}).then(resolve,reject)}};return q;
  },rpc:async(name,args,options)=>{
    assert.equal(name,'hr_workflow_applies_hr_precheck_finalize_flag');
    state.rpcCalls??=[];state.rpcCalls.push({name,args,options});
    return {data:false,error:null};
  }};
  const cache=new Map();
  function load(file,extra='') {
    file=path.resolve(root,file);
    if(!extra&&cache.has(file))return cache.get(file);
    const mod={exports:{}};
    const source=ts.transpileModule(readFileSync(file,'utf8')+extra,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function('require','module','exports',source)(name=>{
      if(name==='server-only')return {};
      if(name.endsWith('/supabase-admin'))return {supabaseAdmin:db};
      if(name.endsWith('/connect-approver-identity'))return {resolveConnectApproverUserId:async(company,id)=>{assert.equal(company,'company');return state.logins.get(id)??null}};
      if(name.endsWith('/india-date'))return {todayInIndia:()=>day};
      if(extra && !name.endsWith('/ssa-approval-manager') && !name.endsWith('/exit-resignation-route')) return {};
      let target=name.startsWith('@/')?path.join(root,'src',name.slice(2)):path.resolve(path.dirname(file),name);
      if(existsSync(`${target}.ts`))return load(`${target}.ts`);
      return {};
    },mod,mod.exports);
    if(!extra)cache.set(file,mod.exports);return mod.exports;
  }
  const input={companyId:'company',workerType:'employee',workerId:'worker',asOf:day};
  return {state,route,load,input,manager:()=>load('src/lib/ssa-approval-manager.ts').resolveSsaApprovalManager(input)};
}
for(const file of ['src/lib/approval-workflow-routing.ts','apps/connect/src/lib/approval-workflow-routing.ts']) {
  test(`${file}: SSA skips TL and replaces the legacy duplicate CM step`,async()=>{
    const f=fixture();const result=await f.load(file).resolveConfiguredApprovalWorkflow({...f.input,workflowCode:'leave_request'});
    assert.deepEqual(result.steps.map(s=>s.approver_person_id),['cm']);assert.equal(result.steps[0].step_name,'Cluster Manager approval');
  });
  test(`${file}: missing CM selects AOM, including forced reporting-chain requests`,async()=>{
    const f=fixture({cm:false});const result=await f.load(file).resolveConfiguredApprovalWorkflow({...f.input,workflowCode:'leave_request',reportingChainOnly:true});
    assert.deepEqual(result.steps.map(s=>s.approver_person_id),['aom']);assert.equal(result.steps[0].resolved_via,'fallback');
  });
  test(`${file}: reimbursement retains the next manager and Finance after CM`,async()=>{
    const f=fixture();Object.assign(f.route,{workflow_code:'reimbursement',level_1_search_scope:'immediate_reporting_manager',level_2_designation_id:'MANAGING_PARTNER',hr_final_required:true,hr_final_designation_id:'FINMGR',hr_final_search_scope:'reporting_chain',hr_final_fallback_mode:'specific_person',hr_final_fallback_person_id:'finance'});
    const result=await f.load(file).resolveConfiguredApprovalWorkflow({...f.input,workflowCode:'reimbursement',reportingChainOnly:true,reportingChainMaxLevel:2,level3StepName:'Finance approval'});
    assert.deepEqual(result.steps.map(s=>s.approver_person_id),['cm','aom','finance']);assert.equal(result.steps.at(-1).step_name,'Finance approval');
  });
  test(`${file}: other designations keep TL routing`,async()=>{
    const f=fixture({ssa:false});const result=await f.load(file).resolveConfiguredApprovalWorkflow({...f.input,workflowCode:'leave_request'});
    assert.deepEqual(result.steps.map(s=>s.approver_person_id),['tl','cm']);assert.equal(result.managerPolicy,undefined);
  });
  test(`${file}: no manager cannot silently skip to Finance or TL`,async()=>{
    const f=fixture({cm:false});f.state.tables.hr_engagements.find(e=>e.person_id==='aom').status='inactive';
    await assert.rejects(f.load(file).resolveConfiguredApprovalWorkflow({...f.input,workflowCode:'leave_request',allowMissingApprovers:true}),/Map a Cluster Manager or Area Operations Manager/);
  });
}
test('station mapping wins even if this SSA has an incomplete individual reporting line',async()=>{
  const f=fixture();f.state.tables.hr_reporting_relationships=f.state.tables.hr_reporting_relationships.filter(r=>r.subject_assignment_id!=='a-worker');
  assert.equal((await f.manager()).personId,'cm');
});
test('missing CM login blocks instead of silently substituting TL/AOM',async()=>{
  const f=fixture();f.state.logins.delete('cm');await assert.rejects(f.manager(),/approval login/);
});
test('station, company and effective date boundaries prevent unrelated approvers',async()=>{
  for(const edit of [
    f=>{f.state.tables.hr_work_assignments.find(a=>a.id==='a-worker').location_id='other-station';f.state.tables.hr_reporting_relationships=f.state.tables.hr_reporting_relationships.filter(r=>r.subject_assignment_id!=='a-worker')},
    f=>f.state.tables.hr_people.find(p=>p.id==='cm').company_id='other',
    f=>f.state.tables.hr_engagements.find(e=>e.person_id==='cm').start_date='2027-01-01',
    f=>f.state.tables.hr_work_assignments.find(a=>a.id==='a-cm').effective_to='2026-09-01'
  ]){const f=fixture();edit(f);await assert.rejects(f.manager(),/Map a Cluster Manager or Area Operations Manager/);}
});
test('attendance keeps its HR final stage and does not refill a TL/second manager',async()=>{
  const f=fixture();Object.assign(f.route,{workflow_code:'attendance_regularization',level_2_required:false,hr_final_required:true});
  const result=await f.load('src/lib/attendance-regularization-workflow.ts').resolveAttendanceRegularizationApprovers('company','employee','worker',day);
  assert.deepEqual(result.steps.map(s=>s.approver_person_id),['cm']);assert.equal(result.requiresHrFinal,true);
});
test('attendance refuses to swallow missing SSA manager and use a generic fallback',async()=>{
  const f=fixture({cm:false});f.route.workflow_code='attendance_regularization';f.state.tables.hr_engagements.find(e=>e.person_id==='aom').status='inactive';
  await assert.rejects(f.load('src/lib/attendance-regularization-workflow.ts').resolveAttendanceRegularizationApprovers('company','employee','worker',day),/Map a Cluster Manager or Area Operations Manager/);
});

test('expense pre-approval and roster swap use the station CM/AOM instead of immediate TL',async()=>{
  for(const cm of [true,false]){
    const f=fixture({cm});
    const expense=f.load('apps/connect/src/lib/connect-expense-data.ts','\nexport { resolveImmediateReportingManager };');
    const assignee=await expense.resolveImmediateReportingManager({companyId:'company'}, {workerType:'employee',workerId:'worker',today:day,assignment:{id:'a-worker'},personId:'worker'});
    assert.equal(assignee.approver_person_id,cm?'cm':'aom');
    const roster=f.load('apps/connect/app/api/connect/roster/route.ts','\nexport { immediateManager };');
    assert.equal(await roster.immediateManager('company','employee','worker'),cm?'cm-login':'aom-login');
  }
});
test('SSA resignation and reporting-manager tasks include AOM when no CM is mapped',async()=>{
  const f=fixture({cm:false});
  const exit=f.load('apps/connect/app/api/connect/exit/route.ts','\nexport { reportingManagerChain };');
  const chain=await exit.reportingManagerChain({account:{companyId:'company'},workerType:'employee',workerId:'worker',worker:{}},1);
  assert.deepEqual(chain.map(s=>s.userId),['aom-login']);
  const policy=f.load('apps/connect/src/lib/exit-resignation-route.ts');
  const seats=policy.resolveResignationSeats({seats:policy.planResignationSeats('floor'),chain});
  assert.equal(seats.resolved[0].assignedUserId,'aom-login');
  assert.ok(seats.resolved.some(s=>s.kind==='hr'&&s.status==='resolved'));
});
test('self-approval is never assigned',async()=>{
  const f=fixture();
  f.state.tables.hr_engagements.find(e=>e.person_id==='cm').person_id='worker';
  await assert.rejects(f.manager(),/Map a Cluster Manager or Area Operations Manager/);
});

function addOtherClusterManager(f){
  f.state.tables.hr_people.push({id:'other',company_id:'company',display_name:'other',status:'active'});
  f.state.tables.hr_engagements.push({id:'e-other',person_id:'other',company_id:'company',status:'active',start_date:'2020-01-01',end_date:null});
  f.state.tables.hr_work_assignments.push({id:'a-other',engagement_id:'e-other',company_id:'company',designation_id:'CLM',location_id:'station',is_primary:true,effective_from:'2020-01-01',effective_to:null});
  f.state.logins.set('other','other-login');
}
test('with several mapped Cluster Managers the requester keeps the one in their own reporting line',async()=>{
  const f=fixture();addOtherClusterManager(f);
  // Even when the other manager covers more of the station.
  f.state.tables.hr_people.push({id:'x1',company_id:'company',display_name:'x1',status:'active'});
  f.state.tables.hr_engagements.push({id:'e-x1',person_id:'x1',company_id:'company',status:'active',start_date:'2020-01-01',end_date:null});
  f.state.tables.hr_work_assignments.push({id:'a-x1',engagement_id:'e-x1',company_id:'company',designation_id:'TL',location_id:'station',is_primary:true,effective_from:'2020-01-01',effective_to:null});
  f.state.tables.hr_reporting_relationships.push({company_id:'company',subject_assignment_id:'a-x1',manager_assignment_id:'a-other',relationship_type:'solid_line',is_primary:true,effective_from:'2020-01-01',effective_to:null});
  f.state.tables.hr_people.push({id:'x2',company_id:'company',display_name:'x2',status:'active'});
  f.state.tables.hr_engagements.push({id:'e-x2',person_id:'x2',company_id:'company',status:'active',start_date:'2020-01-01',end_date:null});
  f.state.tables.hr_work_assignments.push({id:'a-x2',engagement_id:'e-x2',company_id:'company',designation_id:'TL',location_id:'station',is_primary:true,effective_from:'2020-01-01',effective_to:null});
  f.state.tables.hr_reporting_relationships.push({company_id:'company',subject_assignment_id:'a-x2',manager_assignment_id:'a-other',relationship_type:'solid_line',is_primary:true,effective_from:'2020-01-01',effective_to:null});
  f.state.tables.hr_people.push({id:'x3',company_id:'company',display_name:'x3',status:'active'});
  f.state.tables.hr_engagements.push({id:'e-x3',person_id:'x3',company_id:'company',status:'active',start_date:'2020-01-01',end_date:null});
  f.state.tables.hr_work_assignments.push({id:'a-x3',engagement_id:'e-x3',company_id:'company',designation_id:'TL',location_id:'station',is_primary:true,effective_from:'2020-01-01',effective_to:null});
  f.state.tables.hr_reporting_relationships.push({company_id:'company',subject_assignment_id:'a-x3',manager_assignment_id:'a-other',relationship_type:'solid_line',is_primary:true,effective_from:'2020-01-01',effective_to:null});
  assert.equal((await f.manager()).personId,'cm');
});
test('without a reporting line the Cluster Manager most of the station reports to owns the request',async()=>{
  const f=fixture();addOtherClusterManager(f);
  f.state.tables.hr_reporting_relationships=f.state.tables.hr_reporting_relationships.filter(r=>r.subject_assignment_id!=='a-worker');
  f.state.tables.hr_people.push({id:'x1',company_id:'company',display_name:'x1',status:'active'});
  f.state.tables.hr_engagements.push({id:'e-x1',person_id:'x1',company_id:'company',status:'active',start_date:'2020-01-01',end_date:null});
  f.state.tables.hr_work_assignments.push({id:'a-x1',engagement_id:'e-x1',company_id:'company',designation_id:'TL',location_id:'station',is_primary:true,effective_from:'2020-01-01',effective_to:null});
  f.state.tables.hr_reporting_relationships.push({company_id:'company',subject_assignment_id:'a-x1',manager_assignment_id:'a-cm',relationship_type:'solid_line',is_primary:true,effective_from:'2020-01-01',effective_to:null});
  assert.equal((await f.manager()).personId,'cm');
});
test('evenly split Cluster Managers with no reporting line are still left for People to settle',async()=>{
  const f=fixture();addOtherClusterManager(f);
  f.state.tables.hr_reporting_relationships=f.state.tables.hr_reporting_relationships.filter(r=>r.subject_assignment_id!=='a-worker');
  await assert.rejects(f.manager(),/More than one request approver/);
});

function oneReimbursement(f, overrides={}) {
  return f.load('apps/connect/src/lib/connect-reimbursement-routing.ts').resolveOneReimbursementWorkflow({
    ...f.input,requesterPersonId:'worker',directRequester:false,...overrides
  });
}
test('One reimbursement: HLM-style route without a final stage still ends at Finance',async()=>{
  const f=fixture({ssa:false});Object.assign(f.route,{workflow_code:'reimbursement',level_2_required:false,hr_final_required:false});
  const before=JSON.stringify(f.state.tables);
  const result=await oneReimbursement(f);
  assert.deepEqual(result.steps.map(s=>[s.approver_person_id,s.stage_code]),[['tl','manager'],['finance','finance']]);
  assert.equal(result.steps.at(-1).step_name,'Finance approval');
  assert.equal(JSON.stringify(f.state.tables),before,'resolution must not mutate shared routes or data');
  assert.deepEqual(f.state.rpcCalls[0].options,{get:true},'the approval guide must use a read-only RPC in preview');
});
test('One reimbursement: SSA keeps CM/AOM checks and ends at Finance regardless of wrong final designation',async()=>{
  const f=fixture();Object.assign(f.route,{workflow_code:'reimbursement',level_2_designation_id:'AOM',hr_final_required:true,hr_final_designation_id:'HRM',hr_final_fallback_mode:'specific_person',hr_final_fallback_person_id:'hr'});
  const result=await oneReimbursement(f);
  assert.deepEqual(result.steps.map(s=>s.approver_person_id),['cm','aom','finance']);
  assert.deepEqual(result.steps.map(s=>s.stage_code),['manager','manager','finance']);
});
test('One reimbursement: a short senior hierarchy and a top-level requester still require Finance',async()=>{
  const f=fixture({ssa:false});f.route.workflow_code='reimbursement';
  f.state.tables.hr_reporting_relationships=f.state.tables.hr_reporting_relationships.filter(r=>r.subject_assignment_id==='a-worker');
  assert.deepEqual((await oneReimbursement(f)).steps.map(s=>s.approver_person_id),['tl','finance']);
  f.state.tables.hr_reporting_relationships=[];
  await assert.rejects(oneReimbursement(f),/No reporting manager/);
  assert.deepEqual((await oneReimbursement(f,{directRequester:true})).steps.map(s=>s.approver_person_id),['finance']);
});
test('One reimbursement: Finance in the reporting chain is deduplicated and moved to the final stage',async()=>{
  const f=fixture({ssa:false});f.route.workflow_code='reimbursement';
  f.state.tables.hr_reporting_relationships.find(r=>r.subject_assignment_id==='a-worker').manager_assignment_id='a-finance';
  assert.deepEqual((await oneReimbursement(f)).steps.map(s=>[s.approver_person_id,s.stage_code]),[['finance','finance']]);
});
test('One reimbursement: the requester cannot approve their own Finance stage',async()=>{
  const f=fixture({ssa:false});f.route.workflow_code='reimbursement';
  await assert.rejects(oneReimbursement(f,{requesterPersonId:'finance'}),/active Finance Manager/);
});
test('One reimbursement: inactive, expired, future, unlinked and cross-company Finance seats fail closed',async()=>{
  for(const edit of [
    f=>f.state.tables.designations.find(d=>d.id==='FINMGR').is_active=false,
    f=>f.state.tables.hr_people.find(p=>p.id==='finance').status='inactive',
    f=>f.state.tables.hr_engagements.find(e=>e.person_id==='finance').status='inactive',
    f=>f.state.tables.hr_engagements.find(e=>e.person_id==='finance').start_date='2027-01-01',
    f=>f.state.tables.hr_engagements.find(e=>e.person_id==='finance').end_date='2026-09-01',
    f=>f.state.tables.hr_work_assignments.find(a=>a.id==='a-finance').effective_to='2026-09-01',
    f=>f.state.tables.hr_work_assignments.find(a=>a.id==='a-finance').effective_from='2027-01-01',
    f=>f.state.logins.delete('finance'),
    f=>f.state.tables.profiles.find(p=>p.id==='finance-login').is_active=false,
    f=>f.state.tables.profiles.find(p=>p.id==='finance-login').company_id='other',
    f=>f.state.tables.hr_people.find(p=>p.id==='finance').company_id='other',
    f=>f.state.tables.hr_engagements.find(e=>e.person_id==='finance').company_id='other',
    f=>f.state.tables.hr_work_assignments.find(a=>a.id==='a-finance').company_id='other',
    f=>f.state.tables.hr_work_assignments.push({...f.state.tables.hr_work_assignments.find(a=>a.id==='a-finance'),id:'transferred',designation_id:'HRM',effective_from:'2026-10-01'})
  ]) {
    const f=fixture({ssa:false});f.route.workflow_code='reimbursement';edit(f);
    await assert.rejects(oneReimbursement(f),/active Finance Manager/);
  }
});
test('One reimbursement: several Finance Managers require an explicit eligible seat',async()=>{
  const f=fixture({ssa:false});f.route.workflow_code='reimbursement';
  f.state.tables.hr_work_assignments.find(a=>a.id==='a-hr').designation_id='FINMGR';
  await assert.rejects(oneReimbursement(f),/More than one Finance Manager/);
  Object.assign(f.route,{hr_final_fallback_mode:'specific_person',hr_final_fallback_person_id:'finance'});
  assert.equal((await oneReimbursement(f)).steps.at(-1).approver_person_id,'finance');
  f.route.hr_final_fallback_person_id='tl';
  await assert.rejects(oneReimbursement(f),/More than one Finance Manager/);
});
test('One reimbursement: contractor requesters use the same Finance final policy',async()=>{
  const f=fixture({ssa:false});f.route.workflow_code='reimbursement';
  Object.assign(f.state.tables.hr_engagements.find(e=>e.person_id==='worker'),{worker_type:'contractor',employee_id:null,contractor_id:'worker'});
  assert.equal((await oneReimbursement(f,{workerType:'contractor'})).steps.at(-1).stage_code,'finance');
});
test('One reimbursement: missing manager route is explicit and cannot bypass approvals',async()=>{
  const f=fixture({ssa:false});f.state.tables.hr_approval_workflow_routes=[];
  await assert.rejects(oneReimbursement(f),/manager route is not configured/);
});
test('One policy does not change the shared reimbursement or other request resolvers',async()=>{
  const f=fixture({ssa:false});Object.assign(f.route,{workflow_code:'reimbursement',level_2_required:false,hr_final_required:false});
  for(const file of ['src/lib/approval-workflow-routing.ts','apps/connect/src/lib/approval-workflow-routing.ts']) {
    const result=await f.load(file).resolveConfiguredApprovalWorkflow({...f.input,workflowCode:'reimbursement'});
    assert.deepEqual(result.steps.map(s=>s.approver_person_id),['tl']);
  }
  assert.equal((await oneReimbursement(f)).steps.at(-1).approver_person_id,'finance');
  f.route.workflow_code='leave_request';
  assert.deepEqual((await f.load('apps/connect/src/lib/approval-workflow-routing.ts').resolveConfiguredApprovalWorkflow({...f.input,workflowCode:'leave_request'})).steps.map(s=>s.approver_person_id),['tl']);
});
