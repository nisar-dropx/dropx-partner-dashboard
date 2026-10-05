import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function compile(file,deps={}){const exports={};new Function('require','exports',ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{if(id in deps)return deps[id];throw Error(id);},exports);return exports;}
const d=compile('src/lib/fleet/day-tracking.ts'),h=compile('src/lib/wheelseye-history.ts');
const day='2026-10-05',start=Date.parse(`${day}T00:00:00+05:30`)/1000;
const point=(minute,speed,ignition,longitude=75)=>({latitude:11,longitude,speed,ignition,dttimeInEpoch:start+minute*60,vehicleName:'VAN'});
const journey=h.calculateWheelseyeMovement([point(0,10,1),point(1,10,1,75.001),point(2,0,1,75.001),point(3,0,1,75.001),point(4,0,0,75.001),point(5,0,0,75.001),point(20,10,1,75.002),point(21,10,1,75.003)],'VAN',day);
assert.equal(journey.summary.idleMinutes,1);assert.equal(journey.summary.stoppedMinutes,1);assert.equal(journey.summary.stopUnknownMinutes,1);assert.equal(journey.summary.unknownMinutes,15);assert.equal(journey.summary.movingMinutes,3);
assert.equal(journey.routeSegments.length,2,'Do not draw through missing history');
assert.equal(journey.timeline.reduce((s,e)=>s+e.minutes,0),21);
assert.equal(h.calculateWheelseyeMovement([point(0,0,undefined),point(1,0,undefined)],'VAN',day).timeline[0].kind,'stop_unknown');
assert.equal(h.calculateWheelseyeMovement([point(0,0,1),point(1,0,1,78)],'VAN',day).timeline[0].kind,'gap');
assert.equal(h.calculateWheelseyeMovement([],'VAN',day).timeline.length,0);
assert.deepEqual(d.trackingFuel([{fuel_quantity:10,fuel_amount:1000,rate:50}]),{litres:10,estimatedLitres:0,missing:false},'Actual quantity wins');
assert.deepEqual(d.trackingFuel([{fuel_quantity:null,fuel_amount:900,rate:90}]),{litres:10,estimatedLitres:10,missing:false});
assert.deepEqual(d.trackingFuel([{fuel_quantity:null,fuel_amount:900,rate:null}]),{litres:null,estimatedLitres:0,missing:true});
const assignment={id:'a',name:'DA',vehicle_no:'VAN',station_code:'KOZA',work_date:day,provider_employee_id:'DA1',purpose:'delivery'};
assert.equal(d.matchAssignmentDeliveries([assignment],[{station_code:'OTHER',work_date:day,provider_employee_id:'DA1',total_delivery:50}])[0].delivered,null);
assert.equal(d.matchAssignmentDeliveries([assignment],[{station_code:'KOZA',work_date:'2026-10-04',provider_employee_id:'DA1',total_delivery:50}])[0].delivered,null);
assert.equal(d.matchAssignmentDeliveries([assignment],[{station_code:'KOZA',work_date:day,provider_employee_id:'OTHER',total_delivery:50}])[0].delivered,null);
const matched=d.matchAssignmentDeliveries([assignment],[{station_code:'KOZA',work_date:day,provider_employee_id:'DA1',total_delivery:50}]);assert.equal(d.assignmentPackageTotal(matched),50);assert.equal(d.assignmentPackageTotal([...matched,{...assignment,delivered:null}]),null);
assert.equal(d.assignmentPackageTotal([{...assignment,purpose:'shipment_drop',delivered:null}]),null);
// History refuses out-of-scope vehicles before requesting GPS credentials/provider data.
let called=0;
const route=compile('src/app/api/wheelseye/history/route.ts',{'@/lib/authorization':{getAuthorization:async()=>({userId:'user'})},'@/lib/fleet/report-data':{trackingScope:async()=>({companyId:'company',vehicles:[]}),FleetReportError:class extends Error{}},'@/lib/fleet/daily-report':{validateReportRange:()=>null},'@/lib/wheelseye':{getWheelseyeAccessToken:async()=>{called++;return 'token';}},'@/lib/wheelseye-history':h,'@/lib/fleet/gps-storage':{saveDailyWheelseyeKm:async()=>{called++;}}});
assert.equal((await route.GET(new Request('https://fleet.test/api/wheelseye/history?vehicle=SECRET&date=2026-10-05'))).status,403);assert.equal(called,0);
// Assignment database protects tenancy and duplicate daily package attribution.
const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;create table companies(id uuid primary key);create table fleet_daily_km(id uuid);create table fleet_vehicles(id uuid primary key,company_id uuid,vehicle_no text,station_code text);create table workforce(id uuid primary key,company_id uuid);create table stations(company_id uuid,station_code text);create function fleet_system_change_log() returns trigger language plpgsql as $$begin return coalesce(new,old);end;$$;`);
const migration=readFileSync('supabase/migrations/20261005182231_fleet_day_tracking_assignments.sql','utf8').split('create or replace function public.fleet_system_change_log()')[0];await db.exec(migration);
const c='11111111-1111-4111-8111-111111111111',v='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
await db.exec(`insert into companies values('${c}'),('${other}');insert into fleet_vehicles values('${v}','${c}','VAN','KOZA');insert into stations values('${c}','KOZA');`);
const insert=(company=c,id='DA1')=>`insert into fleet_day_assignments(company_id,vehicle_id,vehicle_no,station_code,work_date,provider_employee_id,name,source,purpose,created_by,updated_by)values('${company}','${v}','VAN','KOZA','2026-10-05','${id}','DA','shipment','delivery','${c}','${c}')`;
await db.exec(insert());await assert.rejects(db.exec(insert()),/duplicate key/);await assert.rejects(db.exec(insert(other,'DA2')),/company mismatch/);
await db.exec('update fleet_day_assignments set is_active=false');await db.exec(insert());
assert.equal((await db.query("select has_table_privilege('anon','fleet_day_assignments','SELECT') allowed")).rows[0].allowed,false);await db.close();
console.log('Day tracking: movement/stop/gap timing, split map, exact DA/day/station matches, missing feeds, fuel provenance, GPS access and database assignment integrity passed.');
