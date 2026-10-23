import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function compile(mocks) {
  const module={exports:{}};
  const source=readFileSync(new URL('./payment-reporting-hierarchy.ts',import.meta.url),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','exports','module',js)(name=>{if(name in mocks)return mocks[name];throw Error(name);},module.exports,module);
  return module.exports;
}

function database() {
  const tables={
    org_positions:[
      {id:'station',company_id:'co',reports_to_position_id:'cluster',is_active:true},
      {id:'cluster',company_id:'co',reports_to_position_id:'area',is_active:true},
      {id:'area',company_id:'co',reports_to_position_id:'head',is_active:true},
      {id:'head',company_id:'co',reports_to_position_id:'owner',is_active:true},
      {id:'owner',company_id:'co',reports_to_position_id:null,is_active:true},
      {id:'other-cluster',company_id:'co',reports_to_position_id:'other-head',is_active:true},
      {id:'other-head',company_id:'co',reports_to_position_id:null,is_active:true}
    ],
    position_assignments:[
      {company_id:'co',position_id:'cluster',profile_id:'shihab',valid_from:'2026-01-01',valid_until:null,is_active:true},
      {company_id:'co',position_id:'area',profile_id:'inayat',valid_from:'2026-01-01',valid_until:null,is_active:true},
      {company_id:'co',position_id:'head',profile_id:'ujjal',valid_from:'2026-01-01',valid_until:null,is_active:true},
      {company_id:'co',position_id:'owner',profile_id:'abdul',valid_from:'2026-01-01',valid_until:null,is_active:true},
      {company_id:'co',position_id:'other-head',profile_id:'other',valid_from:'2026-01-01',valid_until:null,is_active:true}
    ],
    profiles:[
      {id:'shihab',company_id:'co',reports_to_user_id:'inayat',is_active:true},
      {id:'inayat',company_id:'co',reports_to_user_id:'ujjal',is_active:true},
      {id:'ujjal',company_id:'co',reports_to_user_id:'abdul',is_active:true},
      {id:'abdul',company_id:'co',reports_to_user_id:null,is_active:true},
      // Deliberately stale legacy link. Because both users have positions,
      // it must not bridge otherwise separate People trees.
      {id:'other',company_id:'co',reports_to_user_id:'abdul',is_active:true},
      {id:'legacy-report',company_id:'co',reports_to_user_id:'legacy-manager',is_active:true},
      {id:'legacy-manager',company_id:'co',reports_to_user_id:null,is_active:true}
    ]
  };
  return {from(table){
    let rows=[...(tables[table]??[])];
    const query={select(){return query;},eq(key,value){rows=rows.filter(row=>row[key]===value);return query;},then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve);}};
    return query;
  }};
}

test('active People position tree grants only same-branch upward payment authority',async()=>{
  const {loadPaymentReportingHierarchy}=compile({
    'server-only':{},
    '@/lib/payment-delegation-policy':{paymentRoutingDay:()=> '2026-10-23'},
    '@/lib/supabase-admin':{supabaseAdmin:database()}
  });
  const hierarchy=await loadPaymentReportingHierarchy('co');
  assert.equal(hierarchy.isStrictlyAbove('inayat','shihab'),true);
  assert.equal(hierarchy.isStrictlyAbove('abdul','shihab'),true);
  assert.equal(hierarchy.isStrictlyAbove('shihab','inayat'),false);
  assert.equal(hierarchy.isStrictlyAbove('other','shihab'),false);
  assert.equal(hierarchy.isStrictlyAbove('abdul','other'),false);
  assert.equal(hierarchy.isSameOrAbove('inayat','inayat'),true);
});

test('legacy People reporting link is used only when positions are absent',async()=>{
  const {loadPaymentReportingHierarchy}=compile({
    'server-only':{},
    '@/lib/payment-delegation-policy':{paymentRoutingDay:()=> '2026-10-23'},
    '@/lib/supabase-admin':{supabaseAdmin:database()}
  });
  const hierarchy=await loadPaymentReportingHierarchy('co');
  assert.equal(hierarchy.isStrictlyAbove('legacy-manager','legacy-report'),true);
});
