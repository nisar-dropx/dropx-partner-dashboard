import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
import ts from "typescript";
import {buildTemplatePayload} from "./whatsapp-template-builder.ts";
const require=createRequire(import.meta.url);
const filename=new URL("../app/settings/whatsapp-template-actions.ts",import.meta.url);
const source=fs.readFileSync(filename,"utf8");
const permission=source.includes('"workforce_whatsapp"')?"workforce_whatsapp":"app_settings";
const draft={name:"station_notice",language:"en",category:"UTILITY",body:"Your station notice is available in DropX One.",header:"",footer:"",samples:{},buttonText:"",buttonUrl:""};
function harness({denied=false,profileCompany="company-a",metaError=false}={}){
 const calls=[],cache=[];let providerCalls=0;
 const profile={id:"sender-a",company_id:profileCompany,is_active:true,business_account_id:"123",graph_api_version:"v25.0",profile_name:"Test sender",is_default:true};
 const admin={rpc:async(name,args)=>{calls.push({rpc:name,args});return {data:"secret",error:null};},from(table){
   const filters=[];let operation="select",values;
   const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},neq(){return q;},in(){return q;},order(){return q;},limit(){return q;},maybeSingle(){return result(true);},
    upsert(data){operation="upsert";values=data;return q;},update(data){operation="update";values=data;return q;},then(resolve,reject){return result(false).then(resolve,reject);}};
   async function result(single){
    calls.push({table,operation,filters,values});
    if(operation==="upsert"){for(const row of Array.isArray(values)?values:[values])cache.push(row);return {data:null,error:null};}
    if(operation==="update")return {data:null,error:null};
    const rows=(table==="whatsapp_profiles"?[profile]:cache).filter(row=>filters.every(([k,v])=>row[k]===v));
    return {data:single?(rows[0]||null):rows,error:null};
   }return q;
 }};
 const dependencies={
  "next/cache":{revalidatePath(){}},
  "@/lib/authorization":{requirePagePermission:async(code,action)=>{calls.push({permission:code,action});if(denied)throw Error("Access denied");return {companyId:"company-a",permissions:{[permission]:{canEdit:true}}};}},
  "@/lib/company-scope":{requireCompanyId:a=>a.companyId},
  "@/lib/supabase-admin":{supabaseAdmin:admin},
  "@/lib/whatsapp-template-builder":{buildTemplatePayload},
  "@/lib/whatsapp-template-meta":{
   templateGraphRequest:async()=>{providerCalls++;if(metaError)throw Error("Meta permission denied");return {id:"12345",status:"PENDING",category:"UTILITY"};},
   listMetaTemplates:async()=>[{id:"12345",name:draft.name,language:"en",status:"APPROVED",category:"UTILITY",components:[{type:"BODY",text:draft.body}]}]
  },
  "@/lib/whatsapp-template-sync":{syncWhatsAppTemplateCache:async()=>[{template_id:"12345",whatsapp_profile_id:"sender-a",name:draft.name,language:"en",status:"APPROVED",category:"UTILITY",components:[{type:"BODY",text:draft.body}],synced_at:new Date().toISOString(),rejected_reason:""}]}
 };
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 new Function("require","module","exports",output)(name=>{if(!(name in dependencies))throw Error("Unmocked import "+name);return dependencies[name];},module,module.exports);
 return {api:module.exports,calls,cache,providerCalls:()=>providerCalls};
}
test("create uses existing edit permission and caches Meta PENDING response",async()=>{
 const h=harness();const result=await h.api.submitWhatsAppTemplate("sender-a",draft);
 assert.equal(result.template.status,"PENDING");assert.equal(h.cache[0].company_id,"company-a");
 assert.equal(h.calls[0].permission,permission);assert.equal(h.calls[0].action,"edit");
 assert.equal(h.providerCalls(),1);
});
test("refresh makes approved template available without creating or sending",async()=>{
 const h=harness();const result=await h.api.refreshTemplateLibrary("sender-a");
 assert.equal(result.templates[0].status,"APPROVED");assert.equal(h.providerCalls(),0);
});
test("duplicate template is rejected before another provider submission",async()=>{
 const h=harness();await h.api.submitWhatsAppTemplate("sender-a",draft);
 const result=await h.api.submitWhatsAppTemplate("sender-a",draft);
 assert.match(result.error,/already exist/);assert.equal(h.providerCalls(),1);
});
test("Meta failure produces actionable error without caching an approved template",async()=>{
 const h=harness({metaError:true});const result=await h.api.submitWhatsAppTemplate("sender-a",draft);
 assert.match(result.error,/permission denied/);assert.equal(h.cache.length,0);
});
test("foreign company sender cannot expose its token or call Meta",async()=>{
 const h=harness({profileCompany:"company-b"});
 await assert.rejects(()=>h.api.submitWhatsAppTemplate("sender-a",draft),/active sender/);
 assert.equal(h.calls.some(c=>c.rpc),false);assert.equal(h.providerCalls(),0);
});
test("denied permission stops every template action before database access",async()=>{
 const h=harness({denied:true});
 await assert.rejects(()=>h.api.loadTemplateLibrary(),/Access denied/);
 await assert.rejects(()=>h.api.submitWhatsAppTemplate("sender-a",draft),/Access denied/);
 await assert.rejects(()=>h.api.refreshTemplateLibrary("sender-a"),/Access denied/);
 assert.equal(h.calls.some(c=>c.table||c.rpc),false);
});

