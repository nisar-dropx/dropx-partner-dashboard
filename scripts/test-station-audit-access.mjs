import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
function moduleFrom(path, mocks) { const mod={exports:{}}; const js=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText; new Function('require','module','exports',js)((id)=>{ if (!(id in mocks)) throw new Error(`Unexpected dependency ${id}`); return mocks[id]; },mod,mod.exports);return mod.exports; }
const planning=moduleFrom('src/lib/ops-pulse/station-audit-planning.ts',{});
const settings={company_id:'company',scheduler_role_ids:['manager'],responder_role_ids:['station'],excluded_location_model_ids:[],excluded_location_ids:[],exclude_head_office:true};
const type={id:'type',company_id:'company',code:'physical',cadence_unit:'monthly',required_count:1,is_active:true,scheduling_config:{period_slots:[{code:'standard'}]},default_response_hours:24};
const stations=['A','B'].map(id=>({id,company_id:'company',station_code:id,is_active:true,hide_from_location_list:false,is_ho:false,location_model_id:null}));
const audits=['scheduled','in_progress','under_review','closed','awaiting_station_response'].flatMap((status_code,index)=>stations.map(station=>({id:`${station.id}-${index}`,company_id:'company',location_id:station.id,audit_type_id:'type',status_code,scheduled_for:'2099-10-05T15:00:00Z',completed_at:index>1?'2099-10-05T16:00Z':null,started_at:index>0?'2099-10-05T15:30Z':null,station_response_status:'requested',stations:station,ops_audit_types:type,manager_summary:'Private manager note'})));
const tables={ops_audit_types:[type],ops_audit_checklist_sections:[],ops_audit_checklist_items:[],ops_audit_reference_options:[],ops_audit_programme_settings:[settings],stations,ops_station_audits:audits,ops_station_audit_events:[],ops_station_audit_comments:[{id:'private',company_id:'company',audit_id:'A-2',audience:'managers',author_email:'another@example.test'},{id:'public',company_id:'company',audit_id:'A-2',audience:'station'}]};
let rpcCalls=0; const queries=[];
const db={from(table){const filters=[]; let single=false; const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},is(k,v){filters.push(r=>(r[k]??null)===v);return q},or(){return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},not(k,op,v){filters.push(r=>r[k]!==v);return q},gte(){return q},lte(){return q},order(){return q},limit(){return q},range(){return q},maybeSingle(){single=true;return q},then(resolve){queries.push(table);const rows=(tables[table]||[]).filter(r=>filters.every(f=>f(r)));return Promise.resolve({data:single?rows[0]||null:rows,error:null}).then(resolve)}};return q},rpc(){rpcCalls++;return Promise.resolve({data:null,error:null})}};
const lib=moduleFrom('src/lib/ops-pulse/station-audits.ts',{'@/lib/ops-pulse/station-audit-query':{allAuditRows:async(build)=>build(0,499),auditRowsForIds:async(ids,build)=>build(ids,0,499)},'server-only':{},'node:crypto':{randomUUID:()=> 'uuid'},'./station-audit-planning':planning,'./station-audit-people':{loadAuditAssignees:async()=>[]},'@/lib/supabase-admin':{supabaseAdmin:db}});
let auth={userId:'manager-user',fullName:'Manager',email:'manager@example.test',isMasterOwner:false,hasAllLocationAccess:false,locationScopeIds:['A'],effectiveRoleIds:['manager'],permissions:{station_audits:{canAdd:true,canEdit:true}}};
for (const roles of [['manager'],['station'],['viewer']]) {
 const workspace=await lib.loadStationAuditWorkspace('company',{...auth,effectiveRoleIds:roles},'2099-10-01','2099-10-31',false);
 assert.deepEqual(workspace.stations.map(s=>s.id),['A']);assert.ok(workspace.audits.every(a=>a.location_id==='A'));
 if(roles[0]!=='manager'){assert.ok(workspace.audits.every(a=>a.completed_at&&!['scheduled','in_progress'].includes(a.status_code)));assert.ok(workspace.audits.every(a=>a.manager_summary===null));assert.deepEqual(workspace.comments.map(c=>c.id),['public']);}
 else assert.equal(workspace.audits.length,5);
}
const empty=await lib.loadStationAuditWorkspace('company',{...auth,locationScopeIds:[]},'2099-10-01','2099-10-31');assert.equal(empty.audits.length,0);
const actions=moduleFrom('src/app/ops-pulse/audits/actions.ts',{'@/lib/ops-pulse/station-audit-reconciliation':{},'@/lib/ops-pulse/station-audit-photos':{},'@/lib/ops-pulse/station-audit-scoring':moduleFrom('src/lib/ops-pulse/station-audit-scoring.ts',{}),'next/cache':{revalidatePath(){}},'@/lib/authorization':{async requirePagePermission(){if(auth.readOnly)throw new Error('Preview is read-only');return auth}},'@/lib/company-scope':{requireCompanyId:()=> 'company'},'@/lib/ops-pulse/station-audit-email':{},'@/lib/ops-pulse/station-audit-people':{canDeleteStationAudit:()=>false,loadAuditAssignees:async()=>[]},'@/lib/ops-pulse/upload':{},'@/lib/ops-pulse/station-audits':lib,'@/lib/ops-pulse/station-audit-planning':planning,'@/lib/supabase-admin':{supabaseAdmin:db}});
const form=(id)=>{const data=new FormData();for(const [k,v]of Object.entries({audit_id:id,scheduled_date:'2099-10-06',scheduled_time:'10:00',period_slot:'standard',original_scheduled_for:'2099-10-05T15:00:00Z',reason:'Moved visit'}))data.set(k,v);return data};
assert.equal((await actions.rescheduleStationAudit(form('B-0'))).ok,false);assert.equal(rpcCalls,0,'out-of-scope audit cannot reach mutation');
auth={...auth,effectiveRoleIds:['station']};assert.equal((await actions.rescheduleStationAudit(form('A-0'))).ok,false);assert.equal(rpcCalls,0);
auth={...auth,effectiveRoleIds:['manager'],readOnly:true};assert.equal((await actions.rescheduleStationAudit(form('A-0'))).ok,false);assert.equal(rpcCalls,0);
auth={...auth,readOnly:false};assert.equal((await actions.rescheduleStationAudit(form('A-1'))).ok,false);assert.equal(rpcCalls,0);
assert.equal((await actions.rescheduleStationAudit(form('A-0'))).ok,true);assert.equal(rpcCalls,1);
console.log('Audit access tests passed: tenant/location filtering, station and unconfigured-role schedule privacy, private notes, role checks, preview guard and mutation scope.');

for(const a of audits) a.audit_number=`AUD-${a.id}`;
let generated=0;
const report=moduleFrom('src/app/api/ops-pulse/audits/report/[id]/route.ts',{'@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:()=>Boolean(auth)},'@/lib/company-scope':{requireCompanyId:()=> 'company'},'@/lib/ops-pulse/station-audits':lib,'@/lib/ops-pulse/station-audit-planning':planning,'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/ops-pulse/station-audit-report-data':{buildStationAuditReport:async()=>{generated++;return {pdf:Buffer.from('pdf-fixture')}}}});
assert.equal((await report.GET(new Request('https://ops.dropxlogistics.com'),{params:{id:'B-2'}})).status,404);assert.equal(generated,0);
assert.equal((await report.GET(new Request('https://ops.dropxlogistics.com'),{params:{id:'A-0'}})).status,404);assert.equal(generated,0);
auth={...auth,effectiveRoleIds:['station']};assert.equal((await report.GET(new Request('https://ops.dropxlogistics.com'),{params:{id:'A-2'}})).status,200);assert.equal(generated,1);
auth=null;assert.equal((await report.GET(new Request('https://ops.dropxlogistics.com'),{params:{id:'A-2'}})).status,403);assert.equal(generated,1);
console.log('PDF report: tenant/location scope, scheduled-audit privacy and signed-out denial passed.');
