import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
function load(file,require=()=>({})){const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,require);return exports;}
const rules=load('src/lib/fleet/audit-rules.ts');
let auth={isMasterOwner:false,userId:'user',hasAllLocationAccess:true,locationScopeIds:['station']};let membership=true;let edit=true;let rpcPayload;
const item={id:'tyre',is_required:true,label:'Front tyre',category:'Tyres',audit_mode:'both',response_config:rules.auditPresets.condition};
const records={fleet_audits:{id:'audit',vehicle_id:'vehicle',template_id:'template',status:'in_progress',scheduled_reason:'[mode:physical]',fleet_vehicles:{vehicle_no:'KL11CC2822',station_code:'KOZA'}},fleet_control_settings:{audit_video_required:false,audit_email_enabled:false},fleet_vehicles:{fuel_type:'Diesel',station_code:'KOZA'},fleet_audit_checklist_items:[item],stations:[{station_code:'KOZA'}]};
const db={from(table){const builder=new Proxy({}, {get(_,key){if(key==='then')return(resolve)=>resolve({data:records[table],error:null});return()=>builder;}});return builder;},async rpc(name,payload){rpcPayload=payload;return {error:null}}};
const api=load('src/app/api/fleet-control/route.ts',name=>({
 '@/lib/fleet/audit-rules':rules,'@/lib/ops-pulse/cod':{todayKolkata:()=> '2026-10-05'},'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},'@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:(_,code,action)=>action==='access'||(edit&&code==='fleet_audits')},'@/lib/company-scope':{requireCompanyId:()=> 'company'},'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/access-surface':{fleetAccessPageCodes:['fleet_audits']},'@/lib/fleet-control':{hasActiveFleetMembership:async()=>membership},'@/lib/email':{sendEmail:()=>{throw new Error('Tests must not send email')}}
}[name]||{}));
const submit=async body=>{rpcPayload=undefined;const response=await api.POST(new Request('https://fleet.test/api/fleet-control',{method:'POST',body:JSON.stringify({action:'audit.complete',auditId:'audit',sendEmail:false,...body})}));return {status:response.status,body:await response.json()};};
const response={itemId:'tyre',value:'poor',passed:true,comments:'Worn tread',days:7,action:'Replace'};
let r=await submit({responses:[response]});assert.equal(r.status,400);assert.match(r.body.error,/attach 1 photo/);assert.equal(rpcPayload,undefined);
r=await submit({responses:[{...response,comments:''}]});assert.equal(r.status,400);assert.match(r.body.error,/remark/);
r=await submit({responses:[{...response,days:0}]});assert.equal(r.status,400);assert.match(r.body.error,/days/);
r=await submit({responses:[]});assert.equal(r.status,400);
r=await submit({responses:[{...response,value:'invented'}]});assert.equal(r.status,400);
const evidence=[{itemId:'tyre',url:'https://example.com/tyre.jpg',type:'photo'}];
r=await submit({responses:[response],evidence});assert.equal(r.status,200);assert.equal(rpcPayload.p_data.responses[0].passed,false,'client passed flag cannot override master');assert.equal(rpcPayload.p_data.findings[0].expectedCompletionDate,'2026-10-12');assert.equal(rpcPayload.p_data.status,'failed');
r=await submit({responses:[{...response,value:'needs_immediate_replacement'}],evidence});assert.equal(r.status,200);assert.equal(rpcPayload.p_data.findings[0].expectedCompletionDate,'2026-10-05');assert.equal(rpcPayload.p_data.responses[0].snapshot.days,null);
item.response_config={...item.response_config,options:item.response_config.options.map(o=>({...o,photos:o.issue?2:0}))};r=await submit({responses:[response],evidence:[...evidence,...evidence]});assert.equal(r.status,400,'same file cannot satisfy two photos');
membership=false;r=await submit({});assert.equal(r.status,403);membership=true;edit=false;r=await submit({});assert.equal(r.status,403);edit=true;auth.hasAllLocationAccess=false;records.stations=[{station_code:'OTHER'}];r=await submit({});assert.equal(r.status,403);
auth=null;r=await submit({});assert.equal(r.status,401);
console.log('Audit API: required answers, configurable photos, duplicate evidence, remarks, deadlines, forged pass flags, membership, module permission and station scope verified.');
