import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import * as policy from './assistant-policy.ts';
import * as docs from '../business-document-workspace-policy.ts';
const source=ts.transpileModule(readFileSync(new URL('./assistant-data.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const auth={companyId:'company',userId:'user',roleId:'manager',locationScopeIds:['ds','lm'],hasAllLocationAccess:false,isMasterOwner:false};
const locations=[{id:'ds',station_code:'TCC3'}],dates={from:'2026-10-01',to:'2026-10-25',asOf:'2026-10-25'};
function setup({allow=true}={}){
 const calls=[];
 const tables={
  ops_store_audit_master:{data:{company_id:'company'}},
  business_document_records:{data:[
   {scope_type:'location',scope_id:'ds',document_type_id:'ordinary',document_type_code:'allowed'},
   {scope_type:'location',scope_id:'lm',document_type_id:'ordinary',document_type_code:'other workspace'},
   {scope_type:'provider',scope_id:'provider',document_type_id:'ordinary',document_type_code:'restricted provider'},
   {scope_type:'company',document_type_id:'private',document_type_code:'restricted role',document_types:{doc_access_mode:'role_based'}}]},
  document_type_role_access:{data:[{document_type_id:'private',role_id:'finance'}]},stations:{data:[{id:'ds',state:'TN',provider_id:'provider'}]}
 };
 const db={from(name){return dbQuery({...tables[name],error:null});}};
 function dbQuery(result){return new Proxy(result,{get(t,k){if(k==='then')return resolve=>resolve(result);return ()=>dbQuery(result);}})}
 const mocks={'server-only':{},'@/lib/authorization':{hasPermission:()=>allow},'@/lib/supabase-admin':{supabaseAdmin:db},'./assistant-policy':policy,'@/lib/business-document-workspace-policy':docs,'@/lib/mcp/dates':{indiaDate:()=>dates.asOf},'./store-audits/server':{workspace:async(a)=>{calls.push(a);return {audits:[{location_id:'ds',store_name:'TCC3',number:'visible',findings:[]},{location_id:'lm',number:'outside',findings:[]}]};}},'./station-audits':{loadStationAuditWorkspace:async(c,a)=>{calls.push(a);return {audits:[],truncated:false};}},'@/lib/mcp/tools':{callMcpTool:async(a,n,args)=>{calls.push({a,n,args});return {rows:[]};}}};
 const module={exports:{}};new Function('require','module','exports',source)(n=>mocks[n]||{},module,module.exports);
 return {...module.exports,calls};
}
test('adapter rejects permissions and mixed station requests before loading data',async()=>{
 const denied=setup({allow:false});await assert.rejects(denied.readAssistantData(auth,locations,true,'ops_store_audit_summary',{},dates),/permissions/);assert.equal(denied.calls.length,0);
 const scoped=setup();await assert.rejects(scoped.readAssistantData(auth,locations,true,'ops_store_audit_summary',{stationCodes:['TCC3','KTUR']},dates),/outside/);assert.equal(scoped.calls.length,0);
});
test('audit reads delegate to canonical visibility policy and remain location restricted',async()=>{
 const h=setup(),r=await h.readAssistantData({...auth,hasAllLocationAccess:true,isMasterOwner:true},locations,true,'ops_store_audit_summary',{},dates);
 assert.deepEqual(r.rows.map(x=>x.number),['visible']);assert.equal(h.calls[0].userId,'user');assert.equal(h.calls[0].isMasterOwner,false);assert.equal(h.calls[0].hasAllLocationAccess,false);assert.deepEqual(h.calls[0].locationScopeIds,['ds']);assert.equal(h.calls[0].readOnly,true);
});
test('document metadata matches page role and provider policy as well as workspace',async()=>{
 const h=setup(),r=await h.readAssistantData(auth,locations,true,'ops_business_documents',{},dates);assert.deepEqual(r.rows.map(x=>x.document),['allowed']);
 const owner=await h.readAssistantData({...auth,isMasterOwner:true},locations,true,'ops_business_documents',{},dates);assert.deepEqual(owner.rows.map(x=>x.document),['allowed','restricted provider','restricted role']);
});
