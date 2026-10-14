import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as stage from './payment-stage-policy.ts';
import * as cover from './payment-delegation-policy.ts';
import {paymentApproverNeedsReconciliation} from './payment-approver-reconciliation-policy.ts';
import {readAllRows} from './supabase-pagination.ts';

function compile(path,mocks) {
  const m={exports:{}};
  new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{if(n in mocks)return mocks[n];throw Error(n);},m.exports,m);
  return m.exports;
}
function database(tables,failTable=null) {
  const updates=[];
  return {updates,from(table){
    let filters=[],start=0,end=Infinity,single=false,patch=null,head=false;
    const q={select(_s,opts){head=opts?.head??false;return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},is(k,v){filters.push(r=>r[k]===v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},not(k,op,v){if(op==='is')filters.push(r=>r[k]!==v);else if(op==='in'){const vals=v.slice(1,-1).split(',');filters.push(r=>!vals.includes(r[k]));}return q;},lte(k,v){filters.push(r=>r[k]<=v);return q;},gte(k,v){filters.push(r=>r[k]>=v);return q;},or(){return q;},order(){return q;},limit(n){end=n-1;return q;},range(a,b){start=a;end=b;return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},update(p){patch=p;return q;},then(resolve){
      if(table===failTable)return Promise.resolve({data:null,error:{message:'unavailable'}}).then(resolve);
      const rows=(tables[table]??[]).filter(r=>filters.every(f=>f(r))).slice(start,end+1);
      if(patch)for(const row of rows){updates.push({table,id:row.id,patch});Object.assign(row,patch);}
      return Promise.resolve({data:head?null:single?rows[0]??null:rows,error:null,count:rows.length}).then(resolve);
    }}; return q;
  }};
}
function routingFixture({leave=false,chain=false,wrongScope=false,cancelled=false,failTable=null}={}) {
  const company='co';
  const member=(user_id,role_id,locations=['NLRE'])=>({company_id:company,user_id,role_id,product_code:'operations',is_active:true,has_all_location_access:false,location_scope_ids:locations});
  const profile=(id,role_id)=>({company_id:company,id,role_id,full_name:id,is_active:true});
  const tables={
    stations:[{id:'NLRE',company_id:company,location_model_id:'EDSP'}],
    profiles:[profile('cluster','cm'),profile('area','aom'),profile('head','bh')],
    user_roles:['cm','aom','bh'].map(id=>({id,code:id,company_id:company,is_active:true,location_access_mode:'selected'})),
    company_product_memberships:[member('cluster','cm'),member('area','aom',wrongScope?['OTHER']:['NLRE']),member('head','bh')],
    hr_user_person_links:['cluster','area','head'].map(id=>({company_id:company,user_id:id,person_id:id,status:'active'})),
    hr_approval_delegations:leave?[{company_id:company,approver_person_id:'cluster',delegate_person_id:'area',workflow_code:null,is_active:true,effective_from:'2026-10-14',effective_to:'2026-10-14',reason:cancelled?'Auto-delegated: leave 00000000-0000-0000-0000-000000000001':'Configured cover'}]:[],
    hr_leave_requests:[],hr_engagements:[],hr_business_trip_requests:[]
  };
  if(chain)tables.hr_approval_delegations.push({company_id:company,approver_person_id:'area',delegate_person_id:'head',workflow_code:null,is_active:true,effective_from:'2026-10-14',effective_to:'2026-10-14',reason:'Configured cover'});
  const db=database(tables,failTable);
  const routing=compile('./payment-approval-steps.ts',{
    '@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/payment-stage-policy':stage,
    '@/lib/payment-delegation-policy':{...cover,paymentRoutingDay:()=> '2026-10-14'},
    '@/lib/position-access':{findPositionApprover:async()=>null,loadEffectivePositionAccess:async()=>({roleIds:[],locationScopeIds:[],hasAllLocationAccess:false}),roleIdsWithPageEditAccess:async(_c,roles)=>new Set(roles)}
  });
  return {routing,tables,db};
}
const steps=[{id:'s1',step_order:1,is_required:true,candidates:[{role_id:'cm',scope:'station'},{role_id:'aom',scope:'station'}]},{id:'s2',step_order:2,is_required:false,candidates:[{role_id:'aom',scope:'station'}]},{id:'s3',step_order:3,is_required:true,candidates:[{role_id:'bh',scope:'company'}]}];
test('regional station route hands over CM to AOM on leave and avoids a second AOM approval',async()=>{
  const {routing}=routingFixture({leave:true});
  const first=await routing.resolveInitialApprovalTarget('co',steps,'NLRE');assert.equal(first.approver.userId,'area');assert.match(first.approver.routingReason,/cluster → area/);
  const next=await routing.advanceApproval('co',steps,1,'NLRE',new Set(['area']));assert.equal(next.nextStepOrder,3);assert.equal(next.approver.userId,'head');
});
test('nested leave cover works, expired/cancelled leave returns to the primary holder',async()=>{
  const chain=routingFixture({leave:true,chain:true});assert.equal((await chain.routing.resolveStepApprover('co',steps[0],'NLRE')).userId,'head');
  const cancelled=routingFixture({leave:true,cancelled:true});assert.equal((await cancelled.routing.resolveStepApprover('co',steps[0],'NLRE')).userId,'cluster');
  const expired=routingFixture({leave:true});expired.tables.hr_approval_delegations[0].effective_to='2026-10-13';assert.equal((await expired.routing.resolveStepApprover('co',steps[0],'NLRE')).userId,'cluster');
});
test('a delegate outside the station scope cannot take approval and missing required cover blocks',async()=>{
  const {routing}=routingFixture({leave:true,wrongScope:true});
  const first=await routing.resolveInitialApprovalTarget('co',steps,'NLRE');assert.equal(first.approver,null);assert.equal(first.currentStepOrder,1);
});
test('People lookup failures preserve the pending assignment instead of silently selecting a fallback',async()=>{
  const {routing}=routingFixture({leave:true,failTable:'hr_approval_delegations'});
  await assert.rejects(()=>routing.resolveStepApprover('co',steps[0],'NLRE'),/verify active leave cover/);
});
test('reconciliation handles more than 250 requests and keeps reason-specific Fleet routes separate',async()=>{
  const rows=Array.from({length:520},(_,i)=>({id:String(i).padStart(4,'0'),request_no:String(i),company_id:'co',payment_head_id:'van',location_id:'NLRE',status:'pending',approval_status:'PENDING',current_step_order:1,current_approver_user_id:'old',current_approver_role_id:'old-role',updated_at:'2026-10-14',adhoc_approval_steps:i%2?[{step_order:1,candidates:[{role_id:'fleet',scope:'company'}]}]:null}));
  const db=database({payment_requests:rows}); const loaded=[];
  const {reconcilePendingPaymentApprovers}=compile('./payment-approver-reconciliation.ts',{
    '@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/supabase-pagination':{readAllRows},'@/lib/payment-stage-policy':stage,
    '@/lib/payment-approver-reconciliation-policy':{paymentApproverNeedsReconciliation},
    '@/lib/payment-approval-steps':{loadApprovalSteps:async(_c,_h,id)=>{loaded.push(id);return rows.find(r=>r.id===id).adhoc_approval_steps??steps;},resolveStepApprover:async(_c,step)=>({userId:step.candidates[0].role_id,roleId:step.candidates[0].role_id,routingReason:'Current People assignment'})}
  });
  const result=await reconcilePendingPaymentApprovers();assert.equal(result.checked,520);assert.equal(result.reassigned,520);assert.deepEqual(result.errors,[]);
  assert.equal(loaded.length,2);assert.equal(rows[0].current_approver_user_id,'cm');assert.equal(rows[1].current_approver_user_id,'fleet');
  assert.equal(db.updates[0].patch.updated_by,null);
});

// Exercise the real server action: failed People lookup must not consume a decision.
test('approval routing failure does not write an approval or advance the request',async()=>{
  const db=database({payment_requests:[{id:'request',company_id:'co',location_id:'NLRE',payment_head_id:'van',current_step_order:1,current_approver_user_id:'cluster',approval_cycle:1}],user_roles:[{id:'cm',company_id:'co',code:'CM'}]});
  let inserts=0; const from=db.from.bind(db); db.from=table=>{const q=from(table);q.insert=()=>{inserts++;return q;};return q;};
  const {approvePaymentRequest}=compile('../app/payments/approvals/actions.ts',{
    'next/cache':{revalidatePath(){}},'next/navigation':{redirect(){}},'@vercel/functions':{waitUntil(){}},
    '@/lib/authorization':{requirePagePermission:async()=>({userId:'cluster',roleId:'cm'})},
    '@/lib/company-scope':{requireCompanyId:()=> 'co',withCompany:(row,company_id)=>({...row,company_id})},
    '@/lib/payment-approval-scope':{canActOnPaymentRequest:async()=>true},
    '@/lib/payment-email-notifications':{},'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/position-access':{},
    '@/lib/payment-stage-policy':stage,
    '@/lib/payment-approval-steps':{loadApprovalSteps:async()=>steps,advanceApproval:async()=>{throw Error('People unavailable');}}
  });
  const form=new FormData();form.set('request_id','request');
  await assert.rejects(()=>approvePaymentRequest(form),/People unavailable/);
  assert.equal(inserts,0);assert.equal(db.updates.length,0);
});

test('oversight evidence access enforces company, location and permission independently of assignment',async()=>{
  const id='00000000-0000-0000-0000-000000000001';
  const db=database({payment_requests:[{id,company_id:'co',location_id:'NLRE',payment_heads:{code:'VAN_ADHOC'}}]});
  let auth={userId:'observer',hasAllLocationAccess:false,locationScopeIds:['NLRE'],permissions:{payment_oversight:{canView:true}}};
  const {canOverseePayment}=await import('./payment-oversight-policy.ts');
  const {authorizePaymentEvidence}=compile('./payment-evidence-authorization.ts',{
    'server-only':{},'@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:(a,c)=>Boolean(a.permissions[c]?.canView)},
    '@/lib/company-scope':{requireCompanyId:()=> 'co'},'@/lib/supabase-admin':{supabaseAdmin:db},
    '@/lib/payment-oversight-policy':{canOverseePayment},
    '@/lib/payment-approval-scope':{canAccessPaymentLocation:(a,l)=>a.locationScopeIds.includes(l),getPaymentApprovalEligibility:async()=>new Set()}
  });
  const request=new Request(`https://ops.dropxlogistics.com/api/payments/approvals/shipments?request=${id}`);
  assert.equal((await authorizePaymentEvidence(request)).payment.id,id);
  auth={...auth,locationScopeIds:['OTHER']};assert.equal((await authorizePaymentEvidence(request)).error.status,403);
  auth={...auth,locationScopeIds:['NLRE'],permissions:{}};assert.equal((await authorizePaymentEvidence(request)).error.status,403);
  auth={...auth,permissions:{payment_oversight:{canView:true}}};
  assert.equal((await authorizePaymentEvidence(new Request('https://ops.dropxlogistics.com/?request=00000000-0000-0000-0000-000000000002'))).error.status,404);
});
