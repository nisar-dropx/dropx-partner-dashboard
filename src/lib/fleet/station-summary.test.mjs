import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
function load(file, mocks = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => { if (!(name in mocks)) throw Error(`Unexpected import ${name}`); return mocks[name]; }, Response, console });
  return exports;
}
const policy = load('src/lib/fleet/vehicle-status-policy.ts');
const summary = load('src/lib/fleet/station-summary.ts', { './vehicle-status-policy': policy });
test('counts only current owned fleet; keeps unavailable vehicles and respects custom terminal status', () => {
  const vehicles = [
    ['own','active','A','Mahindra'], ['own','breakdown','A','Mahindra'], ['own','active','A','Piaggio'],
    ['odcd','active','B','Auto'], ['rented','active','A','Van'], ['own','archived','B','Van'],
    ['own','sold','B','Van'], ['own','retired','C','Van'], ['own','active','UNASSIGNED','Van']
  ].map(([ownershipType,status,stationCode,model], i) => ({ id: String(i), ownershipType,status,stationCode,model }));
  const rows = summary.ownedStationGroups(vehicles, [{ key:'retired', isOperational:false, isTerminal:true }]);
  assert.equal(rows.length, 1); assert.equal(rows[0].total, 3); assert.equal(rows[0].models.Mahindra, 2); assert.equal(rows[0].models.Piaggio, 1);
});
test('map links reject missing and invalid coordinates without inventing locations', () => {
  for (const coords of [[null,76],[10,null],[0,0],[91,76],[10,181],[NaN,76]]) assert.equal(summary.stationMapUrl(...coords), null);
  assert.equal(summary.stationMapUrl(10.5,76.2), 'https://www.google.com/maps/search/?api=1&query=10.5,76.2');
});
function route({ auth = { hasAllLocationAccess:false, locationScopeIds:['s1'], userId:'u' }, permission = true, failure } = {}) {
  const queries=[];
  const data = {
    fleet_vehicles:[{station_code:'A',status:'breakdown'}], fleet_vehicle_status_master:[],
    stations:[{id:'s1',station_code:'A',address:'Station address',latitude:10,longitude:76}],
    hr_work_assignments:[{id:'a1',engagement_id:'e1',location_id:'s1',designation_id:'d1'}, {id:'a2',engagement_id:'e1',location_id:'s1',designation_id:'d1'}],
    designations:[{id:'d1',name:'Team Lead',code:'TL'}], hr_engagements:[{id:'e1',person_id:'p1'}],
    hr_people:[{id:'p1',display_name:'Test lead',primary_mobile:'+910000000000'}]
  };
  const db = { from(table) { const calls=[]; const query={table,calls}; for(const method of ['select','eq','in','lte','or','order']) query[method]=(...args)=>{calls.push([method,...args]);return query;}; queries.push(query); return query; } };
  return { queries, get:load('src/app/api/fleet/station-contacts/route.ts', {
    '@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:()=>permission},
    '@/lib/company-scope':{requireCompanyId:()=> 'company'}, '@/lib/fleet-control':{hasActiveFleetMembership:async()=>true},
    '@/lib/supabase-admin':{supabaseAdmin:db}, '@/lib/ops-pulse/cod':{todayKolkata:()=> '2026-11-05',loadCodLocations:async(c,ids,all)=>{assert.equal(c,'company');assert.deepEqual(ids,['s1']);assert.equal(all,false);return {locations:[{id:'s1',station_code:'A',station_name:'Station A'}]};}},
    '@/lib/supabase-pagination':{readAllRows:async q=>q.table===failure?{error:{message:'fixture failure'},data:null}:{data:data[q.table],error:null}},
    '@/lib/approval-designation-labels':{isTeamLeadDesignation:d=>d.code==='TL'}, '@/lib/fleet/vehicle-status-policy':policy
  }).GET };
}
test('contact endpoint requires authentication and vehicle access before reading contacts',async()=>{
  for(const options of [{auth:null},{permission:false}]) { const r=route(options); const response=await r.get(); assert.equal(response.status, options.auth===null ? 401 : 403); assert.equal(r.queries.length,0); }
});
test('contacts use company and permitted locations, effective assignments and active People identities',async()=>{
  const r=route();const response=await r.get();assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.stations[0].team.length,1);assert.equal(body.stations[0].team[0].name,'Test lead');assert.equal(body.stations[0].team[0].isTeamLead,true);
  for(const query of r.queries) assert.ok(query.calls.some(c=>c[0]==='eq'&&c[1]==='company_id'&&c[2]==='company'));
  const assignments=r.queries.find(q=>q.table==='hr_work_assignments');
  assert.ok(assignments.calls.some(c=>c[0]==='in'&&c[1]==='location_id'&&c[2].join()==='s1'));
  assert.ok(assignments.calls.some(c=>c[0]==='lte'&&c[1]==='effective_from'));
  assert.ok(r.queries.find(q=>q.table==='hr_people').calls.some(c=>c[0]==='eq'&&c[1]==='status'&&c[2]==='active'));
});
test('People failure preserves station location and shows explicit contacts warning',async()=>{
  const r=route({failure:'hr_people'}); const response=await r.get();const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.stations[0].address,'Station address');assert.equal(body.stations[0].team.length,0);assert.match(body.contactsError,/could not be loaded/);
});
