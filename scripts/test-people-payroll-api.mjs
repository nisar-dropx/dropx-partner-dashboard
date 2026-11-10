import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import test from 'node:test';
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
function compile({ readOnly=false, edit=true, deniedStation='', missing=false, rpcError=null }={}) {
 const calls=[], scopes=[], auth={userId:id(1),readOnly,hasAllLocationAccess:false,locationScopeIds:[id(4),id(5)]};
 const db={from(){return {select(){return this},eq(){return this},in(_field,ids){this.ids=ids;return this},then(resolve){resolve({data:missing?[]:this.ids.map((r,i)=>({id:r,station_id:id(4+i),run_id:id(6)})),error:null})}}},rpc(name,args){calls.push({name,args});return {data:{instructions:[{amountPaise:10000,debitAccountNumber:'00012345',valueDate:'2026-11-10'}]},error:rpcError}}};
 const mocks={
 '@/lib/payment-release-access':{paymentReleaseAccess:async write=>{if(write&&(readOnly||!edit))throw Error('No edit access');return {auth,company:id(2),db}},assertReleaseStation:async(_auth,_company,s)=>{scopes.push(s);if(s===deniedStation)throw Error('Station outside your access')}},
 '@/lib/authorization':{hasPermission:()=>edit},'@/lib/supabase-pagination':{},
 '@/lib/workforce-payout-bank-file':{buildWorkforceFedOneWorkbook:()=>new Uint8Array([1,2,3])},'@/lib/people-payroll-finance':{}
 };
 const m={exports:{}};new Function('require','exports','module',ts.transpileModule(fs.readFileSync('src/app/api/payments/people-payroll/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(k=>mocks[k],m.exports,m);
 return {...m.exports,calls,scopes};
}
const body={action:'bank_file_combined',requestIds:[id(7),id(8)],bankId:id(9),operationId:id(10),valueDate:'2026-11-10',expected:{[id(7)]:{version:2}}};
const req=(value=body,origin)=>new Request('https://fin.dropxlogistics.com/api/payments/people-payroll',{method:'POST',headers:origin?{origin}:{},body:JSON.stringify(value)});
test('combined export validates every location before any issuance',async()=>{const r=compile({deniedStation:id(5)});assert.equal((await r.POST(req())).status,409);assert.equal(r.scopes.length,2);assert.equal(r.calls.length,0)});
test('preview, view-only, cross-origin, missing and duplicate submissions cannot issue',async()=>{for(const opts of [{readOnly:true},{edit:false},{missing:true}]){const r=compile(opts);assert.equal((await r.POST(req())).status,409);assert.equal(r.calls.length,0)}const r=compile();for(const request of [req(body,'https://wrong.example'),req({...body,requestIds:[id(7),id(7)]}),req({...body,requestIds:['invalid']})])assert.equal((await r.POST(request)).status,409);assert.equal(r.calls.length,0)});
test('one atomic RPC carries reviewed totals, identity and persistent operation',async()=>{const r=compile();const response=await r.POST(req());assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/spreadsheetml/);assert.equal(r.calls.length,1);assert.deepEqual(r.calls[0],{name:'people_finance_issue_many',args:{p_company:id(2),p_requests:body.requestIds,p_actor:id(1),p_operation:id(10),p_bank:id(9),p_value_date:body.valueDate,p_expected:body.expected}})});
test('database failure returns a useful location-specific message and no file',async()=>{const r=compile({rpcError:{code:'P0001',message:'HO_KL: current Finance approval is required.'}});const response=await r.POST(req());assert.equal(response.status,409);assert.equal((await response.json()).error,'HO_KL: current Finance approval is required.')});
test('approve/download carries explicit override reason only to the atomic checked function',async()=>{const r=compile();const response=await r.POST(req({...body,action:'approve_download',overrideReason:'Accidental return; release reviewed payroll'}));assert.equal(response.status,200);assert.equal(r.calls.length,1);assert.equal(r.calls[0].name,'people_finance_approve_and_issue');assert.equal(r.calls[0].args.p_override_reason,'Accidental return; release reviewed payroll');assert.deepEqual(r.calls[0].args.p_requests,body.requestIds)});
test('ordinary approval supplies an audit note; return still requires an explicit correction reason',async()=>{const r=compile();assert.equal((await r.POST(req({action:'approve',requestId:id(7),version:2}))).status,200);assert.match(r.calls[0].args.p_reason,/reviewed and approved/);const denied=compile();assert.equal((await denied.POST(req({action:'return',requestId:id(7),version:2}))).status,409);assert.equal(denied.calls.length,0)});
