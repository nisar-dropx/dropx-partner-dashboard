import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { applyFinanceProcessingAccess } from './payment-processing-access-policy.ts';

const full = { canView:true, canAdd:true, canEdit:true };
const base = { userId:'user-a',companyId:'company-a',roleId:'legacy',roleCode:'ACCOUNTS',effectiveRoleIds:['legacy'],hasAllLocationAccess:true,locationScopeIds:[],permissions:{payment_process:full,workforce_payouts:full} };
const member = { role_id:'finance-role',is_active:true,has_all_location_access:false,location_scope_ids:['station-a'] };
function setup({surface='dashboard',authorization=base,members=[member],membershipError=null,roleError=null,grantError=null,roles=[{id:'finance-role',location_access_mode:'role_based'}]}={}) {
  const queries=[];
  const mocks={
    'server-only':{},react:{cache:fn=>fn},'next/navigation':{redirect:path=>{throw new Error(`redirect:${path}`)}},
    '@/lib/access-surface':{currentAdminAccessSurface:()=>surface},
    '@/lib/authorization':{getAuthorization:async()=>authorization,isCompanyOwner:a=>a.isMasterOwner===true,
      hasPermission:(a,p,action)=>!(a.readOnly && action==='edit') && (action==='edit'?a.permissions[p]?.canEdit:a.permissions[p]?.canView)},
    '@/lib/payment-processing-access-policy':{applyFinanceProcessingAccess},
    '@/lib/access-cache':{loadRolePageGrants:async(company,ids)=>{
      assert.equal(company,'company-a');assert.deepEqual(ids,['finance-role']);
      if(grantError) throw new Error(grantError);
      return {pages:[{id:'p',code:'payment_process'}],grants:[{page_id:'p',can_view:true,can_add:true,can_edit:true}]};
    }},
    '@/lib/supabase-admin':{supabaseAdmin:{from:table=>{
      const filters=[];queries.push({table,filters});
      const builder={select:()=>builder,eq:(key,value)=>{filters.push([key,value]);return builder},in:(key,value)=>{filters.push([key,value]);return builder},then:resolve=>Promise.resolve(resolve(table==='company_product_memberships'?{data:members,error:membershipError}:{data:roles,error:roleError}))};return builder;
    }}}
  };
  const compiled=ts.transpileModule(readFileSync(new URL('./payment-processing-authorization.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',compiled)(name=>{if(!(name in mocks))throw Error(name);return mocks[name]},module,module.exports);
  return {...module.exports,queries};
}

test('Dashboard loader uses authenticated company/user and only active Finance roles',async()=>{
  const fixture=setup();const access=await fixture.getPaymentProcessingAuthorization();
  assert.deepEqual(access.effectiveRoleIds,['finance-role']);
  assert.deepEqual(access.locationScopeIds,['station-a']);
  assert.deepEqual(fixture.queries[0],{table:'company_product_memberships',filters:[['company_id','company-a'],['user_id','user-a'],['product_code','finance']]});
  assert.deepEqual(fixture.queries[1],{table:'user_roles',filters:[['company_id','company-a'],['product_code','finance'],['is_active',true],['id',['finance-role']]]});
});
test('lookup failures stop processing instead of falling back to broader Dashboard rights',async()=>{
  for(const config of [{membershipError:{message:'unavailable'}},{roleError:{message:'unavailable'}},{grantError:'unavailable'}]) {
    await assert.rejects(setup(config).getPaymentProcessingAuthorization());
  }
});
test('other portals, owners and unauthenticated requests are unchanged',async()=>{
  for(const config of [{surface:'finance'},{surface:'ops'},{surface:'people'},{authorization:null},{authorization:{...base,isMasterOwner:true}}]){
    const fixture=setup(config);assert.equal(await fixture.getPaymentProcessingAuthorization(),config.authorization===undefined?base:config.authorization);assert.equal(fixture.queries.length,0);
  }
});
test('no membership preserves legacy access but disabled membership denies processing',async()=>{
  assert.equal(await setup({members:[]}).getPaymentProcessingAuthorization(),base);
  const fixture=setup({members:[{...member,is_active:false}]});
  await assert.rejects(fixture.requirePaymentProcessingPermission('edit'),/unauthorized/);
});
test('server actions cannot use a preview or missing session to process a payment',async()=>{
  await assert.rejects(setup({authorization:{...base,readOnly:true}}).requirePaymentProcessingPermission('edit'),/unauthorized/);
  await assert.rejects(setup({authorization:null}).requirePaymentProcessingPermission('edit'),/login/);
});
test('all processing entrypoints use the same role and scope resolution',()=>{
  for(const path of ['../app/api/payments/process/bank-response/route.ts','../app/api/payments/process/download/route.ts']) {
    const source=readFileSync(new URL(path,import.meta.url),'utf8');
    assert.match(source,/await getPaymentProcessingAuthorization\(\)/);
    assert.doesNotMatch(source,/await getAuthorization\(\)/);
  }
  for(const path of ['../app/payments/process/page.tsx','../app/payments/process/actions.ts']) {
    const source=readFileSync(new URL(path,import.meta.url),'utf8');
    assert.match(source,/await requirePaymentProcessingPermission\(/);
    assert.doesNotMatch(source,/requirePagePermission\("payment_process"/);
  }
});
