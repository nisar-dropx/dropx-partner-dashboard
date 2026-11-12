import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
function load(file,require=()=>({})){const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,require);return exports;}
const rules=load('src/lib/fleet/audit-rules.ts');
let auth={isMasterOwner:false,userId:'user',hasAllLocationAccess:true,locationScopeIds:['station']};let membership=true;let edit=true;let rpcPayload;let rpcName;
const item={id:'tyre',is_required:true,label:'Front tyre',category:'Tyres',audit_mode:'both',response_config:rules.auditPresets.condition};
const records={
  fleet_audits:{id:'audit',vehicle_id:'vehicle',template_id:'template',status:'in_progress',scheduled_for:'2026-10-05',scheduled_reason:'[mode:physical]',completed_at:null,summary:'',odometer_km:null,revision_draft:{},revision_count:0,draft:{},fleet_vehicles:{vehicle_no:'KL11CC2822',station_code:'KOZA',model:'Ace'}},
  fleet_control_settings:{audit_video_required:false,audit_email_enabled:false},
  fleet_vehicles:{ownership_type:'own',fuel_type:'Diesel',station_code:'KOZA'},
  fleet_audit_checklist_items:[item],
  fleet_audit_responses:[],
  fleet_audit_evidence:[],
  stations:[{station_code:'KOZA'}],
  dashboard_app_event_logs:[]
};
const db={from(table){const builder=new Proxy({}, {get(_,key){if(key==='then')return(resolve)=>resolve({data:records[table],error:null});if(key==='insert')return(row)=>{if(Array.isArray(records[table]))records[table].push(row);return builder;};if(key==='update')return(patch)=>{if(records[table]&&typeof records[table]==='object'&&!Array.isArray(records[table]))Object.assign(records[table],patch);return builder;};return()=>builder;}});return builder;},async rpc(name,payload){rpcName=name;rpcPayload=payload;return {error:null}}};
const api=load('src/app/api/fleet-control/route.ts',name=>({
 '@/lib/fleet/system-log':{withFleetSystemLog:fn=>fn},
 '@/lib/fleet/audit-health':load('src/lib/fleet/audit-health.ts'),'@/lib/fleet/audit-rules':rules,'@/lib/ops-pulse/cod':{todayKolkata:()=> '2026-10-05'},'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},'@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:(_,code,action)=>action==='access'||(edit&&code==='fleet_audits')},'@/lib/company-scope':{requireCompanyId:()=> 'company'},'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/access-surface':{fleetAccessPageCodes:['fleet_audits']},'@/lib/fleet-control':{hasActiveFleetMembership:async()=>membership},'@/lib/email':{sendEmail:()=>{throw new Error('Tests must not send email')}},'@/lib/fleet/audit-email':{buildFleetAuditEmail:()=>({subject:'x',text:'x',html:'x'})},'@/lib/fleet/audit-programme-config':{auditProgrammeFromRiskWeights:()=>({}),normalizeFleetAuditProgrammeConfig:(c)=>c}
}[name]||{}));
const post=async body=>{rpcPayload=undefined;rpcName=undefined;const response=await api.POST(new Request('https://fleet.test/api/fleet-control',{method:'POST',body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
const submit=async body=>post({action:'audit.complete',auditId:'audit',sendEmail:false,...body});
const response={itemId:'tyre',value:'poor',passed:true,comments:'Worn tread',days:7,action:'Replace'};
let r=await submit({responses:[response]});assert.equal(r.status,400);assert.match(r.body.error,/attach 1 photo/);assert.equal(rpcPayload,undefined);
r=await submit({responses:[{...response,comments:''}]});assert.equal(r.status,400);assert.match(r.body.error,/remark/);
r=await submit({responses:[{...response,days:0}]});assert.equal(r.status,400);assert.match(r.body.error,/days/);
r=await submit({responses:[]});assert.equal(r.status,400);
r=await submit({responses:[{...response,value:'invented'}]});assert.equal(r.status,400);
const evidence=[{itemId:'tyre',url:'https://example.com/tyre.jpg',type:'photo'}];
r=await submit({responses:[response],evidence});assert.equal(r.status,200);assert.equal(rpcPayload.p_data.responses[0].passed,false,'client passed flag cannot override master');assert.equal(rpcPayload.p_data.findings[0].expectedCompletionDate,'2026-10-12');assert.equal(rpcPayload.p_data.status,'failed');assert.equal(rpcPayload.p_data.score,25);assert.equal(rpcPayload.p_data.responses[0].snapshot.scoring.version,1);assert.equal(rpcPayload.p_data.responses[0].snapshot.category,'Tyres');
r=await submit({responses:[{...response,value:'needs_immediate_replacement'}],evidence});assert.equal(r.status,200);assert.equal(rpcPayload.p_data.findings[0].expectedCompletionDate,'2026-10-05');assert.equal(rpcPayload.p_data.responses[0].snapshot.days,null);
item.response_config={...item.response_config,options:item.response_config.options.map(o=>({...o,photos:o.issue?2:0}))};r=await submit({responses:[response],evidence:[...evidence,...evidence]});assert.equal(r.status,400,'same file cannot satisfy two photos');
membership=false;r=await submit({});assert.equal(r.status,403);membership=true;edit=false;r=await submit({});assert.equal(r.status,403);edit=true;auth.hasAllLocationAccess=false;records.stations=[{station_code:'OTHER'}];r=await submit({});assert.equal(r.status,403);
auth.hasAllLocationAccess=true;auth.isMasterOwner=true;for(const source of ['odcd','rented',null]){records.fleet_vehicles.ownership_type=source;for(const action of ['audit.schedule','audit.start','audit.draft','audit.complete','service.create','service.schedule']){r=await submit({action,vehicleId:'vehicle'});assert.equal(r.status,400);assert.match(r.body.error,/DropX-owned/);assert.equal(rpcPayload,undefined);}}
auth=null;r=await submit({});assert.equal(r.status,401);

auth={isMasterOwner:false,userId:'user',hasAllLocationAccess:true,locationScopeIds:['station']};membership=true;edit=true;records.fleet_vehicles.ownership_type='own';records.stations=[{station_code:'KOZA'}];
item.response_config=rules.auditPresets.condition;
Object.assign(records.fleet_audits,{status:'failed',completed_at:new Date().toISOString(),summary:'Needs tyre',odometer_km:1200,revision_draft:{},revision_count:0,draft:{}});
records.fleet_audit_responses=[{checklist_item_id:'tyre',response_value:{value:'poor',label:'Front tyre',action:'Replace',days:7},comments:'Worn tread'}];
records.fleet_audit_evidence=[{checklist_item_id:'tyre',media_type:'photo',media_url:'https://example.com/tyre.jpg',caption:'Tyre',created_at:new Date().toISOString()}];

r=await post({action:'audit.begin-revision',auditId:'audit'});
assert.equal(r.status,200);
assert.equal(r.body.draft.item_tyre,'poor');
assert.equal(r.body.draft.photo_tyre_0,'https://example.com/tyre.jpg');
assert.equal(r.body.draft.sendEmail,'no');
assert.equal(records.fleet_audits.revision_draft.item_tyre,'poor');

r=await post({action:'audit.draft',auditId:'audit',draft:{item_tyre:'good',sendEmail:'no'}});
assert.equal(r.status,200);
assert.equal(records.fleet_audits.status,'failed');
assert.equal(records.fleet_audits.revision_draft.item_tyre,'good');
assert.equal(records.fleet_audits.draft.item_tyre,undefined);

r=await post({action:'audit.revise',auditId:'audit',sendEmail:false,responses:[{itemId:'tyre',value:'good',comments:'',days:7,action:''}],evidence:[{itemId:'tyre',url:'https://example.com/tyre.jpg',type:'photo'}]});
assert.equal(r.status,200);
assert.equal(rpcName,'fleet_revise_audit_v1');
assert.equal(rpcPayload.p_data.status,'passed');
assert.equal(rpcPayload.p_data.sendEmail,false);
assert.equal(r.body.revisionCount,1);

records.fleet_audits.completed_at=new Date(Date.now()-8*24*60*60*1000).toISOString();
records.fleet_audits.revision_count=1;
r=await post({action:'audit.begin-revision',auditId:'audit'});
assert.equal(r.status,400);assert.match(r.body.error,/7 days/);

auth.isMasterOwner=true;
r=await post({action:'audit.begin-revision',auditId:'audit'});
assert.equal(r.status,200);

r=await post({action:'audit.revise',auditId:'audit',sendEmail:false,responses:[{itemId:'tyre',value:'poor',comments:'Still worn',days:7,action:'Replace'}],evidence});
assert.equal(r.status,200);
assert.equal(rpcName,'fleet_revise_audit_v1');
assert.equal(rpcPayload.p_data.status,'failed');
assert.equal(r.body.revisionCount,2);

console.log('Audit API: complete validation, begin-revision hydrate, revision draft, revise RPC, 7-day window and owner bypass verified.');
