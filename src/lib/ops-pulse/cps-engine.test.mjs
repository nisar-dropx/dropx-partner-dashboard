import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const mod={exports:{}};
new Function('exports','module',ts.transpileModule(readFileSync(new URL('./cps-engine.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod.exports,mod);
const {monthlyAccrual,allocateCost,rebuildCps,calculateRateCard}=mod.exports;
const day=(station='A',date='2026-09-01',deliveries=100)=>({station_code:station,work_date:date,deliveries,activity:deliveries,associate_rows:1,unmapped:0,unpaid:0,da:99999,utr:0,van:0,other:0,rent:0,total:99999,shipment_present:true,utr_configured:false,target:null});
const base=(days=[day()])=>({daily:days,breakup:days.map(d=>({station_code:d.station_code,work_date:d.work_date,head:'DA',sub_head:'Associate payout',source:'Shipment payment mapping',amount:99999})),generated_at:'now'});
const facts=()=>({shipments:[{id:'s1',client:'Amazon',work_date:'2026-09-01',station_code:'A',provider_employee_id:'AM1',provider_employee_name:'Person',amazon_delivery:80,swa_delivery:20,total_delivery:100,total_activity:100,c_return:0,mfn:0,mfn_return:0}],volumes:[{station_code:'A',work_date:'2026-09-01',deliveries:100}],mappings:[{id:'m1',workforce_id:'w1',provider_id:'amazon',provider_member_id:'AM1',station_id:'station-a',effective_from:'2026-01-01',effective_to:null,status:'active',payment_method_id:'per-packet',payment_values:{DELIVERY:10},pay_type:'PER_PACKET'}],workforce:[{id:'w1',full_name:'Person',dropx_id:'D1',location_id:'station-a',date_of_join:'2026-01-01',is_active:true}],components:[{payment_method_id:'per-packet',component_code:'DELIVERY',component_type:'production',calculation_type:'count_x_rate'}],providers:[{id:'amazon',code:'AMAZON',name:'Amazon'}],stations:[{id:'station-a',station_code:'A',is_active:true,state:'KL'},{id:'station-b',station_code:'B',is_active:true,state:'KL'}],employees:[],salaries:[],people_rules:[]});
const near=(a,b)=>assert.ok(Math.abs(a-b)<.000001,`${a} != ${b}`);
test('monthly calendar accrual exactly conserves full CTC for February and 31-day months',()=>{
 for(const [month,count] of [['2024-02',29],['2026-08',31],['2026-09',30]])near(Array.from({length:count},(_,i)=>monthlyAccrual(23456.78,`${month}-${String(i+1).padStart(2,'0')}`)).reduce((a,b)=>a+b,0),23456.78);
});
test('shared allocation conserves cents and splits zero-volume days equally',()=>{
 const v=new Map([['A',100],['B',300]]);assert.deepEqual([...allocateCost(100,['A','B'],v)], [['A',25],['B',75]]);
 near([...allocateCost(100.01,['A','B','C'],new Map()).values()].reduce((a,b)=>a+b,0),100.01);
});
test('live mapping correction replaces stale import payout without reupload',()=>{
 const f=facts();f.mappings=[];let r=rebuildCps(base(),f);assert.equal(r.daily[0].da,0);assert.equal(r.daily[0].deliveries,100);assert.equal(r.daily[0].exposed_deliveries,100);
 f.mappings=facts().mappings;r=rebuildCps(base(),f);assert.equal(r.daily[0].da,1000);assert.equal(r.associates[0].dropx_emp_code,'D1');assert.equal(r.daily[0].exposed_deliveries,0);
});
test('DELIVERY rates cover Amazon plus SWA and van rent stays out of DA',()=>{
 const f=facts();f.components.push({payment_method_id:'per-packet',component_code:'VAN_RENT_PER_DAY',component_type:'amount',pay_schedule:'per_day'});f.mappings[0].payment_values.VAN_RENT_PER_DAY=700;
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].da_variable,1000);assert.equal(r.daily[0].van,700);assert.equal(r.daily[0].total,1700);assert.equal(r.associates[0].da_total_pay,1000);
});
test('salary accrues on days with no uploaded row and MTD equals daily sums',()=>{
 const f=facts();f.mappings[0].payment_values={SALARY:30000};f.components=[{payment_method_id:'per-packet',component_code:'SALARY',component_type:'amount',pay_schedule:'per_month'}];
 const days=[day(),day('A','2026-09-02',0)];const combined=rebuildCps(base(days),f);
 assert.equal(combined.daily[0].da_salary,1000);assert.equal(combined.daily[1].da_salary,1000);assert.equal(combined.people[0].zero_delivery_days,1);
 near(combined.daily.reduce((n,d)=>n+d.total,0),days.reduce((n,d)=>n+rebuildCps(base([d]),{...f,shipments:f.shipments.filter(s=>s.work_date===d.work_date)}).daily[0].total,0));
});
test('multiple provider IDs and stations share a fixed salary once; viewing filter cannot inflate it',()=>{
 const f=facts();f.mappings[0].payment_values={SALARY:30000};f.components=[{payment_method_id:'per-packet',component_code:'SALARY',component_type:'amount',pay_schedule:'per_month'}];
 f.mappings.push({...f.mappings[0],id:'m2',provider_member_id:'AM2',station_id:'station-b'});
 f.shipments.push({...f.shipments[0],id:'s2',station_code:'B',provider_employee_id:'AM2',total_delivery:300});
 let r=rebuildCps(base([day(),day('B','2026-09-01',300)]),f);assert.equal(r.daily[0].da_salary,250);assert.equal(r.daily[1].da_salary,750);
 r=rebuildCps(base(),f);assert.equal(r.daily[0].da_salary,250);assert.ok(r.associates.every(a=>a.station_code==='A'));assert.ok(r.people.every(a=>a.station_code==='A'));
});
test('identity conflict never guesses a DropX ID',()=>{
 const f=facts();f.workforce.push({...f.workforce[0],id:'w2',dropx_id:'D2'});f.mappings.push({...f.mappings[0],id:'m2',workforce_id:'w2'});
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].da,0);assert.equal(r.daily[0].exposed_deliveries,100);assert.match(r.gaps[0].kind,/Conflicting/);
});
test('missing component values and unknown production sources remain visible',()=>{
 const f=facts();f.mappings[0].payment_values={};let r=rebuildCps(base(),f);assert.equal(r.daily[0].exposed_deliveries,100);
 f.mappings[0].payment_values={DELIVERY:5};f.components[0].calculation_source='DISTANCE_UNKNOWN';r=rebuildCps(base(),f);assert.equal(r.daily[0].da,0);assert.match(r.gaps[0].kind,/production source/);
});
test('rate revisions use effective dates and reject simultaneous conflicting cards',()=>{
 const f=facts();f.mappings.push({...f.mappings[0],id:'m2',effective_from:'2026-09-02',payment_values:{DELIVERY:20}});
 let r=rebuildCps(base(),f);assert.equal(r.daily[0].da,1000);
 f.mappings[1].effective_from='2026-01-01';r=rebuildCps(base(),f);assert.equal(r.daily[0].da,0);assert.match(r.gaps[0].kind,/Conflicting rate/);
});
test('People CTC includes full employer cost, dates, and shared overhead without filter leakage',()=>{
 const f=facts();f.employees=[{id:'e1',employee_code:'E1',full_name:'Staff',location_id:'station-a',is_active:true,date_of_join:'2026-01-01',designation:'SSA'},{id:'e2',employee_code:'E2',full_name:'Manager',location_id:'ho',is_active:true,date_of_join:'2026-01-01',designation:'CLM',location_scope_ids:['station-a','station-b']}];
 f.stations.push({id:'ho',station_code:'HO_KL',state:'KL',is_active:true});f.salaries=f.employees.map(e=>({employee_id:e.id,effective_from:'2026-01-01',monthly_ctc:30000}));f.volumes.push({station_code:'B',work_date:'2026-09-01',deliveries:300});
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].utr,1000);assert.equal(r.daily[0].overhead,250);assert.equal(r.daily[0].utr_configured,true);
});
test('People allocation override replaces automatic allocation and missing CTC is flagged',()=>{
 const f=facts();f.employees=[{id:'e1',employee_code:'E1',full_name:'Staff',location_id:'station-a',is_active:true,designation:'SSA'}];f.salaries=[{employee_id:'e1',effective_from:'2026-01-01',monthly_ctc:30000}];f.people_rules=[{employee_id:'e1',station_codes:['A','B'],head:'Overhead',allocation:'equal',effective_from:'2026-01-01'}];
 let r=rebuildCps(base(),f);assert.equal(r.daily[0].utr,0);assert.equal(r.daily[0].overhead,500);
 f.salaries=[];r=rebuildCps(base(),f);assert.ok(r.gaps.some(g=>g.kind==='People CTC missing'));
});
test('salary linked to People is not charged again by workforce rate card',()=>{
 const f=facts();f.workforce[0].source_profile_type='employee';f.workforce[0].source_profile_id='e1';f.mappings[0].payment_values={SALARY:30000};f.components=[{payment_method_id:'per-packet',component_code:'SALARY',component_type:'amount',pay_schedule:'per_month'}];
 f.employees=[{id:'e1',employee_code:'E1',full_name:'DA employee',location_id:'station-a',is_active:true,designation:'DA'}];f.salaries=[{employee_id:'e1',effective_from:'2026-01-01',monthly_ctc:33000}];
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].da_salary,1100);assert.equal(r.people[0].salary,1100);
});
test('monthly commitments stop at last working date',()=>{
 const f=facts();f.workforce[0].is_active=false;f.workforce[0].last_working_date='2026-09-01';f.shipments=[];f.mappings[0].payment_values={SALARY:30000};f.components=[{payment_method_id:'per-packet',component_code:'SALARY',component_type:'amount',pay_schedule:'per_month'}];
 const r=rebuildCps(base([day('A','2026-09-01',0),day('A','2026-09-02',0)]),f);assert.equal(r.daily[0].da_salary,1000);assert.equal(r.daily[1].da_salary,0);
});
