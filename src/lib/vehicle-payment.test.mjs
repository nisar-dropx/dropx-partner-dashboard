import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function load(file, mocks = {}) { const m = { exports: {} }; new Function('require','module','exports',ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(name=>{if (!(name in mocks)) throw Error(name);return mocks[name];},m,m.exports);return m.exports; }
const fuel=load('./van-fuel.ts');
const policy=load('./vehicle-payment.ts',{'@/lib/van-fuel':fuel});
const own={id:'vehicle',vehicle_no:'KL11AA1234',station_code:'KLZA',ownership_type:'own'};
function server(vehicle=own) {
 const filters=[];
 const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},async maybeSingle(){return {data:vehicle,error:null};}};
 const api=load('./vehicle-payment-server.ts',{'@/lib/supabase-admin':{supabaseAdmin:{from(){return q;}}},'@/lib/vehicle-payment':policy,'@/lib/van-fuel-server':{prepareVanFuel:async()=>({details:{fuel:true}})}});
 return {...api,filters};
}
function form(id='vehicle') {const f=new FormData();f.set('payment_vehicle_id',id);return f;}
test('fuel, tyre and service allow only own vehicles at the selected station',()=>{
 for(const code of ['VAN_FUEL','VEHICLE_REPAIR','VEHICLE_SERVICE']) {
  assert.equal(policy.eligiblePaymentVehicle(own,'KLZA',code),true);
  for(const row of [{...own,ownership_type:'rented'},{...own,ownership_type:'odcd'},{...own,station_code:'KTUR'}]) assert.equal(policy.eligiblePaymentVehicle(row,'KLZA',code),false);
 }
});
test('driver accepts mapped station vehicles; adhoc van and non-vehicle heads stay separate',()=>{
 assert.equal(policy.eligiblePaymentVehicle({...own,ownership_type:'rented'},'KLZA','ADHOC_DRIVER'),true);
 assert.equal(policy.eligiblePaymentVehicle(own,'KTUR','ADHOC_DRIVER'),false);
 for(const code of ['VAN_ADHOC','GENERATOR_FUEL','ADHOC_DA','ELECTRICITY_BILL']) assert.equal(policy.vehiclePaymentPolicy(code),null);
});
test('request requires vehicle and rejects foreign, rented or removed maintenance mapping',async()=>{
 for(const code of ['VEHICLE_REPAIR','VEHICLE_SERVICE']) {
  await assert.rejects(server().prepareVehiclePayment('company',code,'KLZA',form(''),false),/Select a vehicle/);
  for(const v of [null,{...own,ownership_type:'rented'},{...own,station_code:'KTUR'}]) await assert.rejects(server(v).prepareVehiclePayment('company',code,'KLZA',form(),false),/company-owned/);
 }
});
test('persists canonical vehicle number and company scoped lookup without losing details',async()=>{
 const api=server();const result=await api.prepareVehiclePayment('company','VEHICLE_SERVICE','KLZA',form(),false,{other:'keep'});
 assert.equal(result.details.vehicle_no,own.vehicle_no);assert.equal(result.details.other,'keep');
 assert.deepEqual(api.filters,[['company_id','company'],['id','vehicle']]);
 assert.deepEqual(policy.paymentVehicleDetails(result.details),{vehicle_id:'vehicle',vehicle_no:own.vehicle_no,station_code:'KLZA'});
});
test('approved estimate preserves vehicle; legacy payment requires new selection; returns revalidate',async()=>{
 const saved={payment_vehicle:{vehicle_id:'saved',vehicle_no:'KL11AA9999',station_code:'KLZA'}};
 const api=server(null);
 const result=await api.prepareVehiclePayment('company','VEHICLE_SERVICE','KLZA',form('tampered'),true,saved,true);
 assert.equal(result.details.vehicle_no,'KL11AA9999');assert.equal(api.filters.length,0);
 await assert.rejects(api.prepareVehiclePayment('company','VEHICLE_SERVICE','KLZA',form(),true,{},true));
 await assert.rejects(api.prepareVehiclePayment('company','VEHICLE_SERVICE','KLZA',form(),true,saved,false));
});
test('fuel validation stays delegated; unrelated requests do not acquire vehicle details',async()=>{
 assert.deepEqual(await server().prepareVehiclePayment('company','VAN_FUEL','KLZA',form(),true),{details:{fuel:true}});
 assert.deepEqual(await server().prepareVehiclePayment('company','DRINKING_WATER','KLZA',form(),true),{});
});
test('driver reasons validate server-side and persist canonical person or Fleet vehicle',async()=>{
 let args;
 const api=load('./vehicle-payment-server.ts',{'@/lib/supabase-admin':{supabaseAdmin:{rpc:async(name,input)=>{assert.equal(name,'validate_adhoc_driver_request');args=input;return {data:{reason_key:'driver_leave',work_date:'2026-11-04',workforce_id:'worker',person_name:'Canonical Driver'},error:null};}}},'@/lib/vehicle-payment':policy,'@/lib/van-fuel-server':{}});
 const f=new FormData();f.set('driver_reason','driver_leave');f.set('driver_work_date','2026-11-04');f.set('driver_workforce_id','worker');
 const result=await api.prepareVehiclePayment('company','ADHOC_DRIVER','KLZA',f,false,{other:'keep'});
 assert.equal(args.p_company,'company');assert.equal(args.p_station_code,'KLZA');assert.equal(args.p_details.workforce_id,'worker');assert.equal(result.details.adhoc_driver.person_name,'Canonical Driver');assert.equal(result.details.payment_vehicle,null);assert.equal(result.details.other,'keep');
 assert.deepEqual(await api.prepareVehiclePayment('company','ADHOC_DRIVER','KLZA',new FormData(),true,{legacy:'approved'},true),{details:{legacy:'approved'}});
});
test('driver validation failure prevents request creation',async()=>{
 const api=load('./vehicle-payment-server.ts',{'@/lib/supabase-admin':{supabaseAdmin:{rpc:async()=>({data:null,error:{message:'Recorded attendance must be reviewed'}})}},'@/lib/vehicle-payment':policy,'@/lib/van-fuel-server':{}});
 await assert.rejects(api.prepareVehiclePayment('company','ADHOC_DRIVER','KLZA',new FormData(),false),/Recorded attendance/);
});
