import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as facts from '../../../../lib/payment-request-facts.ts';
import * as status from '../../../../lib/payment-status-label.ts';
import * as progress from '../../../../lib/payment-tracking-progress.ts';
import * as paymentDetails from '../../../../lib/payment-details.ts';
import * as attachments from '../../../../lib/payment-request-attachments.ts';
const compiled=ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const auth={companyId:'company',locationScopeIds:['station'],hasAllLocationAccess:false};
async function call(options={}) {
 const visited=[];
 const row={id:'request',company_id:'company',location_id:'station',request_no:'RX123',location_code:'TEST',payment_heads:{name:'Adhoc driver'},amount:1200,created_at:'2026-11-01T10:00:00Z',requested_by:'actor',status:'APPROVED',delivery_performer_name:'Latest driver',delivery_provider_employee_id:'DA123',details:{adhoc_driver:{reason_label:'Driver on leave',person_name:'Absent driver',work_date:'2026-11-01'}},...options.row};
 const data={payment_requests:[row],payment_request_approvals:[{id:'event',company_id:'company',payment_request_id:'request',action:'APPROVED',approver_user_id:'actor',created_at:'2026-11-02T10:00:00Z',comments:'Checked'}],payment_request_answers:[],profiles:[{id:'actor',company_id:'company',full_name:'Approver'}],user_roles:[]};
 const admin={from(table){visited.push(table);let rows=data[table];return {select(columns){if(table==='payment_requests') { const selected=columns.split(','); rows=rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key==='company_id'||selected.includes(key)||columns.includes(key+'(')))); } return this},eq(k,v){rows=rows.filter(r=>r[k]===v);return this},in(k,v){rows=rows.filter(r=>v.includes(r[k]));return this},limit(n){rows=rows.slice(0,n);return this},order(){return this},then(resolve){return Promise.resolve({data:rows,error:options.fail?new Error('internal secret'):null}).then(resolve)}}}};
 const deps={'next/server':{NextResponse:{json:(body,options)=>({body,...options})}},'@/lib/authorization':{getAuthorization:async()=>options.auth===undefined?auth:options.auth,hasPermission:()=>options.permission!==false},'@/lib/company-scope':{requireCompanyId:a=>a.companyId},'@/lib/supabase-admin':{supabaseAdmin:admin},'@/lib/payment-request-facts':facts,'@/lib/payment-status-label':status,'@/lib/payment-request-attachments':attachments,'@/lib/payment-tracking-progress':progress,'@/lib/payment-details':paymentDetails};
 const module={exports:{}};new Function('require','exports','module',compiled)(key=>deps[key],module.exports,module);
 return {response:await module.exports.GET(new Request('https://example.com/api/payments/track?q='+encodeURIComponent(options.query??'rx123'))),visited};
}
test('requires authentication and payment permission',async()=>{
 assert.equal((await call({auth:null})).response.status,401);
 assert.equal((await call({permission:false})).response.status,403);
});
test('company and location scope gate parent before any history is read',async()=>{
 for(const options of [{row:{location_id:'other'}},{row:{company_id:'other'}},{auth:{...auth,locationScopeIds:[]}}, {auth:{...auth,hasAllLocationAccess:true},row:{company_id:'other'}}]){
 const {response,visited}=await call(options);assert.equal(response.status,404);assert.ok(!visited.includes('payment_request_approvals'));
 }
 assert.equal((await call({auth:{...auth,hasAllLocationAccess:true},row:{location_id:'other'}})).response.status,200);
});
test('returns latest details and ordered actual events without premature paid event',async()=>{
 const {response}=await call();assert.equal(response.status,200);assert.equal(response.headers['Cache-Control'],'private, no-store');
 assert.ok(response.body.facts.some(f=>f.label==='Delivery associate'&&f.value==='Latest driver'));
 assert.ok(response.body.facts.some(f=>f.label==='Person on leave'&&f.value==='Absent driver'));
 assert.deepEqual(response.body.events.map(e=>e.action),['Requested','APPROVED']);
 const paid=(await call({row:{status:'PROCESSED',bank_status:'PAID',utr_cin:'BANK123',processed_at:'2026-11-03T10:00:00Z'}})).response;
 assert.equal(paid.body.status,'Paid');assert.equal(paid.body.events.at(-1).action,'Paid');
});
test('invalid searches and database errors do not expose details',async()=>{
 assert.equal((await call({query:' '})).response.status,400);
 const original=console.error;console.error=()=>{};
 try{const {response}=await call({fail:true});assert.equal(response.status,500);assert.ok(!JSON.stringify(response.body).includes('secret'));}finally{console.error=original;}
});
test('facts exclude arbitrary JSON and bank details',()=>{
 assert.deepEqual(facts.paymentRequestFacts({details:{account_number:'secret',unknown:'secret'},payment_reference:'secret'}),[]);
});

test('tracks every saved delivery performer mode and confirmation', async () => {
 for (const [mode,label] of Object.entries({van_driver:'Van driver',bike_da:'Existing bike DA',existing_odcd:'Existing ODCD DA',standalone_odcd:'ODCD delivery associate'})) {
  const {response}=await call({row:{delivery_performer_mode:mode,delivery_identity_confirmed:true}});
  assert.ok(response.body.facts.some(f=>f.label==='Who is doing delivery?' && f.value===label));
  assert.ok(response.body.facts.some(f=>f.label==='Delivery ID confirmation'));
 }
 const {response}=await call();
 assert.ok(!response.body.facts.some(f=>f.label==='Who is doing delivery?'));
});


test('next milestone reflects actual payment details and does not claim bank settlement', async () => {
 const missing=(await call()).response.body;
 assert.equal(missing.progress.next,'Requester to submit payment details');
 const ready=(await call({row:{payment_mode:'account_transfer',bank_account_no:'private-account',ifsc:'private-ifsc',account_holder_name:'Private holder'}})).response.body;
 assert.equal(ready.progress.next,'Finance to process payment');
 assert.deepEqual(ready.progress.milestones.map(m=>m.state),['done','done','done','current','upcoming']);
 assert.ok(!JSON.stringify(ready).includes('private-account'));
 for(const state of ['PROCESSING','PROCESSED']) {
  const body=(await call({row:{status:state}})).response.body;
  assert.equal(body.progress.next,'Awaiting payment confirmation');
  assert.equal(body.progress.milestones.at(-1).state,'upcoming');
 }
 const paid=(await call({row:{status:'PROCESSED',bank_status:'PAID',utr_cin:'BANK123'}})).response.body;
 assert.ok(paid.progress.milestones.every(m=>m.state==='done'));
});
test('returned, rejected and resubmitted requests show correct next actions', async () => {
 const returned=(await call({row:{status:'RETURNED'}})).response.body.progress;
 assert.equal(returned.next,'Requester to correct and resubmit');
 assert.equal(returned.tone,'issue');
 const rejected=(await call({row:{status:'REJECTED'}})).response.body.progress;
 assert.ok(rejected.milestones.slice(2).every(m=>m.state==='stopped'));
 const resubmitted=(await call({row:{status:'RE_PENDING',current_step_order:1,total_steps:2}})).response.body.progress;
 assert.match(resubmitted.next,/to review.*step 1 of 2/);
 assert.equal(resubmitted.milestones[1].state,'current');
 for(const event of ['APPROVED','Submitted','Paid']) assert.equal(progress.paymentTrackingEventTone(event),'done');
 for(const event of ['RETURNED','Rejected','PAYMENT_FAILED']) assert.equal(progress.paymentTrackingEventTone(event),'issue');
});
