import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
// Permission rules for unscheduled audits, cross-station requests and audit changes,
// run against the real server actions with an in-memory database.
function moduleFrom(path, mocks) { const mod={exports:{}}; const js=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText; new Function('require','module','exports',js)((id)=>{ if (!(id in mocks)) throw new Error(`Unexpected dependency ${id}`); return mocks[id]; },mod,mod.exports);return mod.exports; }
const planning=moduleFrom('src/lib/ops-pulse/station-audit-planning.ts',{});
const today=planning.auditDay(); const month=today.slice(0,7);
const slots=(codes)=>({period_slots:codes.map(code=>({code,start_day:1,end_day:31}))});
const types=[{id:'physical',company_id:'company',code:'physical_station',name:'Physical audit',cadence_unit:'monthly',required_count:1,is_active:true,scheduling_config:slots(['standard']),default_response_hours:24},{id:'cod',company_id:'company',code:'virtual_cod',name:'COD audit',cadence_unit:'monthly',required_count:1,is_active:true,scheduling_config:slots(['cod_1']),default_response_hours:24}];
const stations=['A','B'].map(id=>({id,company_id:'company',station_code:id,station_name:`Station ${id}`,is_active:true,hide_from_location_list:false,is_ho:false,location_model_id:null}));
const settings={company_id:'company',scheduler_role_ids:['manager'],responder_role_ids:['station'],excluded_location_model_ids:[],excluded_location_ids:[],exclude_head_office:true,delete_user_ids:[],cross_audit_role_ids:['head']};
const tables={ops_audit_types:types,ops_audit_checklist_sections:[],ops_audit_checklist_items:[],ops_audit_reference_options:[],ops_audit_programme_settings:[settings],stations,ops_station_audits:[],ops_station_audit_events:[],ops_station_audit_requests:[],
 profiles:[{id:'ua',company_id:'company',reports_to_user_id:'um',is_active:true},{id:'ux',company_id:'company',reports_to_user_id:'someone-else',is_active:true}]};
let seq=0, insertError=null, rpcError=null; const rpcCalls=[];
const decorate=(name,row)=>name==='ops_station_audits'?{...row,stations:stations.find(s=>s.id===row.location_id),ops_audit_types:types.find(t=>t.id===row.audit_type_id)}:name==='ops_station_audit_requests'?{...row,stations:stations.find(s=>s.id===row.location_id)}:row;
const db={from(name){const filters=[];let op='select',payload=null,single=false;const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},neq(k,v){filters.push(r=>r[k]!==v);return q},is(k,v){filters.push(r=>(r[k]??null)===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},not(){return q},or(){return q},gte(){return q},lte(){return q},order(){return q},limit(){return q},range(){return q},maybeSingle(){single=true;return q},single(){single=true;return q},insert(v){op='insert';payload=v;return q},update(v){op='update';payload=v;return q},
 then(resolve){const all=tables[name]||(tables[name]=[]);let rows;
  if(op==='insert'){if(insertError&&name==='ops_station_audits')return Promise.resolve({data:null,error:insertError}).then(resolve);const row={id:`${name}-${++seq}`,updated_at:`stamp-${seq}`,deleted_at:null,started_at:null,completed_at:null,status:name==='ops_station_audit_requests'?'pending':undefined,audit_id:null,...payload};all.push(row);rows=[row];}
  else{rows=all.filter(r=>filters.every(f=>f(r)));if(op==='update')rows.forEach(r=>Object.assign(r,payload));}
  return Promise.resolve({data:single?(rows[0]?decorate(name,rows[0]):null):rows.map(r=>decorate(name,r)),error:null}).then(resolve)}};return q},
 rpc(name,args){rpcCalls.push({name,args});return Promise.resolve({data:null,error:name==='change_station_audit'?rpcError:null})},storage:{from(){return{}}}};
// Auditors and the stations each one covers; a head covers every station.
const people=[{id:'ua',name:'Asha',stations:['A']},{id:'ub',name:'Bala',stations:['B']},{id:'um',name:'Manager',stations:['A']},{id:'uh',name:'Head',stations:['A','B']},{id:'ux',name:'Xavier',stations:['A']}];
const loadAuditAssignees=async(company,roles,stationIds)=>people.map(p=>({id:p.id,name:p.name,email:`${p.id}@example.test`,role:'Auditor',stationIds:p.stations.filter(s=>stationIds.includes(s))})).filter(p=>p.stationIds.length);
const lib=moduleFrom('src/lib/ops-pulse/station-audits.ts',{'@/lib/ops-pulse/station-audit-query':{allAuditRows:async(build)=>build(0,499),auditRowsForIds:async(ids,build)=>build(ids,0,499)},'server-only':{},'node:crypto':{randomUUID:()=>`rand${++seq}-0000-0000`},'./station-audit-planning':planning,'./station-audit-people':{loadAuditAssignees},'@/lib/supabase-admin':{supabaseAdmin:db}});
const person=(userId,locationScopeIds,roles=['manager'])=>({userId,fullName:userId,email:`${userId}@example.test`,isMasterOwner:false,hasAllLocationAccess:false,locationScopeIds,effectiveRoleIds:roles,roleName:'Role',roleCode:'ROLE',companyId:'company',permissions:{station_audits:{canAdd:true,canEdit:true}}});
const asha=person('ua',['A']), bala=person('ub',['B']), manager=person('um',['A']), head=person('uh',['A'],['manager','head']), xavier=person('ux',['A']), stationUser=person('us',['A'],['station']);
let auth=asha;
const actions=moduleFrom('src/app/ops-pulse/audits/actions.ts',{'@/lib/ops-pulse/station-audit-evidence':{},'@/lib/ops-pulse/station-audit-reconciliation':{},'@/lib/ops-pulse/station-audit-photos':{},'@/lib/ops-pulse/station-audit-scoring':moduleFrom('src/lib/ops-pulse/station-audit-scoring.ts',{}),'next/cache':{revalidatePath(){}},'@/lib/authorization':{async requirePagePermission(){if(auth.readOnly)throw new Error('Preview is read-only');return auth}},'@/lib/company-scope':{requireCompanyId:()=>'company'},'@/lib/ops-pulse/station-audit-email':{},'@/lib/ops-pulse/station-audit-recipients':{},'@/lib/ops-pulse/station-audit-people':{canDeleteStationAudit:()=>false,loadAuditAssignees},'@/lib/ops-pulse/upload':{},'@/lib/ops-pulse/station-audits':lib,'@/lib/ops-pulse/station-audit-planning':planning,'@/lib/supabase-admin':{supabaseAdmin:db}});
const form=(values)=>{const data=new FormData();for(const [k,v] of Object.entries(values))data.set(k,v);return data};
const as=async(who,run)=>{auth=who;return run()};
const audits=()=>tables.ops_station_audits, requests=()=>tables.ops_station_audit_requests;

// Scope helpers.
assert.equal(lib.stationAuditScope(asha,settings),asha,'an auditor keeps their own station scope');
assert.equal(lib.stationAuditScope(head,settings).hasAllLocationAccess,true,'a cross-audit role reaches every station inside audits');
assert.equal(lib.stationAuditScope(person('uv',['A'],['head']),settings).hasAllLocationAccess,false,'a cross-audit role without an audit manager role gains nothing');
const crossAudit={location_id:'B',assigned_to:'ua',assignment_verified:true,cross_station:true};
assert.equal(lib.canUseStationAudit(asha,crossAudit),true);
for(const change of [{assigned_to:'ub'},{cross_station:false},{assignment_verified:false},{cross_station:undefined}])assert.equal(lib.canUseStationAudit(asha,{...crossAudit,...change}),false);
assert.equal(lib.canUseStationAudit({...asha,userId:''},{...crossAudit,assigned_to:''}),false,'an empty user never matches an unassigned audit');
for(const code of ['42P01','42703','PGRST202','PGRST204'])assert.equal(lib.isAuditSchemaPending({code}),true);
assert.equal(lib.isAuditSchemaPending({code:'23505',message:'duplicate key'}),false);assert.equal(lib.isAuditSchemaPending(null),false);

// 1. An auditor starts an unscheduled audit in their own station at once.
let result=await as(asha,()=>actions.startStationAudit(form({location_id:'A',audit_type_id:'cod',reason:'Surprise check',when:'now'})));
assert.equal(result.ok,true,result.message);
let created=audits().find(a=>a.id===result.auditId);
assert.equal(created.status_code,'in_progress');assert.ok(created.started_at);assert.equal(created.schedule_source,'unscheduled');assert.match(created.period_slot,/^unscheduled-/);assert.equal(created.cycle_key,month);assert.equal(created.assigned_to,'ua');assert.equal('cross_station' in created,false,'an in-scope audit never writes the cross-station column');
assert.deepEqual(tables.ops_station_audit_events.filter(e=>e.audit_id===created.id).map(e=>e.event_type),['scheduled','started']);
// Assigned to a colleague, it waits for them instead of starting.
result=await as(asha,()=>actions.startStationAudit(form({location_id:'A',audit_type_id:'cod',assigned_to:'ux',reason:'Cover',when:'now'})));
assert.equal(result.ok,true,result.message);assert.equal(audits().find(a=>a.id===result.auditId).status_code,'scheduled');
// A reason is required, and a later date must be in the future.
assert.equal((await as(asha,()=>actions.startStationAudit(form({location_id:'A',audit_type_id:'cod',reason:' ',when:'now'})))).ok,false);
assert.equal((await as(asha,()=>actions.startStationAudit(form({location_id:'A',audit_type_id:'cod',reason:'Past',when:'later',scheduled_date:'2000-01-01',scheduled_time:'09:00'})))).ok,false);

// 2. Outside their stations they cannot start, and cannot name an outside auditor.
let before=audits().length;
result=await as(asha,()=>actions.startStationAudit(form({location_id:'B',audit_type_id:'cod',reason:'Try',when:'now'})));
assert.equal(result.ok,false);assert.match(result.message,/cross-station request/);
result=await as(asha,()=>actions.startStationAudit(form({location_id:'A',audit_type_id:'cod',assigned_to:'ub',reason:'Try',when:'now'})));
assert.equal(result.ok,false);assert.equal(audits().length,before,'a refused start creates nothing');
// Station response roles and read-only previews cannot start anything.
assert.equal((await as(stationUser,()=>actions.startStationAudit(form({location_id:'A',audit_type_id:'cod',reason:'Try',when:'now'})))).ok,false);
assert.equal((await as({...asha,readOnly:true},()=>actions.startStationAudit(form({location_id:'A',audit_type_id:'cod',reason:'Try',when:'now'})))).ok,false);
assert.equal(audits().length,before);

// 3. They ask instead. Their own station is refused; so is an unknown station.
assert.equal((await as(asha,()=>actions.requestCrossAudit(form({location_id:'A',audit_type_id:'cod',reason:'Why'})))).ok,false);
assert.equal((await as(asha,()=>actions.requestCrossAudit(form({location_id:'Z',audit_type_id:'cod',reason:'Why'})))).ok,false);
assert.equal((await as(asha,()=>actions.requestCrossAudit(form({location_id:'B',audit_type_id:'cod',reason:'Why',preferred_date:'2000-01-01'})))).ok,false);
assert.equal(requests().length,0);
result=await as(asha,()=>actions.requestCrossAudit(form({location_id:'B',audit_type_id:'cod',reason:'Cross audit asked by cluster lead'})));
assert.equal(result.ok,true,result.message);
const first=requests()[0];assert.equal(first.requested_by,'ua');assert.equal(first.status,'pending');

// 4. Who may decide it: not the requester, not a peer; the reporting manager and a head may.
const approve=(who,request,extra={})=>as(who,()=>actions.startStationAudit(form({request_id:request.id,location_id:request.location_id,audit_type_id:request.audit_type_id,assigned_to:request.requested_by,reason:request.reason,when:'now',...extra})));
before=audits().length;
for(const who of [asha,bala,xavier])assert.equal((await approve(who,first)).ok,false,`${who.userId} cannot approve`);
assert.equal((await as(bala,()=>actions.decideAuditRequest(form({operation:'decline',request_id:first.id,note:'No'})))).ok,false);
// A reporting manager must approve what was asked, for the person who asked.
assert.equal((await approve(manager,first,{location_id:'A'})).ok,false);
assert.equal((await approve(manager,first,{audit_type_id:'physical'})).ok,false);
assert.equal((await approve(manager,first,{assigned_to:'ux'})).ok,false);
assert.equal(audits().length,before);assert.equal(first.status,'pending','a refused approval leaves the request open');
result=await approve(manager,first);
assert.equal(result.ok,true,result.message);
created=audits().find(a=>a.id===result.auditId);
assert.equal(created.location_id,'B');assert.equal(created.assigned_to,'ua');assert.equal(created.cross_station,true);assert.equal(created.status_code,'scheduled');assert.equal(created.schedule_source,'unscheduled');
assert.equal(first.status,'approved');assert.equal(first.audit_id,created.id);assert.equal(first.decided_by,'um');
// It cannot be approved or declined twice.
assert.equal((await approve(head,first)).ok,false);
assert.equal((await as(head,()=>actions.decideAuditRequest(form({operation:'decline',request_id:first.id,note:'Late'})))).ok,false);

// 5. The cross-station auditor reaches that one audit; nobody else outside the station does.
assert.equal((await as(xavier,()=>actions.beginStationAudit(created.id))).ok,false);
assert.equal((await as(manager,()=>actions.beginStationAudit(created.id))).ok,false);
result=await as(asha,()=>actions.beginStationAudit(created.id));
assert.equal(result.ok,true,result.message);assert.equal(created.status_code,'in_progress');
// Their reach does not extend to other audits at that station.
const foreign={id:'foreign',company_id:'company',location_id:'B',audit_type_id:'cod',status_code:'scheduled',scheduled_for:new Date().toISOString(),cycle_key:month,period_slot:'cod_1',schedule_source:'manual',assigned_to:'ub',assignment_verified:true,deleted_at:null,updated_at:'stamp-f'};
audits().push(foreign);
assert.equal((await as(asha,()=>actions.changeStationAudit(form({audit_id:'foreign',updated_at:'stamp-f',audit_type_id:'physical',reason:'Try'})))).ok,false);
assert.equal(rpcCalls.length,0);

// 6. A manager who is not the reporting manager cannot approve; a failed creation reopens the request.
await as(xavier,()=>actions.requestCrossAudit(form({location_id:'B',audit_type_id:'physical',reason:'Another'})));
const second=requests()[1];
assert.equal((await approve(manager,second)).ok,false,'Xavier does not report to this manager');
insertError={code:'P0001',message:'Choose a valid audit window.'};
result=await approve(head,second);
assert.equal(result.ok,false);assert.match(result.message,/database update/,'before the database update the person is told what is missing');
assert.equal(second.status,'pending');assert.equal(second.decided_by,null);
insertError=null;
// A head may give it to any auditor.
result=await approve(head,second,{assigned_to:'ua'});
assert.equal(result.ok,true,result.message);assert.equal(audits().find(a=>a.id===result.auditId).assigned_to,'ua');
// Withdrawing and declining.
await as(asha,()=>actions.requestCrossAudit(form({location_id:'B',audit_type_id:'physical',reason:'Third'})));
const third=requests()[2];
assert.equal((await as(xavier,()=>actions.decideAuditRequest(form({operation:'cancel',request_id:third.id})))).ok,false);
assert.equal((await as(manager,()=>actions.decideAuditRequest(form({operation:'decline',request_id:third.id,note:''})))).ok,false,'declining needs a reason');
assert.equal((await as(manager,()=>actions.decideAuditRequest(form({operation:'decline',request_id:third.id,note:'Not this month'})))).ok,true);
assert.equal(third.status,'declined');
assert.equal((await as(asha,()=>actions.decideAuditRequest(form({operation:'cancel',request_id:third.id})))).ok,false,'a decided request cannot be withdrawn');

// 7. A head creates an audit at any station for any auditor with no request.
result=await as(head,()=>actions.startStationAudit(form({location_id:'B',audit_type_id:'physical',assigned_to:'ux',reason:'Random check',when:'later',scheduled_date:'2099-12-01',scheduled_time:'10:00'})));
assert.equal(result.ok,true,result.message);
created=audits().find(a=>a.id===result.auditId);
assert.equal(created.cross_station,true);assert.equal(created.status_code,'scheduled');assert.equal(created.cycle_key,'2099-12');
assert.equal((await as(head,()=>actions.startStationAudit(form({location_id:'B',audit_type_id:'physical',assigned_to:'nobody',reason:'Random',when:'now'})))).ok,false);
const reach=await as(asha,()=>actions.loadAuditReach());
assert.deepEqual(reach.stations.map(s=>s.id),['A','B']);assert.deepEqual(reach.auditors,[],'only cross-audit roles receive the full auditor list');
assert.equal((await as(head,()=>actions.loadAuditReach())).auditors.length,people.length);

// 8. Changing the audit type and auditor.
const plannedAudit={id:'planned',company_id:'company',location_id:'A',audit_type_id:'cod',status_code:'scheduled',scheduled_for:`${today}T10:00:00+05:30`,cycle_key:month,period_slot:'cod_1',schedule_source:'manual',assigned_to:'ua',assignment_verified:true,deleted_at:null,started_at:null,completed_at:null,updated_at:'stamp-p'};
audits().push(plannedAudit);
const change=(who,values)=>as(who,()=>actions.changeStationAudit(form({audit_id:'planned',updated_at:'stamp-p',reason:'Did a physical check',...values})));
assert.equal((await change(asha,{})).ok,false,'nothing to change');
assert.equal((await change(asha,{audit_type_id:'physical',reason:''})).ok,false);
assert.equal((await change(asha,{audit_type_id:'missing'})).ok,false);
assert.equal((await change(asha,{assigned_to:'ub'})).ok,false,'an auditor cannot hand the audit to another station’s team');
assert.equal(rpcCalls.length,0);
// The Physical window is free, so the audit takes that planned slot.
result=await change(asha,{audit_type_id:'physical'});
assert.equal(result.ok,true,result.message);
let call=rpcCalls.at(-1);assert.equal(call.name,'change_station_audit');assert.equal(call.args.p_schedule_source,'manual');assert.equal(call.args.p_period_slot,'standard');assert.equal(call.args.p_cross_station,false);assert.equal(call.args.p_assigned_to,'ua');
// With a planned Physical audit already in that window, it is kept as unscheduled instead.
audits().push({...plannedAudit,id:'occupier',audit_type_id:'physical',period_slot:'standard'});
result=await change(asha,{audit_type_id:'physical'});
assert.equal(result.ok,true,result.message);assert.match(result.message,/recorded as unscheduled/);
call=rpcCalls.at(-1);assert.equal(call.args.p_schedule_source,'unscheduled');assert.match(call.args.p_period_slot,/^unscheduled-/);
// A head reassigns across stations, and the auditor is marked cross-station.
result=await change(head,{assigned_to:'ub'});
assert.equal(result.ok,true,result.message);assert.equal(rpcCalls.at(-1).args.p_cross_station,true);
// Before the database update an in-scope reassignment still works; a type change says what is missing.
rpcError={code:'PGRST202',message:'Could not find the function public.change_station_audit'};
result=await change(asha,{assigned_to:'ux'});
assert.equal(result.ok,true,result.message);assert.equal(rpcCalls.at(-1).name,'manage_station_audit');assert.equal(rpcCalls.at(-1).args.p_operation,'reassign');
result=await change(asha,{audit_type_id:'physical'});
assert.equal(result.ok,false);assert.match(result.message,/database update/);
result=await change(head,{assigned_to:'ub'});
assert.equal(result.ok,false,'a cross-station reassignment is never sent to the older function');
rpcError=null;
// Once fieldwork has begun only its auditor may switch the type, and the auditor is fixed.
Object.assign(plannedAudit,{status_code:'in_progress',started_at:new Date().toISOString()});
before=rpcCalls.length;
assert.equal((await change(xavier,{audit_type_id:'physical'})).ok,false);
assert.equal((await change(asha,{assigned_to:'ux'})).ok,false);
assert.equal(rpcCalls.length,before);
assert.equal((await change(asha,{audit_type_id:'physical'})).ok,true);
Object.assign(plannedAudit,{status_code:'under_review',completed_at:new Date().toISOString()});
before=rpcCalls.length;
assert.equal((await change(asha,{audit_type_id:'physical'})).ok,false);assert.equal(rpcCalls.length,before,'a submitted audit cannot change type');
console.log('Cross-station audit tests passed: own-station surprise start, out-of-scope refusal, request rules, reporting-manager and cross-role approval, single-audit reach, any-station creation, type and auditor change, and safe behaviour before the database update.');
