import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function load(file, mocks = {}) { const m = { exports: {} }; new Function('require', 'module', 'exports', ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(name => { if (!(name in mocks)) throw Error(`Unexpected import ${name}`); return mocks[name]; }, m, m.exports); return m.exports; }
const policy = load('./van-fuel.ts');
const labels = load('./payment-status-label.ts');
const attachments = load('./payment-request-attachments.ts');
test('only company-owned vehicles at the exact station are eligible', () => {
  for (const [ownership_type, station_code, expected] of [['own','KLZA',true],['odcd','KLZA',false],['rented','KLZA',false],['own','KTUR',false]]) assert.equal(policy.ownStationVehicle({ownership_type,station_code}, 'KLZA'),expected);
});
test('fuel dates and actual litres reject missing, invalid, future and non-positive input', () => {
  assert.deepEqual(policy.validateFuelInput('2026-10-31','',false,'2026-10-31'),{fuel_date:'2026-10-31',litres:null});
  for (const [date,litres] of [['2026-11-01','5'],['2026-02-30','5'],['','5'],['2026-10-31',''],['2026-10-31','0'],['2026-10-31','-1'],['2026-10-31','Infinity']]) assert.throws(()=>policy.validateFuelInput(date,litres,true,'2026-10-31'));
});
function dbMock(data) { return { from(table) { const filters=[]; const q={ table, filters, select(){return q}, eq(k,v){filters.push([k,v]);return q}, in(){return q}, not(){return q}, order(){return q}, maybeSingle(){return Promise.resolve({data: typeof data[table]==='function'? data[table](filters):data[table],error:null})}, then(resolve,reject){return Promise.resolve({data:typeof data[table]==='function'?data[table](filters):data[table],error:null}).then(resolve,reject)} };return q; } }; }
const vehicle = {id:'own',vehicle_no:'KL11BZ0772',station_code:'KLZA',ownership_type:'own'};
const bill = {file_path:'bill/path',file_name:'bill.jpg'};
const form = () => {const f=new FormData();f.set('fuel_vehicle_id','own');f.set('fuel_date','2026-10-31');f.set('fuel_litres','10');return f;};
function server(data) {return load('./van-fuel-server.ts',{'@/lib/supabase-admin':{supabaseAdmin:dbMock(data)},'@/lib/van-fuel':policy,'@/lib/payment-volume-data':{paymentVolumeToday:()=> '2026-10-31'},'@/lib/supabase-pagination':{readAllRows:q=>q},'@/lib/payment-request-attachments':attachments});}
test('server rejects foreign/stale mapping and enforces a bill at actual submission',async()=>{
 for (const row of [null,{...vehicle,ownership_type:'rented'},{...vehicle,station_code:'KTUR'}]) await assert.rejects(server({fleet_vehicles:row}).prepareVanFuel('company','VAN_FUEL','KLZA',form(),false));
 await assert.rejects(server({fleet_vehicles:vehicle,payment_heads:[{payment_head_questions:[{id:'bill',answer_type:'file',question_text:'Attach Bill'}]}]}).prepareVanFuel('company','VAN_FUEL','KLZA',form(),true),/Attach the fuel bill/);
});
test('saved vehicle/date persist into payment, with fresh litres and preserved other details',async()=>{
 const saved={other:'retain',van_fuel:{...vehicle,vehicle_id:'own',fuel_date:'2026-10-30',litres:null}};
 const f=form();f.set('fuel_vehicle_id','tampered');f.set('request_id','request');
 const result=await server({payment_heads:[{payment_head_questions:[{id:'bill',answer_type:'file',question_text:'Attach Bill'}]}],payment_request_answers:[bill]}).prepareVanFuel('company','VAN_FUEL','KLZA',f,true,saved,true);
 assert.equal(result.details.van_fuel.vehicle_id,'own');assert.equal(result.details.van_fuel.fuel_date,'2026-10-30');assert.equal(result.details.van_fuel.litres,10);assert.equal(result.details.other,'retain');
});
test('Fleet counts actual final-approved bills once and keeps all other states out of totals',async()=>{
 const base={id:'one',request_no:'FUEL1',details:{van_fuel:{vehicle_id:'own',vehicle_no:'KL11BZ0772',station_code:'KLZA',fuel_date:'2026-10-31',litres:10}},amount:1000,amount_requested:900,status:'approved',approval_status:'APPROVED'};
 const rows=[base,{...base,id:'pending',approval_status:'PENDING'}, {...base,id:'intermediate',current_approver_role_id:'next'}, {...base,id:'estimate',amount:null}, {...base,id:'returned',approval_status:'RETURNED'}, {...base,id:'rejected',approval_status:'REJECTED'}, {...base,id:'cancelled',status:'cancelled'}, {...base,id:'missingbill'}, {...base,id:'legacy',details:{}}];
 const data={payment_heads:[{id:'head'}],payment_requests:rows,payment_request_answers:rows.filter(r=>r.id!=='missingbill').map(r=>({...bill,payment_request_id:r.id}))};
 const ledger=load('./fleet/portal-fuel.ts',{'@/lib/supabase-admin':{supabaseAdmin:dbMock(data)},'@/lib/supabase-pagination':{readAllRows:q=>q},'@/lib/van-fuel':policy,'@/lib/payment-status-label':labels,'@/lib/payment-request-attachments':attachments});
 let result=await ledger.loadPortalFuel('company');assert.equal(result.approved.length,1);assert.equal(result.approved[0].fuel_amount,1000);assert.equal(result.pending.length,5);
 base.status='processing';base.approval_status='PROCESSING'; result=await ledger.loadPortalFuel('company');assert.equal(result.approved.length,1);assert.equal(result.approved[0].transaction_id,'one');
});
