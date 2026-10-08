import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
create table companies(id uuid primary key);create table profiles(id uuid,company_id uuid,full_name text);create table workforce(id uuid primary key,company_id uuid);create table fleet_daily_km(id uuid);create table stations(company_id uuid,station_code text);
create table fleet_control_settings(company_id uuid);create table designations(id uuid,company_id uuid,code text,name text);
create table fleet_vehicle_sources(id uuid,company_id uuid,designation_id uuid,ownership_type text);
create table fleet_vehicle_status_master(company_id uuid,status_key text,label text,is_active boolean,is_operational boolean);
create table fleet_vehicles(id uuid primary key,company_id uuid,vehicle_no text,station_code text,status text,deployment_status text,source_id uuid,ownership_type text,model text,da_name text,vendor_name text);
create table fleet_system_logs(company_id uuid,event_kind text,entity text,entity_id text,action text,actor_user_id uuid,actor_label text,route text,before_values jsonb,after_values jsonb);
create function fleet_system_change_log() returns trigger language plpgsql as $$begin return coalesce(new,old);end;$$;`);
await db.exec(readFileSync('supabase/migrations/20261005182231_fleet_day_tracking_assignments.sql','utf8').split('create or replace function public.fleet_system_change_log()')[0]);
await db.exec(readFileSync('supabase/migrations/20261007142058_fleet_vehicle_da_mapping.sql','utf8'));
const c='11111111-1111-4111-8111-111111111111',other='11111111-1111-4111-8111-111111111112',v='22222222-2222-4222-8222-222222222222',v2='22222222-2222-4222-8222-222222222223',vendor='22222222-2222-4222-8222-222222222224',actor='44444444-4444-4444-8444-444444444444',source='55555555-5555-4555-8555-555555555555';
await db.exec(`insert into companies values('${c}'),('${other}');insert into stations values('${c}','AAA'),('${c}','BBB'),('${c}','CCC');insert into profiles values('${actor}','${c}','Fixture Manager');insert into fleet_control_settings(company_id) values('${c}');
insert into designations values('${source}','${c}','VNV','Van vendor');insert into fleet_vehicle_sources values('${source}','${c}','${source}','rented');
insert into fleet_vehicle_status_master values('${c}','active','Active',true,true),('${c}','breakdown','Breakdown',true,false);
insert into fleet_vehicles(id,company_id,vehicle_no,station_code,status,ownership_type,model) values('${v}','${c}','FIXTURE-1','AAA','active','own','Jeeto'),('${v2}','${c}','FIXTURE-2','BBB','active','odcd','Auto');
insert into fleet_vehicles(id,company_id,vehicle_no,station_code,status,ownership_type,source_id) values('${vendor}','${c}','FIXTURE-VENDOR','AAA','active','rented','${source}');`);
await db.exec(readFileSync('supabase/migrations/20261007171031_fleet_da_mapping_pending_days.sql','utf8'));
await db.exec(readFileSync('supabase/migrations/20261007174503_fleet_mapping_day_exceptions.sql','utf8'));
const today=(await db.query("select (now() at time zone 'Asia/Kolkata')::date::text d")).rows[0].d;
const pending=async(stations=['AAA','BBB'],offset=0,from=null,to=null)=> (await db.query('select fleet_pending_da_days($1,$2,$3,$4,$5,20) data',[c,stations,from,to,offset])).rows[0].data;
let p=await pending();assert.equal(p.rows[0].vehicles[0].vehicle_no,'FIXTURE-1');assert.equal(p.rows[0].vehicles[0].model,'Jeeto');assert.equal(p.totalPending,2);assert.equal(p.overdue,0);assert.equal((await pending(['AAA'])).totalPending,1);assert.equal((await pending([])).totalPending,0);
await db.exec(`update fleet_da_mapping_periods set effective_from=effective_from-2;update fleet_control_settings set assignment_alert_from=assignment_alert_from-2;`);
p=await pending();assert.equal(p.totalPending,6);assert.equal(p.overdue,4,'New dates accrue automatically');const past=p.rows[0].work_date;
await db.exec(`update fleet_vehicles set station_code='CCC' where id='${v}';update fleet_vehicles set status='breakdown' where id='${v2}';`);
assert.equal((await pending(['AAA'])).totalPending,2,'transfer preserves prior station');assert.equal((await pending(['CCC'])).totalPending,1);assert.equal((await pending(['BBB'])).totalPending,2,'breakdown preserves past');
const confirm=(date,rows)=>db.query('select fleet_confirm_da_day($1,$2,$3,$4)',[c,actor,date,JSON.stringify(rows)]);
await confirm(past,[{vehicle_id:v,station_code:'AAA',expected_ids:[],associates:[],remarks:'No delivery work'}]);
assert.equal((await pending(['AAA'])).totalPending,1,'confirmation clears just one day');assert.equal((await db.query('select station_code from fleet_vehicle_day_confirmations')).rows[0].station_code,'AAA');
await assert.rejects(confirm(today,[{vehicle_id:v,station_code:'AAA',expected_ids:[],associates:[]}]),/placement changed/);
assert.equal((await pending(['AAA','BBB','CCC'],0,today,today)).totalPending,1);
const past2=(await pending(['AAA'])).rows[0].work_date;
await confirm(past2,[{vehicle_id:v,station_code:'AAA',expected_ids:[],associates:[{provider_id:'HISTORIC',name:'Fixture rider'}]}]);
assert.equal((await pending(['AAA'])).totalPending,0,'historical rider mapping clears last date');
assert.equal((await db.query("select station_code from fleet_day_assignments where provider_employee_id='HISTORIC'")).rows[0].station_code,'AAA');
await db.exec(`insert into fleet_vehicle_da_defaults(company_id,vehicle_id,vehicle_no,station_code,provider_employee_id,name,created_by,updated_by) values('${c}','${v}','FIXTURE-1','CCC','RIDER','Fixture rider','${actor}','${actor}');`);
assert.equal((await pending(['CCC'])).totalPending,1,'default is not confirmation');
await db.exec(`update fleet_control_settings set assignment_alert_from=assignment_alert_from-25;update fleet_da_mapping_periods set effective_from=effective_from-25 where vehicle_id='${v2}' and effective_to is not null;`);
p=await pending(['BBB']);assert.equal(p.rows.length,20);assert.equal(p.totalGroups,27);assert.equal(p.pendingDates.length,27);assert.equal(p.pendingDates[0].date,p.rows[0].work_date);assert.equal((await pending(['BBB'],20)).rows.length,7);
assert.equal((await db.query("select has_table_privilege('anon','fleet_da_mapping_periods','select') ok")).rows[0].ok,false);
assert.equal((await db.query("select has_function_privilege('authenticated','fleet_pending_da_days(uuid,text[],date,date,integer,integer)','execute') ok")).rows[0].ok,false);
assert.equal((await db.query('select fleet_pending_da_days($1,$2) data',[other,['AAA']])).rows[0].data.totalPending,0);
const unavailableRow={vehicle_id:v,station_code:'CCC',expected_ids:[],associates:[],day_status:'breakdown',remarks:'Vehicle failed before dispatch'};
await assert.rejects(confirm(today,[{...unavailableRow,remarks:''}]),/needs a reason/);
await assert.rejects(confirm(today,[{...unavailableRow,associates:[{provider_id:'R1',name:'Fixture'}]}]),/no associates/);
await assert.rejects(confirm(today,[{...unavailableRow,day_status:'not-configured'}]),/not configured/);
await confirm(today,[unavailableRow]);
const dated=(await db.query('select day_status,day_status_label,updated_by from fleet_vehicle_day_confirmations where vehicle_id=$1 and work_date=$2',[v,today])).rows[0];assert.equal(dated.day_status,'breakdown');assert.equal(dated.day_status_label,'Breakdown');assert.equal(dated.updated_by,actor);
assert.equal((await db.query('select status from fleet_vehicles where id=$1',[v])).rows[0].status,'active','Historical fallback never changes current Registry status');
assert.equal((await pending(['CCC'])).totalPending,0,'Dated fallback resolves only that vehicle/day obligation');
console.log('Dated exceptions: required reason, configured status, no conflicting riders, actor attribution, vehicle detail and unchanged Registry status passed.');
await db.close();console.log('Pending mapping: rollout, daily accrual, scope, vendor exclusion, transfer/breakdown history, historic closure, defaults, filters and pagination passed.');
// API errors and scope stay separate from assignment submission.
const ts=await import('typescript');
const compile=(path,deps)=>{const ex={};new Function('require','exports',ts.default.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.default.ModuleKind.CommonJS,target:ts.default.ScriptTarget.ES2022}}).outputText)(id=>{if(id in deps)return deps[id];throw Error(id)},ex);return ex;};
class ReportError extends Error{constructor(message,status=500){super(message);this.status=status;}}
let calls=0,fail=false,allow=true;
const query={select(){return this},eq(){return this},in(){return this},order(){return this}};
const api=compile('src/app/api/fleet/da-mapping/pending/route.ts',{
 '@/lib/authorization':{getAuthorization:async()=>({userId:'fixture'})},
 '@/lib/fleet/da-mapping-server':{mappingStationScope:async()=>{if(!allow)throw new ReportError('Denied',403);return{companyId:c,stations:[{code:'AAA',name:'Alpha'}]}}},
 '@/lib/fleet/da-mapping-client':{mappingAdmin:{from:()=>query,rpc:async(name,args)=>{calls++;assert.equal(args.p_from,null);assert.equal(args.p_to,null);assert.equal(args.p_company,c);assert.deepEqual(args.p_stations,['AAA']);return fail?{error:{message:'isolated failure'}}:{data:{totalGroups:0,totalPending:0,rows:[]}}}}},
 '@/lib/supabase-pagination':{readAllRows:async()=>({data:[{station_code:'AAA'}],error:null})},
 '@/lib/fleet/report-data':{FleetReportError:ReportError},
 '@/lib/fleet/daily-report':{istDate:()=>today,validDate:d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)}
});
const get=q=>api.GET(new Request('https://fleet.example/api/fleet/da-mapping/pending?'+q));
assert.equal((await get('station=OTHER')).status,403);assert.equal(calls,0);
assert.equal((await get('offset=-1')).status,400);assert.equal(calls,0);
assert.equal((await get('from=broken')).status,400);assert.equal(calls,0);
assert.equal((await get('')).status,200);assert.equal((await get('station=&from=&to=&offset=0')).status,200);fail=true;assert.equal((await get('')).status,503);allow=false;assert.equal((await get('')).status,403);
console.log('Pending endpoint: unauthorized station, malformed filters, permission denial and optional data failure handled without writes.');
