import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
function load(file,require=()=>({})){const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,require);return exports;}
const helpers=load('src/lib/fleet/gps-exceptions.ts');
const event={vehicleNo:'KL01',date:'2026-10-04',lateNight:true,km:10};
const review={vehicleNo:'KL01',date:'2026-10-04',remarks:'Delivery authorised',reason:'authorised_work'};
const dataset={dailyKm:[event,{...event,source:'other'},{...event,date:'2026-10-05'},{...event,date:'2026-10-06'},{...event,vehicleNo:'KL02',lateNight:false}],gpsExceptionReviews:[review]};
assert.deepEqual(helpers.gpsExceptions(dataset,'2026-10-01','2026-10-05').map(r=>r.date),['2026-10-05']);
assert.equal(helpers.gpsExceptions(dataset,'2026-10-01','2026-10-05','acknowledged').length,1);
assert.equal(helpers.gpsExceptions({...dataset,dailyKm:[...dataset.dailyKm,{...event,km:12}]},'2026-10-01','2026-10-04').length,0,'GPS refresh must not reopen reviewed date');
assert.equal(helpers.isOwnedVehicle({ownershipType:'own'}),true);
for(const ownershipType of ['rented','odcd'])assert.equal(helpers.isOwnedVehicle({ownershipType}),false);
let auth={isMasterOwner:false,userId:'user',fullName:'Reviewer',email:'reviewer@example.test',hasAllLocationAccess:false,locationScopeIds:['station']};
let member=true,edit=true,access=true,saved,dbError=false;
const records={fleet_vehicles:{id:'vehicle',vehicle_no:'KL01',station_code:'KOZA',ownership_type:'own'},stations:[{station_code:'KOZA'}],fleet_daily_km:[{id:'day'}]};
const queries=[];
const db={from(table){const builder=new Proxy({}, {get(_,key){if(key==='then')return(resolve)=>resolve({data:records[table]||[],error:dbError?{message:'Write failed'}:null});return(...args)=>{queries.push([table,key,...args]);if(key==='upsert'||key==='insert')saved=args[0];return builder;};}});return builder;}};
const api=load('src/app/api/fleet/gps-exceptions/route.ts',name=>({
 '@/lib/fleet/system-log':{withFleetSystemLog:fn=>fn},
 '@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:(_,code,action)=>action==='access'?access:edit},'@/lib/company-scope':{requireCompanyId:()=> 'company'},'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/fleet-control':{hasActiveFleetMembership:async()=>member},'@/lib/fleet/gps-exceptions':helpers,'@/lib/wheelseye':{getWheelseyeAccessToken:async()=> 'token'},'@/lib/wheelseye-history':{loadWheelseyeMovement:async()=>({points:[],afterHours:[]})}
}[name]||{}));
const post=async(body={})=>{saved=undefined;return api.POST(new Request('https://fleet.test/api/fleet/gps-exceptions',{method:'POST',body:JSON.stringify({vehicleNo:'KL01',date:'2026-10-04',reason:'authorised_work',remarks:'Late delivery confirmed',reviewedBy:'Forged',...body})}));};
let r=await post();assert.equal(r.status,200);assert.equal(saved.reviewed_by,'user');assert.equal(saved.reviewed_by_name,'Reviewer');assert.equal(saved.company_id,'company');assert.ok(queries.some(q=>q[0]==='fleet_daily_km'&&q[1]==='eq'&&q[2]==='company_id'));
for(const body of [{remarks:''},{reason:'invalid'},{date:'2026-02-30'},{remarks:'x'.repeat(2001)}])assert.equal((await post(body)).status,400);
edit=false;assert.equal((await post()).status,403);assert.equal((await api.GET(new Request('https://fleet.test/api/fleet/gps-exceptions?vehicle=KL01&date=2026-10-04'))).status,200);edit=true;
member=false;assert.equal((await post()).status,403);member=true;access=false;assert.equal((await post()).status,403);access=true;
records.stations=[{station_code:'OTHER'}];assert.equal((await post()).status,403);records.stations=[{station_code:'KOZA'}];
records.fleet_daily_km=[];assert.equal((await post()).status,400);records.fleet_daily_km=[{id:'day'}];
dbError=true;assert.notEqual((await post()).status,200);dbError=false;
const savedAuth=auth;auth=null;assert.equal((await post()).status,401);auth=savedAuth;
const service=load('src/app/api/fleet-control/route.ts',name=>({
 '@/lib/fleet/system-log':{withFleetSystemLog:fn=>fn},
 'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},'@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:()=>true},'@/lib/company-scope':{requireCompanyId:()=> 'company'},'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/access-surface':{fleetAccessPageCodes:['fleet_maintenance']},'@/lib/fleet-control':{hasActiveFleetMembership:async()=>true}
}[name]||{}));
for(const ownership of ['rented','odcd'])for(const action of ['service.create','service.schedule']){records.fleet_vehicles.ownership_type=ownership;saved=undefined;const result=await service.POST(new Request('https://fleet.test/api/fleet-control',{method:'POST',body:JSON.stringify({action,vehicleId:'vehicle',serviceDate:'2026-10-06',serviceType:'Repair'})}));assert.equal(result.status,400);assert.match((await result.json()).error,/owned vehicles/);assert.equal(saved,undefined,'Partner vehicle cannot create service record');}
records.fleet_vehicles.ownership_type='own';records.fleet_service_history={id:'service'};assert.equal((await service.POST(new Request('https://fleet.test/api/fleet-control',{method:'POST',body:JSON.stringify({action:'service.create',vehicleId:'vehicle',serviceDate:'2026-10-06',serviceType:'Repair'})}))).status,200);
console.log('GPS exceptions: deduplication, date bounds, persistent acknowledgement, separate-day alerts, actor attribution, permissions, location scope and service ownership API guards passed.');
