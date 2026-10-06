import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const policy={exports:{}};
new Function('exports','module',ts.transpileModule(readFileSync(new URL('../workforce-payment-policy.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(policy.exports,policy);
const direct={exports:{}};
new Function('exports','module','require',ts.transpileModule(readFileSync(new URL('../direct-workforce-pay.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(direct.exports,direct,(id)=>{if(id==='./workforce-payment-policy.ts')return policy.exports;throw new Error(`Unexpected import ${id}`);});
const attendanceCapture={exports:{}};
new Function('exports','module',ts.transpileModule(readFileSync(new URL('../workforce-attendance-capture.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(attendanceCapture.exports,attendanceCapture);
const productionThresholdConfig={exports:{}};
new Function('exports','module',ts.transpileModule(readFileSync(new URL('../production-threshold-config.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(productionThresholdConfig.exports,productionThresholdConfig);
const productionThresholdSnapshot={exports:{}};
new Function('exports','module','require',ts.transpileModule(readFileSync(new URL('../production-threshold-snapshot.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(productionThresholdSnapshot.exports,productionThresholdSnapshot,(id)=>{if(id==='./production-threshold-config.ts')return productionThresholdConfig.exports;throw new Error(`Unexpected import ${id}`);});
const workforceProductionThreshold={exports:{}};
new Function('exports','module','require',ts.transpileModule(readFileSync(new URL('../workforce-production-threshold.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(workforceProductionThreshold.exports,workforceProductionThreshold,(id)=>{if(id==='./production-threshold-config.ts')return productionThresholdConfig.exports;if(id==='./production-threshold-snapshot.ts')return productionThresholdSnapshot.exports;throw new Error(`Unexpected import ${id}`);});
const payoutInputs={exports:{}};
new Function('exports','module',ts.transpileModule(readFileSync(new URL('../workforce-payout-input-calculation.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(payoutInputs.exports,payoutInputs);
const details={exports:{}};
new Function('exports','module',ts.transpileModule(readFileSync(new URL('./cps-details.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(details.exports,details);
const fallback={exports:{}};
new Function('exports','module',ts.transpileModule(readFileSync(new URL('./production-fallback.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(fallback.exports,fallback);
const mod={exports:{}};
new Function('exports','module','require',ts.transpileModule(readFileSync(new URL('./cps-engine.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod.exports,mod,(id)=>{if(id==='./production-fallback')return fallback.exports;if(id==='../workforce-payout-input-calculation')return payoutInputs.exports;if(id==='./cps-details')return details.exports;if(id==='../direct-workforce-pay')return direct.exports;if(id==='../workforce-payment-policy')return policy.exports;if(id==='../workforce-attendance-capture')return attendanceCapture.exports;if(id==='../workforce-production-threshold')return workforceProductionThreshold.exports;throw new Error(`Unexpected import ${id}`);});
const {monthlyAccrual,allocateCost,rebuildCps,calculateRateCard}=mod.exports;
const day=(station='A',date='2026-09-01',deliveries=100)=>({station_code:station,work_date:date,deliveries,activity:deliveries,associate_rows:1,unmapped:0,unpaid:0,da:99999,utr:0,van:0,other:0,rent:0,total:99999,shipment_present:true,utr_configured:false,target:null});
const base=(days=[day()])=>({daily:days,breakup:days.map(d=>({station_code:d.station_code,work_date:d.work_date,head:'DA',sub_head:'Associate payout',source:'Shipment payment mapping',amount:99999})),generated_at:'now'});
const facts=()=>({shipments:[{id:'s1',client:'Amazon',work_date:'2026-09-01',station_code:'A',provider_employee_id:'AM1',provider_employee_name:'Person',amazon_delivery:80,swa_delivery:20,total_delivery:100,total_activity:100,c_return:0,mfn:0,mfn_return:0}],volumes:[{station_code:'A',work_date:'2026-09-01',deliveries:100}],mappings:[{id:'m1',workforce_id:'w1',provider_id:'amazon',provider_member_id:'AM1',station_id:'station-a',effective_from:'2026-01-01',effective_to:null,status:'active',payment_method_id:'per-packet',payment_values:{DELIVERY:10},pay_type:'PER_PACKET'}],workforce:[{id:'w1',full_name:'Person',dropx_id:'D1',location_id:'station-a',date_of_join:'2026-01-01',is_active:true}],components:[{payment_method_id:'per-packet',component_code:'DELIVERY',component_type:'production',calculation_type:'count_x_rate'}],providers:[{id:'amazon',code:'AMAZON',name:'Amazon'}],stations:[{id:'station-a',station_code:'A',is_active:true,state:'KL'},{id:'station-b',station_code:'B',is_active:true,state:'KL'}],employees:[],salaries:[],people_rules:[],people_policies:[{designation_code:"SSA",mode:"home",head:"UTR",label:"Station staff CTC",allocation:"equal",effective_from:"2026-01-01"},{designation_code:"CLM",mode:"managed",head:"UTR",label:"Manager share",allocation:"equal",effective_from:"2026-01-01"},{designation_code:"DA",mode:"home",head:"DA",label:"Salary / minimum guarantee",allocation:"equal",effective_from:"2026-01-01"}]});
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
test('combined daily production minimum uses field order and each field rate',()=>{
 const f=facts();
 f.shipments[0]={...f.shipments[0],amazon_delivery:80,swa_delivery:0,total_delivery:80,total_activity:110,c_return:30};
 f.components=[
  {...f.components[0],sort_order:0},
  {payment_method_id:'per-packet',component_code:'RETURN',component_type:'production',calculation_type:'count_x_rate',calculation_source:'c_return',sort_order:1}
 ];
 f.mappings[0].payment_values={DELIVERY:10,RETURN:20};
 f.mappings[0].production_threshold_config={period:'day',component_codes:['DELIVERY','RETURN'],minimum_units:100};
 f.mappings[0].method_production_threshold_config={period:'day',component_codes:['DELIVERY','RETURN']};
 const r=rebuildCps(base([day('A','2026-09-01',80)]),f);
 assert.equal(r.daily[0].da,200);
 assert.equal(r.associates[0].variable_pay,200);
 assert.equal(r.associates[0].mapping_status,'Mapped');
});
test('combined monthly production minimum accumulates across dates',()=>{
 const f=facts();
 f.shipments=[
  {...f.shipments[0],id:'s1',work_date:'2026-09-01',amazon_delivery:80,swa_delivery:0,total_delivery:80,total_activity:80},
  {...f.shipments[0],id:'s2',work_date:'2026-09-02',amazon_delivery:30,swa_delivery:0,total_delivery:30,total_activity:30}
 ];
 f.mappings[0].production_threshold_config={period:'month',component_codes:['DELIVERY'],minimum_units:100};
 f.mappings[0].method_production_threshold_config={period:'month',component_codes:['DELIVERY']};
 const r=rebuildCps(base([day('A','2026-09-01',80),day('A','2026-09-02',30)]),f);
 assert.deepEqual(r.daily.map(row=>row.da),[0,100]);
 assert.deepEqual(r.associates.map(row=>row.variable_pay),[0,100]);
});
test('daily CPS uses earlier calendar-month production to consume a monthly minimum without exposing carry-in rows',()=>{
 const f=facts();
 const current={...f.shipments[0],id:'current',work_date:'2026-09-15',amazon_delivery:30,swa_delivery:0,total_delivery:30,total_activity:30};
 const carryIn={...f.shipments[0],id:'carry-in',work_date:'2026-09-01',amazon_delivery:80,swa_delivery:0,total_delivery:80,total_activity:80};
 f.shipments=[current];
 f.mappings[0].production_threshold_config={period:'month',component_codes:['DELIVERY'],minimum_units:100};
 f.mappings[0].method_production_threshold_config={period:'month',component_codes:['DELIVERY']};
 f.production_threshold_context={
  shipments:[carryIn,current],mappings:f.mappings,workforce:f.workforce,
  components:f.components,providers:f.providers,stations:f.stations
 };
 const r=rebuildCps(base([day('A','2026-09-15',30)]),f);
 assert.equal(r.daily[0].da,100);
 assert.deepEqual(r.associates.map(row=>[row.id,row.work_date,row.variable_pay]),[['current','2026-09-15',100]]);
 assert.ok(r.breakup.filter(line=>line.source==='Workforce rate card').every(line=>line.work_date==='2026-09-15'));
});
test('custom CPS range carries monthly threshold consumption forward while returning only selected dates',()=>{
 const f=facts();
 const first={...f.shipments[0],id:'selected-1',work_date:'2026-09-10',amazon_delivery:20,swa_delivery:0,total_delivery:20,total_activity:20};
 const second={...f.shipments[0],id:'selected-2',work_date:'2026-09-11',amazon_delivery:30,swa_delivery:0,total_delivery:30,total_activity:30};
 const carryIn={...f.shipments[0],id:'carry-in',work_date:'2026-09-01',amazon_delivery:70,swa_delivery:0,total_delivery:70,total_activity:70};
 f.shipments=[first,second];
 f.mappings[0].production_threshold_config={period:'month',component_codes:['DELIVERY'],minimum_units:100};
 f.mappings[0].method_production_threshold_config={period:'month',component_codes:['DELIVERY']};
 f.production_threshold_context={
  shipments:[carryIn,first,second],mappings:f.mappings,workforce:f.workforce,
  components:f.components,providers:f.providers,stations:f.stations
 };
 const r=rebuildCps(base([day('A','2026-09-10',20),day('A','2026-09-11',30)]),f);
 assert.deepEqual(r.daily.map(row=>row.da),[0,200]);
 assert.deepEqual(r.associates.map(row=>row.work_date),['2026-09-10','2026-09-11']);
 assert.equal(r.breakup.filter(line=>line.source==='Workforce rate card').reduce((sum,line)=>sum+line.amount,0),200);
});
test('enabled combined minimum without a person snapshot fails closed',()=>{
 const f=facts();
 f.mappings[0].method_production_threshold_config={period:'day',component_codes:['DELIVERY']};
 const r=rebuildCps(base(),f);
 assert.equal(r.daily[0].da,0);
 assert.equal(r.associates[0].mapping_status,'Combined production minimum missing');
 assert.ok(r.gaps.some(g=>g.kind==='Combined production minimum missing'));
});
test('DELIVERY rates cover Amazon plus SWA and van rent stays out of DA',()=>{
 const f=facts();f.components.push({payment_method_id:'per-packet',component_code:'VAN_RENT_PER_DAY',component_type:'amount',pay_schedule:'per_day'});f.mappings[0].payment_values.VAN_RENT_PER_DAY=700;
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].da_variable,1000);assert.equal(r.daily[0].van,700);assert.equal(r.daily[0].total,1700);assert.equal(r.associates[0].da_total_pay,1000);
});
test('shipment capture awards one attendance day at the inclusive delivery threshold',()=>{
 const f=facts();
 f.components=[{payment_method_id:'attendance',component_code:'DAILY',component_type:'amount',label:'Fixed pay per day',pay_schedule:'per_day',calculation_type:'fixed_daily',calculation_source:'attendance_eligibility'}];
 f.mappings[0].payment_method_id='attendance';f.mappings[0].payment_values={DAILY:800};
 f.attendance_capture_history=[{capture_method:'shipment_data',minimum_daily_deliveries:100,effective_from:'2026-09-01'}];
 let r=rebuildCps(base(),f);assert.equal(r.associates[0].mg_pay,800);assert.equal(r.people[0].paid_days,1);
 f.attendance_capture_history=[{capture_method:'shipment_data',minimum_daily_deliveries:101,effective_from:'2026-09-01'}];
 r=rebuildCps(base(),f);assert.equal(r.associates[0].mg_pay,0);assert.equal(r.people[0].paid_days,1);
});
test('shipment attendance aggregates a worker across stations outside the selected CPS view',()=>{
 const f=facts();
 f.shipments[0]={...f.shipments[0],amazon_delivery:60,swa_delivery:0,total_delivery:60,total_activity:60};
 f.components=[{payment_method_id:'attendance',component_code:'DAILY',component_type:'amount',label:'Fixed pay per day',pay_schedule:'per_day',calculation_type:'fixed_daily',calculation_source:'attendance_eligibility'}];
 f.mappings[0].payment_method_id='attendance';f.mappings[0].payment_values={DAILY:800};
 f.attendance_capture_history=[{capture_method:'shipment_data',minimum_daily_deliveries:100,effective_from:'2026-09-01'}];
 f.attendance_mappings=[f.mappings[0],{...f.mappings[0],id:'m2',provider_member_id:'AM2',station_id:'station-b'}];
 f.attendance_workforce=f.workforce;f.attendance_providers=f.providers;f.attendance_stations=f.stations;
 f.attendance_shipments=[f.shipments[0],{...f.shipments[0],id:'s2',station_code:'B',provider_employee_id:'AM2',amazon_delivery:50,total_delivery:50,total_activity:50}];
 const r=rebuildCps(base([day('A','2026-09-01',60)]),f);
 assert.equal(r.associates[0].mg_pay,800);
});
test('historical shipment mappings contribute to earned paid-off units in a later range',()=>{
 const f=facts();
 f.shipments=[{...f.shipments[0],id:'s-new',work_date:'2026-09-10',provider_employee_id:'NEW',amazon_delivery:1,swa_delivery:0,total_delivery:1,total_activity:1}];
 f.mappings[0]={...f.mappings[0],id:'m-new',provider_member_id:'NEW',effective_from:'2026-09-10',payment_method_id:'attendance',payment_values:{MONTHLY:3000}};
 f.components=[{payment_method_id:'attendance',component_code:'MONTHLY',component_type:'amount',label:'Monthly pay',pay_schedule:'per_month',calculation_type:'fixed_monthly',calculation_source:'attendance_eligibility'}];
 f.attendance_capture_history=[{capture_method:'shipment_data',minimum_daily_deliveries:1,effective_from:'2026-09-01'}];
 f.payment_policy_history=[{calculation_method:'earned_paid_offs',paid_off_days:4,work_units_per_paid_off:2,cap_at_monthly_amount:true,effective_from:'2026-09-01'}];
 f.attendance_mappings=[{...f.mappings[0],id:'m-old',provider_member_id:'OLD',effective_from:'2026-09-01',effective_to:'2026-09-09'},f.mappings[0]];
 f.attendance_workforce=f.workforce;f.attendance_providers=f.providers;f.attendance_stations=f.stations;
 f.attendance_shipments=[{...f.shipments[0],id:'s-old',work_date:'2026-09-01',provider_employee_id:'OLD'},f.shipments[0]];
 const r=rebuildCps(base([day('A','2026-09-10',1)]),f);
 assert.equal(r.associates[0].mg_pay,200);
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
test('provider rate cards gate fixed schedules by attendance without changing production pay',()=>{
 const card={payment_method_id:'mixed',payment_values:{DELIVERY:10,DAILY:600,MONTHLY:3000,HOURLY:100}};
 const components=[
  {component_code:'DELIVERY',component_type:'production',calculation_type:'count_x_rate',calculation_source:'total_delivery'},
  {component_code:'DAILY',component_type:'amount',pay_schedule:'per_day',calculation_source:'attendance_eligibility'},
  {component_code:'MONTHLY',component_type:'amount',pay_schedule:'per_month',calculation_type:'fixed_monthly',calculation_source:'attendance_eligibility'},
  {component_code:'HOURLY',component_type:'amount',pay_schedule:'per_hour',calculation_source:'attendance_eligibility'},
 ];
 const shipment={client:'Amazon',total_delivery:100};
 const present=calculateRateCard(card,components,shipment,'2026-09-01',true,{punch_date:'2026-09-01',status:'P',work_minutes:480});
 const half=calculateRateCard(card,components,shipment,'2026-09-02',true,{punch_date:'2026-09-02',status:'HD',work_minutes:240});
 const absent=calculateRateCard(card,components,shipment,'2026-09-03',true,{punch_date:'2026-09-03',status:'A',work_minutes:480});
 const missing=calculateRateCard(card,components,shipment,'2026-09-04',true);
 assert.deepEqual([present.salary,half.salary,absent.salary,missing.salary],[1500,750,0,0]);
 assert.deepEqual([present.variable,half.variable,absent.variable,missing.variable],[1000,1000,1000,1000]);
 assert.ok([present,half,absent,missing].every(result=>result.missing===false));
});
test('provider rate cards apply the configured monthly paid-off policy cumulatively',()=>{
 const card={payment_method_id:'fixed',payment_values:{MONTHLY:18000}};
 const components=[{component_code:'MONTHLY',component_type:'amount',pay_schedule:'per_month',calculation_type:'fixed_monthly',calculation_source:'attendance_eligibility'}];
 const policyHistory=[{calculation_method:'fixed_paid_offs',paid_off_days:4,work_units_per_paid_off:6,cap_at_monthly_amount:true,effective_from:'2026-09-01'}];
 const fifth=calculateRateCard(card,components,{},'2026-09-05',true,{punch_date:'2026-09-05',status:'P'},policyHistory,4);
 assert.equal(fifth.salary,692.31);
});
test('provider attendance pay creates fixed rows on worked days without a shipment upload',()=>{
 const f=facts();f.shipments=[];f.mappings[0].payment_values={DAILY:600,MONTHLY:3000,HOURLY:100};
 f.workforce[0].source_profile_type='employee';f.workforce[0].source_profile_id='e1';
 f.components=[
  {payment_method_id:'per-packet',component_code:'DAILY',component_type:'amount',pay_schedule:'per_day',calculation_source:'attendance_eligibility'},
  {payment_method_id:'per-packet',component_code:'MONTHLY',component_type:'amount',pay_schedule:'per_month',calculation_type:'fixed_monthly',calculation_source:'attendance_eligibility'},
  {payment_method_id:'per-packet',component_code:'HOURLY',component_type:'amount',pay_schedule:'per_hour',calculation_source:'attendance_eligibility'},
 ];
 f.attendance=[
  {employee_id:'e1',punch_date:'2026-09-01',status:'P',work_minutes:480},
  {employee_id:'e1',punch_date:'2026-09-02',status:'HD',work_minutes:240},
  {employee_id:'e1',punch_date:'2026-09-03',status:'A',work_minutes:480},
 ];
 const r=rebuildCps(base([day('A','2026-09-01',0),day('A','2026-09-02',0),day('A','2026-09-03',0),day('A','2026-09-04',0)]),f);
 assert.deepEqual(r.daily.map(row=>row.da_salary),[1500,750,0,0]);
 assert.deepEqual(r.associates.map(row=>row.work_date),['2026-09-01','2026-09-02']);
 assert.ok(r.associates.every(row=>row.id.startsWith('fixed:')&&row.mapping_status==='Mapped'));
});
test('rate revisions use effective dates and reject simultaneous conflicting cards',()=>{
 const f=facts();f.mappings.push({...f.mappings[0],id:'m2',effective_from:'2026-09-02',payment_values:{DELIVERY:20}});
 let r=rebuildCps(base(),f);assert.equal(r.daily[0].da,1000);
 f.mappings[1].effective_from='2026-01-01';r=rebuildCps(base(),f);assert.equal(r.daily[0].da,0);assert.match(r.gaps[0].kind,/Conflicting rate/);
});
test('People CTC includes full employer cost, dates, and shared UTR without filter leakage',()=>{
 const f=facts();f.employees=[{id:'e1',employee_code:'E1',full_name:'Staff',location_id:'station-a',is_active:true,date_of_join:'2026-01-01',designation:'SSA'},{id:'e2',employee_code:'E2',full_name:'Manager',location_id:'ho',is_active:true,date_of_join:'2026-01-01',designation:'CLM',location_scope_ids:['station-a','station-b']}];
 f.stations.push({id:'ho',station_code:'HO_KL',state:'KL',is_active:true});f.salaries=f.employees.map(e=>({employee_id:e.id,effective_from:'2026-01-01',monthly_ctc:30000}));f.volumes.push({station_code:'B',work_date:'2026-09-01',deliveries:300});
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].utr,1500);assert.equal(r.daily[0].overhead,0);assert.equal(r.staff.reduce((s,p)=>s+p.amount,0),1500);assert.equal(r.daily[0].utr_configured,true);
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
test('providerless workforce accrues direct attendance pay without a provider ID gap',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.workforce[0].is_field_operations=true;f.workforce[0].provider_mapping_required=false;
 f.allocations=[{id:'a1',workforce_id:'w1',station_id:'station-a',effective_from:'2026-01-01',effective_to:null,status:'active',payment_method_id:'direct',payment_values:{DAILY:700}}];
 f.components=[{payment_method_id:'direct',component_code:'DAILY',component_type:'amount',pay_schedule:'per_day',label:'Driver daily pay'}];
 f.attendance=[{workforce_id:'w1',punch_date:'2026-09-01',status:'P',in_time:'2026-09-01T03:00:00Z',out_time:'2026-09-01T11:00:00Z',work_minutes:480}];
 const r=rebuildCps(base([day('A','2026-09-01',0)]),f);assert.equal(r.daily[0].da,700);assert.equal(r.people[0].salary,700);assert.ok(!r.gaps.some(g=>g.kind==='Provider ID not linked'));
});
test('providerless workforce without a direct allocation has an actionable gap',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.workforce[0].is_field_operations=true;f.workforce[0].provider_mapping_required=false;
 const r=rebuildCps(base([day('A','2026-09-01',0)]),f);assert.ok(r.gaps.some(g=>g.kind==='Direct payment allocation missing'&&g.href.includes('/provider-mapping/direct-pay')));
});
test('provider-required workforce gaps use the canonical ID mapping URL with encoded filters',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.allocations=[];f.workforce[0].is_field_operations=true;f.workforce[0].provider_mapping_required=true;f.workforce[0].dropx_id='D1 / north';f.stations[0].station_code='A & B';f.volumes[0].station_code='A & B';
 const r=rebuildCps(base([day('A & B','2026-09-01',0)]),f);
 const gap=r.gaps.find(g=>g.kind==='Provider ID not linked'&&g.dropx_id==='D1 / north');
 assert.ok(gap);
 assert.equal(gap.href,'https://dashboard.dropxlogistics.com/provider-id-mapping?q=D1%20%2F%20north&station=A%20%26%20B');
});
test('historical direct cost stays on the allocation station after a workforce transfer',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.workforce[0].is_field_operations=true;f.workforce[0].provider_mapping_required=false;f.workforce[0].location_id='station-b';
 f.allocations=[{id:'a1',workforce_id:'w1',station_id:'station-a',effective_from:'2026-01-01',effective_to:null,status:'active',payment_method_id:'direct',payment_values:{MONTHLY:3000}}];
 f.components=[{payment_method_id:'direct',component_code:'MONTHLY',component_type:'amount',pay_schedule:'per_month',label:'Driver salary'}];
 const r=rebuildCps(base([day('A','2026-09-01',0)]),f);assert.equal(r.daily[0].station_code,'A');assert.equal(r.daily[0].da_salary,100);assert.equal(r.people[0].station_code,'A');
});
test('station-filtered transfer keeps the off-scope allocation from becoming a false current-station gap',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.workforce[0].is_field_operations=true;f.workforce[0].provider_mapping_required=false;f.workforce[0].location_id='station-a';
 f.allocations=[{id:'a1',workforce_id:'w1',station_id:'station-b',effective_from:'2026-01-01',effective_to:null,status:'active',payment_method_id:'direct',payment_values:{MONTHLY:3000}}];
 f.components=[{payment_method_id:'direct',component_code:'MONTHLY',component_type:'amount',pay_schedule:'per_month',label:'Driver salary'}];
 const r=rebuildCps(base([day('A','2026-09-01',0)]),f);assert.equal(r.daily[0].da,0);assert.ok(!r.gaps.some(g=>g.dropx_id==='D1'));
});
test('a later non-field or provider-required designation does not erase effective-dated direct pay history',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.workforce[0].is_field_operations=false;f.workforce[0].provider_mapping_required=true;
 f.allocations=[{id:'a1',workforce_id:'w1',station_id:'station-a',effective_from:'2026-09-01',effective_to:'2026-09-01',status:'closed',payment_method_id:'direct',payment_values:{DAILY:700}}];
 f.components=[{payment_method_id:'direct',component_code:'DAILY',component_type:'amount',pay_schedule:'per_day',label:'Driver daily pay'}];
 f.attendance=[{workforce_id:'w1',punch_date:'2026-09-01',status:'P',work_minutes:480}];
 const r=rebuildCps(base([day('A','2026-09-01',0)]),f);assert.equal(r.daily[0].da,700);assert.ok(!r.gaps.some(g=>g.kind==='Provider ID not linked'));
});
test('direct allocation snapshots prevent later payment-method edits from rewriting CPS history',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.workforce[0].is_field_operations=true;f.workforce[0].provider_mapping_required=false;
 f.allocations=[{id:'a1',workforce_id:'w1',station_id:'station-a',effective_from:'2026-01-01',effective_to:null,status:'active',payment_method_id:'direct',payment_values:{DAILY:700},payment_components:[{component_code:'DAILY',component_type:'amount',pay_schedule:'per_day',label:'Snapshotted driver pay'}]}];
 f.components=[{payment_method_id:'direct',component_code:'MONTHLY',component_type:'amount',pay_schedule:'per_month',label:'Changed master salary'}];
 f.attendance=[{workforce_id:'w1',punch_date:'2026-09-01',status:'P',work_minutes:480}];
 const r=rebuildCps(base([day('A','2026-09-01',0)]),f);assert.equal(r.daily[0].da,700);assert.equal(r.breakup.find(line=>line.source==='Direct workforce allocation').sub_head,'Salary / Snapshotted driver pay');
});
test('People CTC suppresses the salary bucket from an employee-backed direct allocation',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.workforce[0].is_field_operations=true;f.workforce[0].provider_mapping_required=false;f.workforce[0].source_profile_type='employee';f.workforce[0].source_profile_id='e1';
 f.allocations=[{id:'a1',workforce_id:'w1',station_id:'station-a',effective_from:'2026-01-01',effective_to:null,status:'active',payment_method_id:'direct',payment_values:{SALARY:30000}}];
 f.components=[{payment_method_id:'direct',component_code:'SALARY',component_type:'amount',pay_schedule:'per_month',label:'Driver salary'}];
 f.employees=[{id:'e1',employee_code:'E1',full_name:'Driver',location_id:'station-a',is_active:true,date_of_join:'2026-01-01',designation:'DRIVER'}];f.people_policies.push({designation_code:'DRIVER',mode:'home',head:'UTR',label:'Station staff CTC',allocation:'equal',effective_from:'2026-01-01'});f.salaries=[{employee_id:'e1',effective_from:'2026-01-01',monthly_ctc:33000}];
 const r=rebuildCps(base([day('A','2026-09-01',0)]),f);assert.equal(r.daily[0].da_salary,0);assert.equal(r.daily[0].utr,1100);assert.ok(!r.breakup.some(line=>line.source==='Direct workforce allocation'&&line.head==='DA'));
});
test('employee-backed CTC follows effective Workforce station after a transfer',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.workforce[0].location_id='station-b';f.workforce[0].source_profile_type='employee';f.workforce[0].source_profile_id='e1';
 f.policy_history=[{workforce_id:'w1',station_id:'station-a',station_code_snapshot:'A',designation_is_active:true,effective_from:'2026-09-01',effective_to:null,is_field_operations:true,provider_mapping_required:false}];
 f.allocations=[{id:'a1',workforce_id:'w1',station_id:'station-a',effective_from:'2026-09-01',effective_to:null,status:'active',payment_method_id:'direct',payment_values:{SALARY:30000}}];
 f.components=[{payment_method_id:'direct',component_code:'SALARY',component_type:'amount',pay_schedule:'per_month',label:'Driver salary'}];
 f.employees=[{id:'e1',employee_code:'E1',full_name:'Transferred DA',location_id:'station-b',is_active:true,date_of_join:'2026-01-01',designation:'DA'}];
 f.salaries=[{employee_id:'e1',effective_from:'2026-01-01',monthly_ctc:33000}];
 let r=rebuildCps(base([day('A','2026-09-01',0)]),f);
 assert.equal(r.daily[0].da_salary,1100);
 assert.ok(r.breakup.some(line=>line.source==='People CTC'&&line.station_code==='A'&&line.amount===1100));
 assert.ok(!r.breakup.some(line=>line.source==='Direct workforce allocation'&&line.head==='DA'));
 r=rebuildCps(base([day('B','2026-09-01',0)]),f);
 assert.equal(r.daily[0].da_salary,0,'current station B must not receive the pre-transfer CTC');
});
test('effective payment policy distinguishes optional, required and non-field dates',()=>{
 const policy=(is_field_operations,provider_mapping_required)=>[{workforce_id:'w1',station_id:'station-a',station_code_snapshot:'A',designation_is_active:true,effective_from:'2026-09-01',effective_to:null,is_field_operations,provider_mapping_required}];
 for(const [history,expected] of [[policy(true,false),'Direct payment allocation missing'],[policy(true,true),'Provider ID not linked'],[policy(false,false),null]]) {
  const f=facts();f.shipments=[];f.mappings=[];f.allocations=[];f.policy_history=history;
  const r=rebuildCps(base([day('A','2026-09-01',0)]),f);
  if(expected) assert.ok(r.gaps.some(g=>g.kind===expected)); else assert.ok(!r.gaps.some(g=>g.dropx_id==='D1'));
 }
});
test('dates before the first truthful policy snapshot suppress policy-derived gaps',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.allocations=[];f.workforce[0].is_field_operations=true;f.workforce[0].provider_mapping_required=false;
 f.policy_history=[{workforce_id:'w1',station_id:'station-a',station_code_snapshot:'A',designation_is_active:true,effective_from:'2026-09-02',effective_to:null,is_field_operations:true,provider_mapping_required:false}];
 const r=rebuildCps(base([day('A','2026-09-01',0)]),f);assert.ok(!r.gaps.some(g=>g.dropx_id==='D1'));
});
test('effective station ownership keeps pre-transfer gaps at the historical station',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.allocations=[];f.workforce[0].location_id='station-a';
 f.policy_history=[
  {workforce_id:'w1',station_id:'station-b',station_code_snapshot:'B',designation_is_active:true,effective_from:'2026-09-01',effective_to:'2026-09-01',is_field_operations:true,provider_mapping_required:false},
  {workforce_id:'w1',station_id:'station-a',station_code_snapshot:'A',designation_is_active:true,effective_from:'2026-09-02',effective_to:null,is_field_operations:true,provider_mapping_required:false},
 ];
 let r=rebuildCps(base([day('B','2026-09-01',0),day('A','2026-09-02',0)]),f);
 assert.ok(r.gaps.some(g=>g.kind==='Direct payment allocation missing'&&g.station_code==='B'&&g.first_date==='2026-09-01'));
 assert.ok(r.gaps.some(g=>g.kind==='Direct payment allocation missing'&&g.station_code==='A'&&g.first_date==='2026-09-02'));
 r=rebuildCps(base([day('A','2026-09-01',0)]),f);
 assert.ok(!r.gaps.some(g=>g.dropx_id==='D1'),'an A-only rebuild must not move the pre-transfer B gap to current station A');
});
test('designation deactivation ends payment-policy gaps on its effective date',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.allocations=[];
 f.policy_history=[
  {workforce_id:'w1',station_id:'station-a',station_code_snapshot:'A',designation_is_active:true,effective_from:'2026-09-01',effective_to:'2026-09-01',is_field_operations:true,provider_mapping_required:false},
  {workforce_id:'w1',station_id:'station-a',station_code_snapshot:'A',designation_is_active:false,effective_from:'2026-09-02',effective_to:null,is_field_operations:true,provider_mapping_required:true},
 ];
 const r=rebuildCps(base([day('A','2026-09-01',0),day('A','2026-09-02',0)]),f);
 const workerGaps=r.gaps.filter(g=>g.dropx_id==='D1');
 assert.equal(workerGaps.length,1);
 assert.equal(workerGaps[0].kind,'Direct payment allocation missing');
 assert.equal(workerGaps[0].first_date,'2026-09-01');
 assert.equal(workerGaps[0].last_date,'2026-09-01');
});
test('provider-required gap uses effective policy station rather than current location',()=>{
 const f=facts();f.shipments=[];f.mappings=[];f.allocations=[];f.workforce[0].location_id='station-a';
 f.policy_history=[{workforce_id:'w1',station_id:'station-b',station_code_snapshot:'B',designation_is_active:true,effective_from:'2026-09-01',effective_to:null,is_field_operations:true,provider_mapping_required:true}];
 const r=rebuildCps(base([day('B','2026-09-01',0)]),f);
 assert.ok(r.gaps.some(g=>g.dropx_id==='D1'&&g.kind==='Provider ID not linked'&&g.station_code==='B'));
 assert.ok(!r.gaps.some(g=>g.dropx_id==='D1'&&g.station_code==='A'));
});

test('HR, Finance, Fleet and unknown HO roles never allocate from access scope; People details stay private',()=>{
 const f=facts();f.stations.push({id:'ho',station_code:'HO_MJR',region:'SAME_REGION',is_active:true,is_ho:true});
 f.employees=['HRE','HRM','FINMGR','FLTM','UNCONFIGURED','CLM'].map((designation,i)=>({id:`e${i}`,full_name:`PRIVATE_NAME_${i}`,employee_code:`SECRET_${i}`,designation,location_id:'ho',location_scope_ids:['station-a','station-b'],is_active:true}));
 f.salaries=f.employees.map(e=>({employee_id:e.id,effective_from:'2026-01-01',monthly_ctc:30000}));
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].utr,500);assert.equal(r.staff.length,1);assert.equal(r.staff[0].group,'Manager share');
 const json=JSON.stringify(r);assert.ok(!json.includes('PRIVATE_NAME'));assert.ok(!json.includes('SECRET_'));assert.ok(!json.includes('monthly_ctc'));assert.ok(!json.includes('"employee_id":'));
 f.stations[0].region='SAME_REGION';f.employees.at(-1).location_scope_ids=[];assert.equal(rebuildCps(base(),f).daily[0].utr,0,'HO region/all-company fallback must not exist');
});
test('telecaller role is configurable and shares are independent of report station filter',()=>{
 const f=facts();f.people_policies.push({designation_code:'TC',mode:'managed',head:'UTR',label:'Telecaller share',allocation:'equal',effective_from:'2026-01-01'});
 f.employees=[{id:'tc',full_name:'Hidden telecaller',designation:'TC',is_active:true,location_scope_ids:['station-a','station-b']}];f.salaries=[{employee_id:'tc',effective_from:'2026-01-01',monthly_ctc:12000}];
 assert.equal(rebuildCps(base(),f).daily[0].utr,200);assert.equal(rebuildCps(base([day('A'),day('B')]),f).daily.reduce((n,d)=>n+d.utr,0),400);
});
test('unconfirmed bill periods make CPS provisional without losing the recorded amount',()=>{
 const b=base();b.expense_periods=[{station_code:'A',source_id:'bill',label:'Electricity Bill',confirmed:false,period_from:'2026-09-01',period_to:'2026-09-30'}];
 const r=rebuildCps(b,facts());assert.ok(r.gaps.some(g=>g.kind==='Billing period unconfirmed'));assert.ok(r.daily[0].cost_gaps>0);
});

test('moving a manager cost head never makes their name or individual salary public',()=>{
 const f=facts();f.people_policies=f.people_policies.map(p=>p.designation_code==='CLM'?{...p,head:'DA'}:p);
 f.employees=[{id:'private',employee_code:'PRIVATE1',full_name:'PRIVATE_MANAGER_NAME',designation:'CLM',is_active:true,location_scope_ids:['station-a']}];f.salaries=[{employee_id:'private',effective_from:'2026-01-01',monthly_ctc:30000}];
 const r=rebuildCps(base(),f);assert.ok(!JSON.stringify(r).includes('PRIVATE_MANAGER_NAME'));assert.ok(!r.people.some(p=>p.dropx_id==='PRIVATE1'));
});

test('People assignments use dated mapped stations, deduplicate duties and preserve shares under filters',()=>{
 const f=facts();f.employees=[{id:'manager',employee_code:'PRIVATE1',full_name:'Private manager',designation:'CLM',location_id:'ho',is_active:true,date_of_join:'2020-01-01',location_scope_ids:['station-a']}];
 f.salaries=[{id:'ctc',employee_id:'manager',monthly_ctc:30000,effective_from:'2026-01-01'}];
 f.people_assignments=[{employee_id:'manager',station_code:'A',effective_from:'2026-09-01',effective_to:'2026-09-15'},{employee_id:'manager',station_code:'B',effective_from:'2026-09-01',effective_to:null},{employee_id:'manager',station_code:'B',effective_from:'2026-09-01',effective_to:null}];
 let r=rebuildCps(base([day(),day('B')]),f);near(r.daily[0].utr,500);near(r.daily[1].utr,500);
 r=rebuildCps(base(),f);near(r.daily[0].utr,500);assert.ok(r.staff.every(s=>s.station_code==='A'));assert.ok(!JSON.stringify(r).includes('Private manager'));assert.ok(!JSON.stringify(r).includes('PRIVATE1'));
 r=rebuildCps(base([day('A','2026-09-16'),day('B','2026-09-16')]),f);near(r.daily[0].utr,0);near(r.daily[1].utr,1000);
 f.people_assignments=[];r=rebuildCps(base(),f);near(r.daily[0].utr,0);assert.deepEqual(r.allocation_notices,[]);assert.ok(!r.gaps.some(g=>g.kind==='Overhead allocation missing'));assert.equal(r.daily[0].utr_configured,true);
});


test('DA cohorts use their own delivered count and show returns and effective rates',()=>{
 const f=facts(); f.shipments[0].c_return=5;
 f.components.push({payment_method_id:'per-packet',component_code:'RETURN',label:'Customer return',component_type:'production',calculation_source:'c_return'});
 f.mappings[0].payment_values.RETURN=4;
 f.workforce.push({...f.workforce[0],id:'w2',dropx_id:'D2'});
 f.mappings.push({...f.mappings[0],id:'m2',workforce_id:'w2',provider_member_id:'AM2',payment_method_id:null,pay_type:'MG',delivery_rate:8,guarantee_amount:600});
 f.shipments.push({...f.shipments[0],id:'s2',provider_employee_id:'AM2',total_delivery:50,c_return:0});
 const r=rebuildCps(base([day('A','2026-09-01',150)]),f);
 const v=details.exports.daCohortTotals(r.da_details,'variable'),mg=details.exports.daCohortTotals(r.da_details,'guarantee');
 assert.equal(v.amount,1020);assert.equal(v.cps,10.2);assert.equal(mg.amount,600);assert.equal(mg.cps,12);
 near(v.amount+mg.amount,r.daily[0].da);assert.equal(v.people[0].customer_returns,5);
 assert.deepEqual(v.people[0].periods[0].rates.find(r=>r.label==='Customer return'),{label:'Customer return',rate:4,basis:'c return'});
 assert.equal(mg.people[0].salary,200);assert.equal(mg.people[0].variable,400);
});
test('worked days deduplicate provider IDs and do not count idle calendar salary days',()=>{
 const f=facts();f.mappings[0].payment_values={SALARY:30000};f.components=[{payment_method_id:'per-packet',component_code:'SALARY',component_type:'amount',pay_schedule:'per_month'}];
 f.mappings.push({...f.mappings[0],id:'m2',provider_member_id:'AM2'});f.shipments.push({...f.shipments[0],id:'s2',provider_employee_id:'AM2',total_delivery:50});
 const r=rebuildCps(base([day('A','2026-09-01',150),day('A','2026-09-02',0)]),f),p=r.da_details[0];
 assert.equal(p.work_dates.length,1);assert.equal(p.cost_dates.length,2);assert.equal(p.deliveries,150);assert.equal(p.salary,2000);assert.deepEqual(p.provider_ids,['AM1','AM2']);
});
test('cohort follows dated rate-card changes and never invents zero-delivery CPS',()=>{
 const f=facts();f.shipments.push({...f.shipments[0],id:'s2',work_date:'2026-09-02'});
 f.mappings.push({...f.mappings[0],id:'m2',effective_from:'2026-09-02',payment_values:{SALARY:30000},payment_method_id:'fixed'});
 f.components.push({payment_method_id:'fixed',component_code:'SALARY',component_type:'amount',pay_schedule:'per_month'});
 const r=rebuildCps(base([day(),day('A','2026-09-02'),day('A','2026-09-03',0)]),f);
 assert.equal(r.da_details.length,2);assert.equal(details.exports.daCohortTotals(r.da_details,'variable').deliveries,100);
 const fixed=r.da_details.find(p=>p.cohort==='guarantee');assert.equal(fixed.deliveries,100);assert.equal(fixed.salary,2000);assert.equal(fixed.periods[0].card_from,'2026-09-02');
 assert.equal(details.exports.daCohortTotals([{...fixed,deliveries:0}],'guarantee').cps,null);
});
test('People DA cost replaces card salary and is reconciled in the same cohort',()=>{
 const f=facts();f.workforce[0].source_profile_type='employee';f.workforce[0].source_profile_id='e1';
 f.employees=[{id:'e1',employee_code:'E1',full_name:'DA employee',location_id:'station-a',is_active:true,designation:'DA'}];f.salaries=[{employee_id:'e1',effective_from:'2026-01-01',monthly_ctc:30000}];
 const r=rebuildCps(base(),f);assert.equal(r.da_details.length,1);assert.equal(r.da_details[0].cohort,'guarantee');
 assert.equal(r.da_details[0].salary+r.da_details[0].variable,r.daily[0].da);assert.equal(r.da_details[0].deliveries,100);
});
test('home assignment dates override legacy location; inactive station staff stay excluded and private',()=>{
 const f=facts();f.employees=[{id:'e',employee_code:'SECRET',full_name:'PRIVATE_STAFF',designation:'SSA',location_id:'station-a',is_active:true,has_home_assignments:true}];
 f.salaries=[{employee_id:'e',monthly_ctc:30000,effective_from:'2026-01-01'}];
 f.people_assignments=[{employee_id:'e',station_code:'B',kind:'home',effective_from:'2026-09-01',effective_to:'2026-09-15'}];
 let r=rebuildCps(base([day('A'),day('B')]),f);assert.equal(r.daily[0].utr,0);assert.equal(r.daily[1].utr,1000);
 assert.ok(!JSON.stringify(r).includes('PRIVATE_STAFF'));assert.ok(!JSON.stringify(r).includes('SECRET'));
 r=rebuildCps(base([day('A','2026-09-16'),day('B','2026-09-16')]),f);assert.equal(r.daily.reduce((n,d)=>n+d.utr,0),0);
 f.employees[0].is_active=false;r=rebuildCps(base([day('B')]),f);assert.equal(r.daily[0].utr,0);
});
test('fuel trend preserves source, DA versus Van allocation and zero-delivery days',()=>{
 const b=base([day(),day('A','2026-09-02',0)]);b.breakup=[
  {station_code:'A',work_date:'2026-09-01',head:'Van',sub_head:'IOCL fuel',source:'Fuel import',amount:500},
  {station_code:'A',work_date:'2026-09-01',head:'Van',sub_head:'Van fuel expenses',source:'Cashbook',amount:100},
  {station_code:'A',work_date:'2026-09-01',head:'DA',sub_head:'DA fuel',source:'Workforce rate card',amount:200},
  {station_code:'A',work_date:'2026-09-02',head:'Van',sub_head:'BPCL fuel',source:'Fuel import',amount:400},
  {station_code:'A',work_date:'2026-09-01',head:'Van',sub_head:'Rent',source:'Fleet',amount:1000}];
 const r=details.exports.cpsFuelTrend(b);assert.equal(r[0].amount,800);assert.equal(r[0].cps,8);assert.equal(r[0].sources.length,3);assert.equal(r[1].cps,null);
});

test('shipment activity remains work evidence when the attendance record is absent',()=>{
 const f=facts();f.attendance=[{workforce_id:'w1',punch_date:'2026-09-01',status:'A'}];
 const r=rebuildCps(base(),f);assert.equal(r.da_details[0].work_dates.length,1);assert.deepEqual(r.da_details[0].work_bases,['shipment activity']);
 assert.equal(r.daily[0].da,1000,'displayed work evidence does not change payroll rules');
});

test('active base-location TL, SSA and sorter CTC accrues without attendance and is private',()=>{
 const f=facts();f.shipments=[];f.workforce=[];f.mappings=[];f.attendance=[];
 f.employees=['TL','SSA','SRTR'].map((designation,i)=>({id:`staff-${i}`,full_name:`PRIVATE_${i}`,employee_code:`SECRET_${i}`,location_id:'station-a',designation,is_active:true,date_of_join:'2026-08-01',has_home_assignments:true}));
 f.people_policies=['TL','SSA','SRTR'].map(designation_code=>({designation_code,mode:'home',head:'UTR',label:'Station team',allocation:'equal',effective_from:'2026-09-01'}));
 f.people_assignments=f.employees.map(e=>({employee_id:e.id,station_code:'A',kind:'home',effective_from:'2026-08-01',effective_to:null}));
 f.salaries=f.employees.map(e=>({employee_id:e.id,effective_from:'2026-08-01',monthly_ctc:30000}));
 const r=rebuildCps(base([day('A','2026-09-01',0),day('A','2026-09-02',0)]),f);
 assert.deepEqual(r.daily.map(d=>d.utr),[3000,3000]);assert.equal(r.staff.length,1);assert.equal(r.staff[0].amount,6000);
 assert.ok(!JSON.stringify(r).includes('PRIVATE_'));assert.ok(!JSON.stringify(r).includes('SECRET_'));
});

test('Fleet source rule excludes fixed rental without changing per-package, salary or fuel costs',()=>{
 const f=facts();
 f.mappings[0].payment_values={DELIVERY:10,VAN_RENT_PER_DAY:900,VAN_PACKAGE:2,FUEL:1,SALARY:300};
 f.components.push(
 {payment_method_id:'per-packet',component_code:'VAN_RENT_PER_DAY',label:'Van Rent Per Day',component_type:'amount',calculation_type:'fixed_daily',pay_schedule:'per_day'},
 {payment_method_id:'per-packet',component_code:'VAN_PACKAGE',label:'Van per package',component_type:'production',calculation_type:'count_x_rate',calculation_source:'total_delivery'},
 {payment_method_id:'per-packet',component_code:'FUEL',component_type:'production',calculation_type:'count_x_rate',calculation_source:'total_delivery'},
 {payment_method_id:'per-packet',component_code:'SALARY',component_type:'amount',calculation_type:'fixed_daily',pay_schedule:'per_day'});
 f.component_policies=[{component_code:'VAN_RENT_PER_DAY',mode:'fleet',effective_from:'2026-09-01'}];
 let r=rebuildCps(base(),f);
 assert.equal(r.daily[0].van,200);assert.equal(r.daily[0].da,1400);
 assert.ok(!r.da_details[0].periods[0].rates.some(rate=>rate.label==='Van Rent Per Day'));
 // No rental value is needed in Workforce when Fleet owns that cost.
 delete f.mappings[0].payment_values.VAN_RENT_PER_DAY;
 r=rebuildCps(base(),f);assert.equal(r.associates[0].mapping_status,'Mapped');assert.equal(r.daily[0].van,200);
 // Production cannot accidentally be excluded even by a malformed policy.
 f.component_policies.push({component_code:'VAN_PACKAGE',mode:'fleet',effective_from:'2026-09-01'});
 assert.equal(rebuildCps(base(),f).daily[0].van,200);
});

test('rental source revisions apply by cost date and rental-only direct cards do not create false pay gaps',()=>{
 const f=facts();
 f.component_policies=[{component_code:'VAN_RENT_PER_DAY',mode:'workforce',effective_from:'2026-08-01'},{component_code:'VAN_RENT_PER_DAY',mode:'fleet',effective_from:'2026-09-02'}];
 f.components=[{payment_method_id:'per-packet',component_code:'VAN_RENT_PER_DAY',component_type:'amount',calculation_type:'fixed_daily',pay_schedule:'per_day'}];
 f.mappings[0].payment_values={VAN_RENT_PER_DAY:900};
 assert.equal(rebuildCps(base(),f).daily[0].van,900);
 f.shipments[0].work_date='2026-09-02';
 assert.equal(rebuildCps(base([day('A','2026-09-02')]),f).daily[0].van,0);
 f.mappings=[];f.shipments=[];
 f.allocations=[{workforce_id:'w1',station_id:'station-a',payment_method_id:'per-packet',effective_from:'2026-01-01',payment_values:{},payment_components:f.components}];
 const r=rebuildCps(base([day('A','2026-09-02',0)]),f);
 assert.equal(r.daily[0].van,0);assert.ok(!r.gaps.some(g=>g.kind==='Direct payment allocation incomplete'));
});

test('providerless direct employees retain biometric pay when DAs use shipment attendance',()=>{
 const f=facts();f.mappings=[];f.shipments=[];f.workforce[0].provider_mapping_required=false;
 f.allocations=[{id:'direct',workforce_id:'w1',station_id:'station-a',effective_from:'2026-09-01',payment_values:{DAILY:600},payment_components:[{component_code:'DAILY',component_type:'amount',pay_schedule:'per_day',calculation_source:'attendance_eligibility'}]}];
 f.attendance=[{workforce_id:'w1',punch_date:'2026-09-01',status:'P'}];f.attendance_capture_history=[{capture_method:'shipment_data',minimum_daily_deliveries:1,effective_from:'2026-09-01'}];
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].da,600);
});

test('Dashboard production uploads and dated rate overrides are included once across provider IDs',()=>{
 const f=facts();
 f.shipments.push({...f.shipments[0],id:'s2',provider_employee_id:'AM2'});
 f.mappings.push({...f.mappings[0],id:'m2',provider_member_id:'AM2'});
 f.components[0].payment_field_id='field-delivery';
 f.components.push({payment_method_id:'per-packet',component_code:'KM_RUN',payment_field_id:'field-km',component_type:'production',calculation_type:'count_x_rate',is_custom_production:true,label:'Fuel KM'});
 f.mappings.forEach(m=>m.payment_values={DELIVERY:10,KM_RUN:5});
 f.payout_inputs={productionInputs:[{workforce_id:'w1',station_id:'station-a',payment_field_id:'field-km',work_date:'2026-09-01',units:60}],paymentFieldOverrides:[{workforce_id:'w1',station_id:'station-a',payment_field_id:'field-delivery',effective_from:'2026-09-01',effective_to:'2026-09-30',input_value:12}]};
 const r=rebuildCps(base(),f);near(r.people[0].variable,2400);near(r.people[0].fuel,300);
 assert.equal(r.da_details[0].periods[0].production_details.find(c=>c.label==='Fuel KM').reported_units,60);
});

test('a missing production field retains known fixed pay and flags the incomplete component',()=>{
 const f=facts();f.components.push({payment_method_id:'per-packet',component_code:'UNKNOWN',component_type:'production'});f.mappings[0].payment_values.UNKNOWN=2;
 const r=rebuildCps(base(),f);near(r.daily[0].da,1000);assert.ok(r.gaps.some(g=>/production source/.test(g.kind)));assert.ok(r.da_details[0].pending_fixed_dates.length);
});

test('uploaded attendance range wins over shipment attendance and pays exactly once at range end',()=>{
 const f=facts();f.components=[{payment_method_id:'per-packet',component_code:'DAILY',component_type:'amount',pay_schedule:'per_day',calculation_type:'fixed_daily',calculation_source:'attendance_eligibility'}];f.mappings[0].payment_values={DAILY:700};
 f.shipments.push({...f.shipments[0],id:'s2',work_date:'2026-09-02'});
 f.attendance_capture_history=[{capture_method:'shipment_data',minimum_daily_deliveries:1,effective_from:'2026-09-01'}];
 f.payout_inputs={attendancePeriods:[{workforce_id:'w1',station_id:'station-a',attendance_basis:'days',effective_from:'2026-09-01',effective_to:'2026-09-02',quantity:1.5}]};
 const r=rebuildCps(base([day(),day('A','2026-09-02')]),f);assert.deepEqual(r.daily.map(d=>d.da),[0,1050]);
 const partial=rebuildCps(base(),f);assert.equal(partial.daily[0].da,0);assert.ok(partial.gaps.some(g=>/full-period/.test(g.kind)));
 f.mappings.push({...f.mappings[0],id:'overlap'});
 const conflict=rebuildCps(base([day(),day('A','2026-09-02')]),f);assert.equal(conflict.daily.reduce((s,d)=>s+d.da,0),0);assert.ok(conflict.gaps.some(g=>/setup changes/.test(g.kind)));
});

test('low-delivery flag is configurable and never removes an eligible day pay',()=>{
 const f=facts();f.components=[{payment_method_id:'per-packet',component_code:'DAILY',component_type:'amount',pay_schedule:'per_day',calculation_type:'fixed_daily',calculation_source:'attendance_eligibility'}];f.mappings[0].payment_values={DAILY:700};
 f.shipments[0].total_delivery=10;f.shipments[0].total_activity=10;
 f.attendance_capture_history=[{capture_method:'shipment_data',minimum_daily_deliveries:1,review_below_deliveries:15,effective_from:'2026-09-01'}];
 let r=rebuildCps(base([day('A','2026-09-01',10)]),f);assert.equal(r.daily[0].da,700);assert.ok(r.gaps.some(g=>g.kind==='Low deliveries · below 15'));
 f.attendance_capture_history[0].review_below_deliveries=10;r=rebuildCps(base(),f);assert.equal(r.daily[0].da,700);assert.ok(!r.gaps.some(g=>/Low deliveries/.test(g.kind)));
});


test('Finance retains seller payouts despite the CPS-only exclusion master',()=>{
 const f=facts();f.shipments[0].mfn=10;f.shipments[0].mfn_return=5;f.components.push(...['SELLER_PICKUP','SLLLER_RETURN'].map(component_code=>({...f.components[0],component_code})));f.mappings[0].payment_values={DELIVERY:10,SELLER_PICKUP:4,SLLLER_RETURN:5};f.component_policies=['SELLER_PICKUP','SLLLER_RETURN'].map(component_code=>({component_code,mode:'pnl_only',effective_from:'2026-09-01'}));
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].da,1065);assert.equal(r.da_details[0].seller_pickups,10);assert.equal(r.da_details[0].seller_returns,5);
});


test('shipment fallback preserves actual attendance on days with no delivery and keeps hourly minutes',()=>{
 const f=facts();f.shipments[0].total_delivery=0;f.shipments[0].total_activity=0;
 f.attendance=[{workforce_id:'w1',punch_date:'2026-09-01',status:'P',work_minutes:480}];
 f.attendance_capture_history=[{capture_method:'shipment_data',minimum_daily_deliveries:1,effective_from:'2026-09-01'}];
 f.mappings[0].payment_values={HOUR:100};f.components=[{payment_method_id:'per-packet',component_code:'HOUR',component_type:'fixed',pay_schedule:'per_hour',calculation_type:'fixed',calculation_source:'attendance_eligibility'}];
 const r=rebuildCps(base([day('A','2026-09-01',0)]),f);assert.equal(r.daily[0].da,800);
});

test('missing configured kilometre input is visible while known pay remains counted',()=>{
 const f=facts();f.mappings[0].payment_values.KM_RUN=4;
 f.components.push({payment_method_id:'per-packet',payment_field_id:'km',component_code:'KM_RUN',label:'Kilometres',component_type:'production',calculation_type:'count_x_rate',is_custom_production:true});
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].da,1000);assert.ok(r.gaps.some(g=>g.kind==='Kilometres input missing'));

});

test('Finance adds historical kilometres at current rate and retains actual zero',()=>{
 const f=facts();const date=f.shipments[0].work_date;const prev=new Date(date+'T00:00:00Z');prev.setUTCMonth(prev.getUTCMonth()-1);const from=prev.toISOString().slice(0,7)+'-01';
 f.components.push({payment_method_id:'per-packet',payment_field_id:'km',component_code:'KM_RUN',label:'Fuel per kilometre',component_type:'production',calculation_type:'count_x_rate',is_custom_production:true});
 f.mappings[0].payment_values.KM_RUN=3;
 f.production_fallback_policies=[{field_code:'KM_RUN',mode:'associate_then_station',lookback_months:3,minimum_history_days:1,effective_from:from}];
 f.production_history=[{id:'h',workforce_id:'w1',station_id:'s1',payment_field_id:'km',field_code_snapshot:'KM_RUN',units:1200,period_from:from,period_to:from.slice(0,7)+'-28',work_days:20}];
 // Fixture identities are intentionally resolved from source data.
 f.production_history[0].workforce_id=f.workforce[0].id;f.production_history[0].station_id=f.stations[0].id;
 const r=rebuildCps(base(),f);assert.equal(r.associates[0].fuel_pay,180);assert.equal(r.da_details[0].fuel,180);
 f.payout_inputs={productionInputs:[{workforce_id:f.workforce[0].id,station_id:f.stations[0].id,payment_field_id:'km',field_code_snapshot:'KM_RUN',work_date:date,units:0}]};
 assert.equal(rebuildCps(base(),f).associates[0].fuel_pay,0);
});


test('Finance fuel fallback covers punched workdays without shipment rows and respects zero or absence',()=>{
 const f=facts();f.shipments=[];
 f.mappings[0].payment_values={SALARY:15000,KM_RUN:3};
 f.components=[
  {payment_method_id:'per-packet',component_code:'SALARY',component_type:'fixed',pay_schedule:'per_month',calculation_type:'fixed',calculation_source:'attendance_eligibility'},
  {payment_method_id:'per-packet',payment_field_id:'km',component_code:'KM_RUN',label:'Fuel per kilometre',component_type:'production',calculation_type:'count_x_rate',is_custom_production:true}
 ];
 f.attendance=[{workforce_id:'w1',punch_date:'2026-09-01',status:'P'}];
 f.production_fallback_policies=[{field_code:'KM_RUN',mode:'associate_station_company',lookback_months:3,minimum_history_days:1,effective_from:'2026-09-01'}];
 f.production_history=[{id:'h',workforce_id:'other',station_id:'other-station',payment_field_id:'km',field_code_snapshot:'KM_RUN',units:1200,period_from:'2026-08-01',period_to:'2026-08-31',work_days:20}];
 f.production_threshold_context={shipments:[],mappings:f.mappings,workforce:f.workforce,components:f.components,providers:f.providers,stations:f.stations};
 let evidence;const b=base([day('A','2026-09-01',0)]),r=rebuildCps(b,f,e=>{evidence=e;});
 assert.equal(r.daily[0].da,680);assert.equal(r.da_details[0].fuel,180);
 assert.equal(evidence.associates[0].input_estimates[0].basis,'company average');
 assert.ok(!r.gaps.some(g=>g.kind==='Fuel per kilometre input missing'));
 f.payout_inputs={productionInputs:[{workforce_id:'w1',station_id:'station-a',payment_field_id:'km',field_code_snapshot:'KM_RUN',work_date:'2026-09-01',units:0}]};
 assert.equal(rebuildCps(b,f).da_details[0].fuel,0);
 f.payout_inputs={};f.attendance[0].status='A';
 const absent=rebuildCps(b,f);assert.equal(absent.daily[0].da,0);assert.ok(absent.da_details.every(d=>d.fuel===0));
});
