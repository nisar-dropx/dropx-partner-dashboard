import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function compile(auth,permission=true,station='A',fieldType='fixed_daily'){
 const writes=[];
 const mocks={
 '@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:()=>permission},
 '@/lib/ops-pulse/cps-data':{cpsScope:async()=>({companyId:'company',all:[{id:'station-a',station_code:'A'}]})},
 '@/lib/ops-pulse/cps':{isoDate:v=>typeof v==='string'&&/^20\d\d-\d\d-\d\d$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v},
 '@/lib/supabase-admin':{supabaseAdmin:{from(table){return {select(){return this},eq(){return this},order(){return this},limit(){return this},maybeSingle(){return Promise.resolve({data:table==='designations'?{code:'CLM',name:'Cluster Manager'}:table==='payment_fields'?{code:'VAN_RENT_PER_DAY',label:'Van rental',calculation_type:fieldType}:{id:'bill',station_code:station},error:null})},upsert(value){writes.push({table,value});return Promise.resolve({error:null})},insert(value){writes.push({table,value});return this},update(value){writes.push({table,value});return this},then(resolve){return Promise.resolve(resolve({data:[{id:'saved'}],error:null}))}}}}}
 };
 const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(k=>mocks[k],m.exports,m);return {...m.exports,writes};
}
const auth={userId:'owner',hasAllLocationAccess:true};
const req=body=>new Request('https://ops.dropxlogistics.com/api/ops-pulse/cps/settings',{method:'POST',body:JSON.stringify(body)});
const rule={kind:'people',designation_code:'CLM',mode:'managed',head:'UTR',label:'Manager share',allocation:'equal',effective_from:'2026-09-01'};
test('CPS rules reject signed-out, preview, unauthorized and station-only editors',async()=>{
 for(const [a,allowed] of [[null,true],[{...auth,readOnly:true},true],[auth,false],[{...auth,hasAllLocationAccess:false},true]]){const r=compile(a,allowed);assert.equal((await r.POST(req(rule))).status,403);assert.equal(r.writes.length,0)}
});
test('effective rules use authenticated company and actor; invalid dates fail',async()=>{
 const r=compile(auth);assert.equal((await r.POST(req({...rule,company_id:'forged',updated_by:'forged'}))).status,200);assert.equal(r.writes[0].value.company_id,'company');assert.equal(r.writes[0].value.updated_by,'owner');
 assert.equal((await r.POST(req({...rule,effective_from:'2026-02-31'}))).status,400);
});
test('bill period changes require scope and preserve monetary source records',async()=>{
 const bill={kind:'period',source:'payment',source_id:'11111111-1111-1111-1111-111111111111',period_from:'2026-09-01',period_to:'2026-09-30',reason:'Verified bill',amount:1};
 const denied=compile(auth,true,'B');assert.equal((await denied.POST(req(bill))).status,403);assert.equal(denied.writes.length,0);
 const valid=compile({...auth,hasAllLocationAccess:false});assert.equal((await valid.POST(req(bill))).status,200);assert.equal(valid.writes[0].table,'ops_cps_expense_periods');assert.equal(valid.writes[0].value.amount,undefined);
 assert.equal((await valid.POST(req({...bill,period_to:'2026-08-30'}))).status,400);
});

test('rental source rules are company scoped and cannot suppress package payments',async()=>{
 const body={kind:'component',component_code:'VAN_RENT_PER_DAY',mode:'fleet',effective_from:'2026-09-01',company_id:'forged'};
 for(const a of [null,{...auth,readOnly:true},{...auth,hasAllLocationAccess:false}]){
  const r=compile(a);assert.equal((await r.POST(req(body))).status,403);assert.equal(r.writes.length,0);
 }
 const r=compile(auth);assert.equal((await r.POST(req(body))).status,200);
 assert.equal(r.writes[0].table,'ops_cps_component_policies');assert.equal(r.writes[0].value.company_id,'company');assert.equal(r.writes[0].value.updated_by,'owner');
 const production=compile(auth,true,'A','count_x_rate');assert.equal((await production.POST(req(body))).status,400);assert.equal(production.writes.length,0);
});
