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
const mod={exports:{}};
new Function('exports','module','require',ts.transpileModule(readFileSync(new URL('./cps-engine.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod.exports,mod,(id)=>{if(id==='../direct-workforce-pay')return direct.exports;if(id==='../workforce-payment-policy')return policy.exports;if(id==='../workforce-attendance-capture')return attendanceCapture.exports;throw new Error(`Unexpected import ${id}`);});
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
 const r=rebuildCps(base(),f);assert.equal(r.daily[0].utr,1250);assert.equal(r.daily[0].overhead,0);assert.equal(r.staff.reduce((s,p)=>s+p.amount,0),1250);assert.equal(r.daily[0].utr_configured,true);
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
 f.employees=[{id:'e1',employee_code:'E1',full_name:'Driver',location_id:'station-a',is_active:true,date_of_join:'2026-01-01',designation:'DRIVER'}];f.salaries=[{employee_id:'e1',effective_from:'2026-01-01',monthly_ctc:33000}];
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
