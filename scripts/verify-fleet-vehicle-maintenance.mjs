import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
function load(file,mocks={}){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{if(!(n in mocks))throw Error(n);return mocks[n];},m,m.exports);return m.exports;}
const maintenance=load('src/lib/fleet/vehicle-maintenance.ts');
const original={status:'breakdown',non_operational_since:'2026-10-01',expected_operational_date:'2026-10-15',status_comment:'Workshop confirmed',status_updated_at:'2026-10-10T10:00:00Z'};
const day={status:'breakdown',work_date:'2026-10-10',created_at:'2026-10-10T09:00:00Z'};
assert.deepEqual(maintenance.effectiveVehicleAvailability(original,day),original,'Saved return date survives dashboard reload');
assert.deepEqual(maintenance.effectiveVehicleAvailability(original,{...day,created_at:'2026-10-10T11:00:00Z'}),original,'A same-status daily request never discards the repair plan');
const returned={...original,status:'active',expected_operational_date:null,non_operational_since:null};
assert.deepEqual(maintenance.effectiveVehicleAvailability(returned,day),returned,'Manual return to service supersedes an older request');
assert.equal(maintenance.effectiveVehicleAvailability({...original,status:'active',status_updated_at:null},day).status,'breakdown','New ad-hoc evidence still updates availability');
assert.equal(maintenance.availabilityDateError('2026-10-01','2026-10-09','2026-10-10'),null,'An unchanged overdue date remains editable');
for(const date of ['2026-02-30','2026-13-01','bad'])assert.ok(maintenance.availabilityDateError('2026-01-01',date,'2026-10-10'));
assert.ok(maintenance.availabilityDateError('2026-10-09','2026-10-08','2026-10-10'));
assert.ok(maintenance.availabilityDateError('2026-10-11','2026-10-15','2026-10-10'));
assert.equal(maintenance.registrationNumber(' kl 11 cc 3016 '),'KL11CC3016');
assert.equal(maintenance.registrationNumber('"bad"'),null);

let auth,allowed,rows,logs,events,openWork,failWork,historyConflict,duplicate;
const reset=()=>{auth={userId:'actor',companyId:'company',fullName:'Fleet Manager',email:'fixture@example.test',isMasterOwner:false,hasAllLocationAccess:true};allowed=true;logs=[];events=[];openWork=false;failWork=false;historyConflict=false;duplicate=false;rows=[{id:'vehicle',company_id:'company',vehicle_no:'KL11CC3016',station_code:'KTUO',...original,status_reason_id:'reason',status_reason_key:'accident',deployment_status:'deployed',da_name:null,da_contact_number:null,vendor_name:null,vendor_contact_number:null}];};
reset();
const db={from(table){let action='read',payload,filters=[],one=false;const q={
 select(){return q},eq(k,v){filters.push([k,v]);return q},neq(){return q},in(){return q},is(){return q},or(){return q},order(){return q},range(){return q},limit(){return q},
 update(v){action='update';payload=v;return q},insert(v){action='insert';payload=v;return q},single(){one=true;return q},maybeSingle(){one=true;return q},
 delete(){throw Error('Physical vehicle deletion is forbidden');},
 then(resolve,reject){try{let data=[],error=null;
 if(table==='fleet_vehicles'){
  data=rows.filter(r=>filters.every(([k,v])=>r[k]===v));
  if(action==='read'&&duplicate&&filters.some(([k])=>k==='vehicle_no'))data=[{id:'another-vehicle'}];
  if(action==='update'){data=data.map(r=>Object.assign(r,payload));events.push(payload);}
 }else if(table==='fleet_vehicle_status_master')data=[{id:'status',label:'Breakdown',is_operational:false,requires_reason:true,requires_expected_date:true}];
 else if(table==='fleet_vehicle_status_reason_master')data=[{id:'reason',reason_key:'accident',label:'Accident'}];
 else if(table==='stations')data=[{station_code:'OTHER'}];
 else if(table==='fleet_system_logs'){if(action==='insert')logs.push(payload);else data=historyConflict?[{entity_id:'other'}]:[];}
 else if(['fleet_audits','fleet_service_history','fleet_audit_findings'].includes(table)){data=openWork?[{id:'open'}]:[];error=failWork?{message:'offline'}:null;}
 resolve({data:one?(data[0]?{...data[0]}:null):data.map(r=>({...r})),error,count:data.length});
 }catch(e){reject(e);}}};return q;}};
const endpoint=load('src/app/api/fleet/vehicles/route.ts',{
 '@/lib/fleet/vehicle-maintenance':maintenance,
 '@/lib/fleet/audit-context':{fleetAuditContext:{getStore:()=>({actorId:auth?.userId,actorLabel:'Fleet Manager',requestId:'fixture'})}},
 '@/lib/fleet/system-log':{withFleetSystemLog:fn=>async r=>auth?.readOnly?Response.json({error:'Read-only'},{status:403}):fn(r)},
 '@/lib/fleet/vehicle-sources-server':{resolveVehicleSource:async()=> 'own'},
 '@/lib/fleet/vehicle-contact':load('src/lib/fleet/vehicle-contact.ts'),
 '@/lib/fleet/source-policy':{deploymentDateError:()=>null},
 '@/lib/fleet/vehicle-rent':load('src/lib/fleet/vehicle-rent.ts'),
 'next/server':{NextResponse:{json:Response.json}},
 '@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:()=>allowed},
 '@/lib/company-scope':{requireCompanyId:()=> 'company'},
 '@/lib/event-log':{writeEventLog:async()=>{}},
 '@/lib/supabase-admin':{supabaseAdmin:db},
 '@/lib/fleet-control':{hasActiveFleetMembership:async()=>true},
});
const request=(method,body)=>new Request('https://fleet.test/api/fleet/vehicles',{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const body={vehicle_no:'KL11CC3016',status:'breakdown',status_reason_id:'reason',expected_operational_date:'2026-10-16'};
assert.equal((await endpoint.PATCH(request('PATCH',body))).status,200);
assert.equal(rows[0].expected_operational_date,'2026-10-16');assert.equal(rows[0].non_operational_since,'2026-10-01');assert.equal(rows[0].status_updated_by,'actor');
assert.equal((await endpoint.PATCH(request('PATCH',{...body,expected_operational_date:'2026-09-01'}))).status,400);
reset();assert.equal((await endpoint.PATCH(request('PATCH',{vehicle_no:body.vehicle_no,registration_number:'KL11CC3099'}))).status,200);assert.equal(rows[0].id,'vehicle');assert.equal(rows[0].vehicle_no,'KL11CC3099');
reset();historyConflict=true;assert.equal((await endpoint.PATCH(request('PATCH',{vehicle_no:body.vehicle_no,registration_number:'KL11CC3099'}))).status,409);assert.equal(events.length,0);
reset();assert.equal((await endpoint.PATCH(request('PATCH',{vehicle_no:body.vehicle_no,da_name:'Updated contact',actorId:'forged'}))).status,200);assert.equal(logs[0].actor_user_id,'actor');assert.deepEqual(logs[0].before_values,{da_name:null});assert.deepEqual(logs[0].after_values,{da_name:'Updated contact'});
for(const setup of [()=>{auth=null},()=>{allowed=false},()=>{auth.readOnly=true},()=>{auth.hasAllLocationAccess=false;auth.locationScopeIds=['other-station'];}]){reset();setup();const r=await endpoint.PATCH(request('PATCH',body));assert.ok([401,403].includes(r.status));assert.equal(events.length,0);}
reset();assert.equal((await endpoint.DELETE(request('DELETE',{vehicle_no:body.vehicle_no,reason:'Duplicate vehicle entry'}))).status,200);assert.equal(rows.length,1);assert.equal(rows[0].status,'archived');assert.equal(rows[0].deployment_status,'not_deployed');
assert.equal((await endpoint.PATCH(request('PATCH',body))).status,409,'Archived records cannot be accidentally reactivated');
assert.equal((await endpoint.PUT(request('PUT',{vehicle_no:body.vehicle_no,reason:'Archived in error'}))).status,200);assert.equal(rows[0].status,'inactive');assert.equal(rows[0].deployment_status,'not_deployed');
for(const failure of ['open','offline']){reset();openWork=failure==='open';failWork=failure==='offline';const r=await endpoint.DELETE(request('DELETE',{vehicle_no:body.vehicle_no,reason:'Duplicate entry'}));assert.equal(r.status,failure==='open'?409:503);assert.equal(events.length,0);}

// Real PostgreSQL fixtures: correction and archival retain documents and record before/after + verified actor.
const pg=new PGlite(),company='00000000-0000-0000-0000-000000000001',actor='00000000-0000-0000-0000-000000000002';
await pg.exec(`create role anon;create role authenticated;create role service_role;create table companies(id uuid primary key);create table profiles(id uuid,company_id uuid,full_name text);create table fleet_vehicles(id uuid primary key default gen_random_uuid(),company_id uuid,vehicle_no text unique,station_code text,status text,expected_operational_date date);create table payment_heads(id uuid,company_id uuid,code text,name text);create table fixture_documents(vehicle_no text references fleet_vehicles(vehicle_no) on update cascade on delete cascade);insert into companies values('${company}');insert into profiles values('${actor}','${company}','Verified Manager');`);
await pg.exec(fs.readFileSync('supabase/migrations/20261005175809_fleet_system_audit_log.sql','utf8'));
await pg.query("select set_config('request.jwt.claims',$1,false),set_config('request.headers',$2,false)",[JSON.stringify({role:'service_role'}),JSON.stringify({'x-fleet-audit':JSON.stringify({actorId:actor,requestId:'maintenance-fixture',route:'/api/fleet/vehicles'})})]);
await pg.exec(`insert into fleet_vehicles(company_id,vehicle_no,station_code,status,expected_operational_date) values('${company}','KL11CC3016','KTUO','breakdown','2026-10-10');insert into fixture_documents values('KL11CC3016');update fleet_vehicles set expected_operational_date='2026-10-15';update fleet_vehicles set vehicle_no='KL11CC3099';update fleet_vehicles set status='archived';`);
assert.equal((await pg.query('select vehicle_no from fixture_documents')).rows[0].vehicle_no,'KL11CC3099');
const changes=(await pg.query("select * from fleet_system_logs where action='update'")).rows;
assert.equal(changes.length,3);assert.ok(changes.every(r=>r.actor_user_id===actor&&r.actor_label==='Verified Manager'));
assert.ok(changes.some(r=>r.before_values.expected_operational_date==='2026-10-10'&&r.after_values.expected_operational_date==='2026-10-15'));
assert.ok(changes.some(r=>r.before_values.vehicle_no==='KL11CC3016'&&r.after_values.vehicle_no==='KL11CC3099'));
assert.equal((await pg.query('select count(*)::int n from fleet_vehicles')).rows[0].n,1);
await pg.close();
console.log('Vehicle maintenance: dates persist, registration corrections preserve identity, scoped access, contact attribution, archive/restore and PostgreSQL history checks passed.');
