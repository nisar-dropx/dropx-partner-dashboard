import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
const compile=(path,deps={})=>{const ex={};new Function('require','exports',ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{if(id in deps)return deps[id];throw Error(id);},ex);return ex;};
const model=compile('src/lib/fleet/da-mapping.ts');
assert.deepEqual(model.recentRiders([{provider_employee_id:' a1 ',provider_employee_name:'Old',work_date:'2026-10-01'},{provider_employee_id:'A1',provider_employee_name:'Current',work_date:'2026-10-06'}]),[{id:'A1',name:'Current',lastSeen:'2026-10-06'}]);
const totals=model.assignmentCounts([{provider_employee_id:' A1',total_delivery:12,c_return:2,swa_delivery:3},{provider_employee_id:'a1',total_delivery:8,c_return:1,swa_delivery:2}]);assert.deepEqual(totals.get('A1'),{delivered:20,cReturn:3,swa:5});assert.equal(totals.has('missing'),false);
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;create table companies(id uuid primary key);create table profiles(id uuid,company_id uuid,full_name text);create table fleet_daily_km(id uuid);create table fleet_vehicles(id uuid primary key,company_id uuid,vehicle_no text,station_code text,status text);create table workforce(id uuid primary key,company_id uuid);create table stations(company_id uuid,station_code text);create table fleet_control_settings(company_id uuid);create function fleet_system_change_log() returns trigger language plpgsql as $$begin return coalesce(new,old);end;$$;`);
await db.exec(`create table fleet_system_logs(company_id uuid,event_kind text,entity text,entity_id text,action text,actor_user_id uuid,actor_label text,route text,before_values jsonb,after_values jsonb);`);
await db.exec(readFileSync('supabase/migrations/20261005182231_fleet_day_tracking_assignments.sql','utf8').split('create or replace function public.fleet_system_change_log()')[0]);
await db.exec(readFileSync('supabase/migrations/20261007142058_fleet_vehicle_da_mapping.sql','utf8'));
const c='11111111-1111-4111-8111-111111111111',v='22222222-2222-4222-8222-222222222222',v2='33333333-3333-4333-8333-333333333333',actor='44444444-4444-4444-8444-444444444444',other='55555555-5555-4555-8555-555555555555',day='2026-10-06';
await db.exec(`insert into companies values('${c}'),('${other}');insert into profiles values('${actor}','${c}','Test Manager');insert into fleet_vehicles values('${v}','${c}','V1','KOZA','active'),('${v2}','${c}','V2','KOZA','active');insert into stations values('${c}','KOZA');`);
const row=(vehicle,id,expected=[])=>({vehicle_id:vehicle,station_code:'KOZA',expected_ids:expected,associates:[{provider_id:id,name:'Test DA'}]});
const confirm=(rows,company=c,user=actor)=>db.query('select fleet_confirm_da_day($1,$2,$3,$4::jsonb)',[company,user,day,JSON.stringify(rows)]);
await confirm([row(v,'a1'),row(v2,'a2')]);
let active=await db.query("select id,vehicle_id,provider_employee_id from fleet_day_assignments where is_active order by vehicle_id");assert.equal(active.rows.length,2);assert.equal(active.rows[0].provider_employee_id,'A1');
await assert.rejects(confirm([row(v,'a3')]),/changed/);
await assert.rejects(confirm([row(v,'a3',[active.rows[0].id])],other),/Invalid actor/);
await assert.rejects(confirm([row(v,'a3',[active.rows[0].id])],c,other),/Invalid actor/);
const revisions=(await db.query('select vehicle_id,updated_at from fleet_vehicle_day_confirmations')).rows;
const withRev=r=>({...r,expected_revision:revisions.find(x=>x.vehicle_id===r.vehicle_id)?.updated_at});
await assert.rejects(confirm([withRev(row(v,'a2',[active.rows[0].id]))]),/duplicate key/);
assert.equal((await db.query('select count(*)::int n from fleet_day_assignments where is_active')).rows[0].n,2,'Conflict rolls back whole batch');
await confirm([withRev(row(v,'a2',[active.rows[0].id])),withRev(row(v2,'a1',[active.rows[1].id]))]);
assert.equal((await db.query('select count(*)::int n from fleet_day_assignments')).rows[0].n,4,'Corrections preserve original rows');
for(const table of ['fleet_day_assignments','fleet_vehicle_da_defaults'])assert.equal((await db.query(`select has_table_privilege('anon','${table}','SELECT') allowed`)).rows[0].allowed,false);
assert.equal((await db.query("select has_function_privilege('authenticated','fleet_confirm_da_day(uuid,uuid,date,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
const current=(await db.query('select id,vehicle_id from fleet_day_assignments where is_active order by vehicle_id')).rows;
const currentRevision=(await db.query('select updated_at from fleet_vehicle_day_confirmations where vehicle_id=$1',[v])).rows[0].updated_at;
await confirm([{...row(v,'a2',[current[0].id]),associates:[],remarks:'No delivery work',expected_revision:currentRevision}]);
assert.equal((await db.query('select count(*)::int n from fleet_day_assignments where vehicle_id=$1 and is_active',[v])).rows[0].n,0);
assert.equal((await db.query('select remarks from fleet_vehicle_day_confirmations where vehicle_id=$1',[v])).rows[0].remarks,'No delivery work');
await db.exec(`insert into fleet_control_settings(company_id) values('${c}');`);
await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-fleet-audit':JSON.stringify({actorId:actor,route:'/api/fleet/da-mapping'})})]);
await db.exec(`update fleet_control_settings set assignment_recent_days=8 where company_id='${c}';`);
assert.equal((await db.query('select actor_user_id from fleet_system_logs')).rows[0].actor_user_id,actor);
await db.exec(`insert into stations values('${c}','BBB');update fleet_vehicles set station_code='BBB' where id='${v2}';`);
const multiRows=[{...row(v,'BATCH-A'),station_code:'KOZA'},{...row(v2,'BATCH-B'),station_code:'BBB'}];
await db.query('select fleet_confirm_da_day($1,$2,$3,$4::jsonb)',[c,actor,'2026-10-07',JSON.stringify(multiRows)]);
assert.deepEqual((await db.query("select station_code from fleet_vehicle_day_confirmations where work_date='2026-10-07' order by station_code")).rows.map(r=>r.station_code),['BBB','KOZA'],'One atomic save confirms vehicles across locations');
await db.close();
const layout=compile('src/lib/fleet/compact-report.ts');const pages=layout.compactPages('Daily station status','KL | All models',{headers:['Station','Own','ODCD','Rented','Ad hoc'],widths:[1,1.6,1.6,1.6,.8],notes:['TOTAL / OPERATIONAL / NON-OPERATIONAL'],rows:Array.from({length:95},(_,i)=>['ST'+i,'5 / 4 / 1','2 / 2 / 0','1 / 1 / 0',0])});
assert.ok(pages.length>1);assert.equal(pages.flatMap(p=>p.lines).filter(l=>/^ST\d+$/.test(l.text)).length,95);assert.ok(pages.every(p=>p.width===900&&p.height<=1275));
console.log('DA mapping: recent ID dedupe, exact feed totals, atomic confirmations, stale conflicts, swaps, history, tenancy, private grants and complete compact pagination passed.');
// Exercise server route barriers and optional counts outage using isolated authorization/data.
class E extends Error{constructor(message,status=500){super(message);this.status=status;}}
let auth={userId:'user',companyId:'company',readOnly:false},called=0;
const route=compile('src/app/api/fleet/da-mapping/route.ts',{
 '@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:()=>false},'@/lib/fleet/da-mapping-client':{mappingAdmin:{rpc:async()=>{called++;return{data:1,error:null}}}},
 '@/lib/company-scope':{requireCompanyId:()=> 'company'},'@/lib/fleet/report-data':{FleetReportError:E},
 '@/lib/fleet/da-mapping-server':{loadMapping:async(a,date,station)=>{if(station!=='MAPPED')throw new E('Station is outside your scope.',403);return{canEdit:true,canDefaults:false,options:[{id:'A1',name:'Fixture'}],vehicles:[{id:'v',station_code:station}],assignments:[],confirmations:[],defaults:[],warning:'Counts temporarily unavailable'};}},
 '@/lib/fleet/da-mapping':model,'@/lib/fleet/daily-report':{istDate:()=> '2026-10-07',validDate:d=>/^2026-10-0[1-7]$/.test(d)},'@/lib/fleet/system-log':{withFleetSystemLog:f=>f}
});
const post=(station='MAPPED',extra={})=>route.POST(new Request('https://fleet.dropxlogistics.com/api/fleet/da-mapping',{method:'POST',headers:{'content-type':'application/json',origin:'https://fleet.dropxlogistics.com'},body:JSON.stringify({action:'mapping.confirm',station,date:'2026-10-07',rows:[{vehicleId:'v',ids:['A1'],expectedIds:[]}],...extra})}));
assert.equal((await post('OTHER')).status,403);assert.equal(called,0);
auth.readOnly=true;assert.equal((await post()).status,403);assert.equal(called,0);auth.readOnly=false;
assert.equal((await post('MAPPED',{rows:[{vehicleId:'not-permitted',ids:['A1'],expectedIds:[]}]})).status,403);
assert.equal((await post('MAPPED',{rows:[{vehicleId:'v',ids:['unknown'],expectedIds:[]}]})).status,409);
assert.equal((await post()).status,200,'Missing optional counts do not block known rider confirmation');assert.equal(called,1);
console.log('DA mapping API: out-of-scope stations/vehicles, preview writes and unknown IDs rejected; missing counts do not block confirmation.');
// Current operational eligibility follows the status master, including custom statuses.
const statuses=[{status_key:'active',is_operational:true,is_active:true},{status_key:'ready_for_route',is_operational:true,is_active:true},{status_key:'breakdown',is_operational:false,is_active:true}];
assert.equal(model.isMappingVehicleActive({status:'active',deployment_status:'deployed'},statuses),true);
assert.equal(model.isMappingVehicleActive({status:'ready_for_route',deployment_status:'deployed'},statuses),true);
assert.equal(model.isMappingVehicleActive({status:'breakdown',deployment_status:'deployed'},statuses),false);
assert.equal(model.isMappingVehicleActive({status:'active',deployment_status:'not_deployed'},statuses),false);
assert.equal(model.isMappingVehicleActive({status:'unknown',deployment_status:'deployed'},statuses),false);
let surface='ops';
const access=compile('src/lib/fleet/da-mapping-server.ts',{
 'server-only':{},'@/lib/fleet/da-mapping-client':{mappingAdmin:{}},'@/lib/supabase-pagination':{},
 '@/lib/authorization':{hasPermission:(a,p,action)=>Boolean(a.permissions?.[p]?.[action])},'@/lib/company-scope':{},
 '@/lib/access-surface':{currentAdminAccessSurface:()=>surface},'./report-data':{FleetReportError:E},'./vehicle-sources-server':{},'./daily-report':{},'./da-mapping':model
});
const stationRole={readOnly:false,permissions:{fleet_da_mapping:{access:true,edit:true}}};
assert.equal(access.mappingCanView(stationRole),true);assert.equal(access.mappingCanEdit(stationRole),true);
assert.equal(access.mappingCanEdit({...stationRole,readOnly:true}),false);
assert.equal(access.mappingCanEdit({permissions:{expense_requests:{add:true,access:true}}}),false,'Payment access alone never grants vehicle mapping');
assert.equal(access.mappingCanDefaults({isMasterOwner:true}),false,'Even owners cannot update defaults via OpsPulse');
surface='fleet';assert.equal(access.mappingCanDefaults({isMasterOwner:true}),true);
assert.equal(access.mappingCanDefaults({permissions:{fleet_vehicle_view:{edit:true}}}),false,'Vehicle editors do not implicitly edit Masters');
assert.equal(access.mappingCanDefaults({permissions:{fleet_masters:{edit:true}}}),true);
assert.equal((await post('MAPPED',{action:'mapping.default',vehicleId:'v',providerId:'A1'})).status,403);
assert.equal((await post('MAPPED',{action:'mapping.policy',recentDays:7})).status,403);
console.log('Mapping correction: active/deployed eligibility, custom statuses, scoped role editing, preview protection and Fleet-only master/policy barriers passed.');

// All-station loading remains scoped, and rider choices remain tied to each vehicle's station.
const fixtureTables={
 stations:[{id:'s1',station_code:'AAA',station_name:'Alpha'},{id:'s2',station_code:'BBB',station_name:'Beta'},{id:'s3',station_code:'HIDDEN',station_name:'Hidden'}],
 fleet_vehicles:[{id:'va',vehicle_no:'VA',model:'Van',station_code:'AAA',status:'active',deployment_status:'deployed',ownership_type:'own'},{id:'vb',vehicle_no:'VB',model:'Van',station_code:'BBB',status:'active',deployment_status:'deployed',ownership_type:'own'},{id:'vu',vehicle_no:'VU',model:'Jeeto',station_code:'AAA',status:'breakdown',deployment_status:'deployed',ownership_type:'own'},{id:'vh',vehicle_no:'VH',station_code:'HIDDEN',status:'active',deployment_status:'deployed'}],
 fleet_vehicle_status_master:[{status_key:'active',label:'Active',is_active:true,is_operational:true},{status_key:'breakdown',label:'Breakdown',is_active:true,is_operational:false}],
 fleet_vehicle_da_defaults:[{id:'def-a',vehicle_id:'va',station_code:'AAA',provider_employee_id:'A1',name:'Alpha DA'}],
 fleet_day_assignments:[],fleet_vehicle_day_confirmations:[],fleet_control_settings:[{assignment_recent_days:7}],
 cps_shipment_daily:[{id:'r1',station_code:'AAA',provider_employee_id:'A1',provider_employee_name:'Alpha DA',work_date:'2026-10-06'},{id:'r2',station_code:'BBB',provider_employee_id:'B1',provider_employee_name:'Beta DA',work_date:'2026-10-06'},{id:'r3',station_code:'HIDDEN',provider_employee_id:'H1',provider_employee_name:'Hidden DA',work_date:'2026-10-06'}],company_product_memberships:[{id:'member',role_id:'role'}]
};
const queries=[];
function fixtureQuery(table){let rows=[...(fixtureTables[table]||[])];const q={select(){return q},eq(){return q},gte(){return q},lte(){return q},gt(){return q},order(){return q},in(col,values){queries.push({table,col,values});rows=rows.filter(r=>values.includes(r[col]));return q},maybeSingle:async()=>({data:rows[0]??null,error:null}),then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve)}};return q;}
const scoped=compile('src/lib/fleet/da-mapping-server.ts',{
 'server-only':{},'@/lib/fleet/da-mapping-client':{mappingAdmin:{from:fixtureQuery}},'@/lib/supabase-pagination':{readAllRows:async q=>await q},
 '@/lib/authorization':{hasPermission:()=>true},'@/lib/company-scope':{requireCompanyId:()=>c},'@/lib/access-surface':{currentAdminAccessSurface:()=> 'fleet'},'./report-data':{FleetReportError:E},'./vehicle-sources-server':{loadVehicleSources:async()=>({sources:[]})},'./daily-report':{istDate:()=> '2026-10-07'},'./da-mapping':model
});
const manager={userId:actor,isMasterOwner:false,hasAllLocationAccess:false,locationScopeIds:['s1','s2']};
const all=await scoped.loadMapping(manager,'2026-10-07','*');assert.equal(all.station,'*');assert.equal(all.unavailableVehicles[0].id,'vu');assert.equal(all.dayStatuses[0].key,'breakdown');assert.deepEqual(all.vehicles.map(v=>v.id),['va','vb']);assert.deepEqual(all.options.map(o=>o.id),['A1','B1']);assert.ok(model.riderAvailableAt(all.options[0],'AAA'));assert.equal(model.riderAvailableAt(all.options[0],'BBB'),false);
assert.deepEqual((await scoped.loadMapping(manager,'2026-10-07','')).vehicles.map(v=>v.id),['va','vb']);
assert.deepEqual((await scoped.loadMapping(manager,'2026-10-07','AAA')).vehicles.map(v=>v.id),['va']);
await assert.rejects(scoped.loadMapping(manager,'2026-10-07','HIDDEN'),/outside your scope/);
let allSaved;
const bulkApi=compile('src/app/api/fleet/da-mapping/route.ts',{
 '@/lib/authorization':{getAuthorization:async()=>manager},'@/lib/fleet/da-mapping-client':{mappingAdmin:{rpc:async(name,args)=>{allSaved=args.p_rows;return{data:args.p_rows.length}}}},'@/lib/company-scope':{requireCompanyId:()=>c},'@/lib/fleet/report-data':{FleetReportError:E},'@/lib/fleet/da-mapping-server':{loadMapping:async()=>({...all,canEdit:true})},'@/lib/fleet/da-mapping':model,'@/lib/fleet/daily-report':{istDate:()=> '2026-10-07',validDate:()=>true},'@/lib/fleet/system-log':{withFleetSystemLog:f=>f}
});
const bulk=rows=>bulkApi.POST(new Request('https://fleet.example/api/fleet/da-mapping',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'mapping.confirm',station:'*',date:'2026-10-07',rows})}));
assert.equal((await bulk([{vehicleId:'vb',ids:['A1'],expectedIds:[]}])).status,409,'A rider from another station cannot be assigned through All stations');
assert.equal(allSaved,undefined);
assert.equal((await bulk([{vehicleId:'va',ids:['A1'],expectedIds:[]},{vehicleId:'vb',ids:['B1'],expectedIds:[]}])).status,200);
assert.deepEqual(allSaved.map(r=>r.station_code),['AAA','BBB']);
console.log('All stations: scoped load, per-station rider choices, cross-station assignment rejection and single atomic bulk save passed.');

assert.equal((await bulk([{vehicleId:'va',ids:['A1'],expectedIds:[],dayStatus:'breakdown',remarks:'Before dispatch'}])).status,400);assert.equal((await bulk([{vehicleId:'va',ids:[],expectedIds:[],dayStatus:'breakdown',remarks:''}])).status,400);assert.equal((await bulk([{vehicleId:'va',ids:[],expectedIds:[],dayStatus:'unknown',remarks:'Before dispatch'}])).status,400);assert.equal((await bulk([{vehicleId:'va',ids:[],expectedIds:[],dayStatus:'breakdown',remarks:'Failed before dispatch'}])).status,200);assert.equal(allSaved[0].day_status,'breakdown');console.log('Dated exception API validation and Fleet unavailable summary passed.');

fixtureTables.stations[0].region='KL';fixtureTables.stations[0].cluster_name='North';fixtureTables.stations[1].region='AP';
const filteredMetadata=await scoped.loadMapping(manager,'2026-10-07','*');
assert.equal(filteredMetadata.stations[0].region,'KL');assert.equal(filteredMetadata.stations[0].cluster,'North');assert.equal(filteredMetadata.stations[1].cluster,'');
const registry=await scoped.loadMapping(manager,'2026-10-07','AAA',true);assert.ok(registry.vehicles.some(v=>v.id==='vu'),'Registry can maintain the default ID while a vehicle is unavailable');assert.ok(!filteredMetadata.vehicles.some(v=>v.id==='vu'),'Daily confirmation still excludes unavailable vehicles');
console.log('Region/cluster metadata stays scoped; registry-only unavailable lookup does not change daily eligibility.');
