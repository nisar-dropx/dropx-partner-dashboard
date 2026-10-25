import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function load(file,mocks={}) {
 const module={exports:{}};
 new Function('require','module','exports',ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(name=>mocks[name]??{},module,module.exports);
 return module.exports;
}
const policy=load('./payment-resubmission.ts');
test('a saved retired reason remains selected alongside current master options',()=>{
 assert.deepEqual(policy.resubmissionOptions('High Volume, Company Breakdown','ODCD absent'),['ODCD absent','High Volume','Company Breakdown']);
 assert.deepEqual(policy.resubmissionOptions('High Volume,High Volume','High Volume'),['High Volume']);
});
test('only persisted vehicle reason/date are fixed; other corrections stay editable',()=>{
 assert(policy.isFixedReplacementQuestion('company_breakdown','Reason of adhoc deployment','Company Breakdown'));
 assert(policy.isFixedReplacementQuestion('high_volume','Deployment Date','2026-10-14'));
 assert(!policy.isFixedReplacementQuestion(null,'Deployment Date','2026-10-14'));
 assert(!policy.isFixedReplacementQuestion('company_breakdown','Vehicle Type','3 Wheeler'));
});
test('latest return wins even with no remarks; a rejection is not a return',()=>{
 const events=[{action:'returned',comments:'Earlier reason',created_at:'2026-10-01'},{action:'RETURNED',comments:null,created_at:'2026-10-03'},{action:'rejected',comments:'Wrong action',created_at:'2026-10-04'}];
 assert.equal(policy.latestReturn(events),events[1]);
 assert.equal(policy.latestReturn([]),null);
});
function mockDb(data) {
 const calls=[];
 return {calls,from(table){const call={table,filters:[]};calls.push(call);const q={select(){return q},eq(k,v){call.filters.push([k,v]);return q},or(v){call.or=v;return q},in(){return q},order(){return q},single(){return q},then(resolve){return Promise.resolve(data[table]??{data:[],error:null}).then(resolve)}};return q}};
}
test('context merges legacy/current history, resolves actors, and retains original context',async()=>{
 const db=mockDb({payment_request_approvals:{data:[{id:'1',action:'created',comments:'Company van unavailable',created_at:'2026-10-01',approver_user_id:'requester'},{id:'2',action:'approved',created_at:'2026-10-02',approver_user_id:'manager'},{id:'3',action:'returned',comments:'Clarify the amount',created_at:'2026-10-03',approver_user_id:'manager',approver_role_id:'role'}]},payment_requests:{data:{adhoc_reason_key:'company_breakdown',adhoc_vehicle_snapshot:{reason:'Breakdown',number:'KL01AA1234'}}},profiles:{data:[{id:'requester',full_name:'Station'},{id:'manager',full_name:'Manager'}]},user_roles:{data:[{id:'role',name:'Cluster Manager'}]}});
 const {loadResubmissionContext}=load('./payment-resubmission-context.ts',{'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/payment-resubmission':policy});
 const result=await loadResubmissionContext('company',{id:'request',requested_by:'requester',created_at:'2026-10-01',remarks:'Later edit'});
 assert.equal(result.returned.actor,'Manager');assert.equal(result.returned.role,'Cluster Manager');assert.equal(result.originalRemarks,'Company van unavailable');assert.equal(result.events.length,3);assert.deepEqual(result.vehicleContext,['Breakdown','KL01AA1234']);
 assert(db.calls.every(call=>call.filters.some(([k,v])=>k==='company_id'&&v==='company')));
 assert.equal(db.calls[0].or,'payment_request_id.eq.request,request_id.eq.request');
});
test('failed history is explicit and cannot masquerade as no return reason',async()=>{
 const db=mockDb({payment_request_approvals:{data:null,error:{message:'offline'}}});
 const {loadResubmissionContext}=load('./payment-resubmission-context.ts',{'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/payment-resubmission':policy});
 const result=await loadResubmissionContext('company',{id:'request',requested_by:'u',created_at:'2026-10-01',remarks:'x'});
 assert.match(result.error,/Reload before resubmitting/);assert.equal(result.returned,null);
});
test('missing creation log does not label latest remarks as original submission',async()=>{
 const db=mockDb({payment_requests:{data:{adhoc_reason_key:null}},profiles:{data:[{id:'u',full_name:'Requester'}]}});
 const {loadResubmissionContext}=load('./payment-resubmission-context.ts',{'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/payment-resubmission':policy});
 const result=await loadResubmissionContext('company',{id:'request',requested_by:'u',created_at:'2026-10-01',remarks:'Most recent response'});
 assert.equal(result.originalRemarks,null);assert.equal(result.events[0].comments,null);assert.equal(result.events[0].actor,'Requester');
});
test('invalid supporting input expands its group before native validation focuses it',()=>{
 const jsx=(type,props)=>({type,props});
 const {PaymentResubmissionFields}=load('../components/payment-resubmission-fields.tsx',{'react/jsx-runtime':{jsx,jsxs:jsx}});
 const tree=PaymentResubmissionFields({title:'Files',children:[],open:false});
 const target={open:false};tree.props.onInvalidCapture({currentTarget:target});assert.equal(target.open,true);
});

test('return corrections allow configured bills early without requiring the later-stage fields',()=>{
 const questions=[
  {id:'ref',answer_type:'text',field_stage:'expense',sort_order:1,is_required:true},
  {id:'bill',answer_type:'file',field_stage:'payment',sort_order:2,is_required:true},
  {id:'account',answer_type:'text',field_stage:'payment',sort_order:3,is_required:true},
  {id:'inactive',answer_type:'file',field_stage:'payment',sort_order:0,is_required:true}
 ];
 const expense=policy.resubmissionQuestions(questions,'expense');
 assert.deepEqual(expense.map(q=>q.id),['ref','bill']);
 assert.equal(expense[0].is_required,true);assert.equal(expense[1].is_required,false);
 const payment=policy.resubmissionQuestions(questions,'payment');
 assert.deepEqual(payment.map(q=>q.id),['bill','account']);assert.equal(payment[0].is_required,true);
 assert.equal(questions[1].is_required,true,'master configuration is not mutated');
});

test('literal reviewer feedback is shown without inventing an interpretation',()=>{
 const jsx=(type,props)=>({type,props});
 const {PaymentResubmissionContext}=load('../components/payment-resubmission-context.tsx',{'react/jsx-runtime':{jsx,jsxs:jsx},'@/lib/date-format':{formatDashboardDateTime:()=> '25 Oct'}});
 const context={returned:{actor:'Reviewer',role:'Manager',comments:'NO REMARKS',created_at:'2026-10-25'},events:[],vehicleContext:[],error:null};
 const tree=JSON.stringify(PaymentResubmissionContext({context,head:'Driver',location:'Station',amount:700}));
 assert.match(tree,/NO REMARKS/);assert.doesNotMatch(tree,/No specific return reason/);
});
