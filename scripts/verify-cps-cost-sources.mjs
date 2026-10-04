import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const company='11111111-1111-1111-1111-111111111111', other='22222222-2222-2222-2222-222222222222';
const vehicle='33333333-3333-3333-3333-333333333333', station='44444444-4444-4444-4444-444444444444', stationB='55555555-5555-5555-5555-555555555555';
await db.exec(`
create role anon; create role authenticated; create role service_role;
create table companies(id uuid primary key,name text);
create table stations(id uuid primary key,company_id uuid,station_code text,is_active boolean default true,hide_from_location_list boolean default false);
create table fleet_vehicles(id uuid primary key,company_id uuid,vehicle_no text,station_code text,model text,fuel_type text,ownership_type text,deployment_status text,status text,created_at timestamptz);
create table fleet_vehicle_status_master(company_id uuid,status_key text,is_terminal boolean);
insert into companies values('${company}','DROPX LOGISTICS'),('${other}','Other company');
insert into stations(id,company_id,station_code) values('${station}','${company}','A'),('${stationB}','${company}','B');
insert into fleet_vehicles values('${vehicle}','${company}','KL01AA0001','A','Mahindra Jeeto','Diesel','own','deployed','active','2026-06-01');
insert into fleet_vehicles values(gen_random_uuid(),'${company}','KL02AA0002','B','Piaggio Ape','Diesel','own','deployed','breakdown','2026-06-01');
insert into fleet_vehicles values(gen_random_uuid(),'${company}','KL03AA0003','A','OSM Range','EV','own','not_deployed','active','2026-06-01');
insert into fleet_vehicles values(gen_random_uuid(),'${company}','KL04AA0004','A','Tata Ace','Diesel','own','deployed','active','2026-06-01');
create table cps_shipment_daily(company_id uuid,station_code text,work_date date,total_delivery numeric,total_activity numeric,amazon_delivery numeric,swa_delivery numeric,c_return numeric,mfn numeric,mfn_return numeric,mapping_status text,da_total_pay numeric,updated_at timestamptz);
create table finance_rent_master(company_id uuid,allocation_station_code text,monthly_rent numeric,monthly_maintenance numeric,effective_from date,effective_to date,deleted_at timestamptz);
create table payment_heads(id uuid,company_id uuid,code text,name text);
create table payment_requests(company_id uuid,work_date date,request_no text,utr text,utr_cin text,payment_reference text,payment_head_id uuid,location_id uuid,station_code text,location_code text,category text,amount_approved numeric,amount numeric,amount_requested numeric,status text,approval_status text,current_approver_user_id uuid,current_approver_role_id uuid,current_approver_role_ids uuid[]);
create table ops_cps_cost_inputs(id uuid,company_id uuid,employee_id uuid,station_codes text[],is_active boolean,effective_from date,effective_to date,head text,sub_head text,label text,frequency text,amount numeric,allocation text);
create table cps_fuel_daily(company_id uuid,station_code text,transaction_date date,provider text,amount numeric);
create table cps_cashbook_daily(company_id uuid,station_code text,expense_date date,category text,cps_head text,cps_sub_head text,remarks text,raw_payload jsonb,amount numeric);
create table cps_station_targets(company_id uuid,station_code text,is_active boolean,effective_from date,target_cps numeric);
`);
for(const file of ['20261004160924_cps_vehicle_rent_master.sql','20261004160954_cps_operating_cost_sources.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
const query = async(sql,params=[]) => (await db.query(sql,params)).rows;
const costs = async(fn,codes=['A','B'],from='2026-09-01',to='2026-09-30') => (await query(`select public.${fn}($1,$2,$3,$4) result`,[company,from,to,codes]))[0].result;
let result=await costs('ops_cps_vehicle_costs');
assert.equal(result.breakup.reduce((s,r)=>s+r.amount,0),27000);
assert.equal(result.vehicles.find(v=>v.vehicle_no==='KL01AA0001').amount,15000);
assert.equal(result.vehicles.find(v=>v.vehicle_no==='KL02AA0002').amount,12000,'deployed downtime still incurs committed rent');
assert.equal(result.vehicles.some(v=>v.vehicle_no==='KL03AA0003'),false);
assert.equal(result.gaps.length,1); assert.equal(result.gaps[0].provider_id,'KL04AA0004');
await query('select fleet_save_vehicle_rent($1,$2,$3,$4,$5,$6)',[company,vehicle,18000,'2026-09-16','Revised agreement',null]);
result=await costs('ops_cps_vehicle_costs',['A']);
assert.equal(result.breakup.reduce((s,r)=>s+r.amount,0),16500);
assert.equal((await query('select count(*) n from fleet_vehicle_rent_changes'))[0].n,1);
await assert.rejects(query('select fleet_save_vehicle_rent($1,$2,$3,$4,$5,$6)',[other,vehicle,1,'2026-09-01','Wrong company',null]),/Vehicle not found/);
await assert.rejects(query('select fleet_save_vehicle_rent($1,$2,$3,$4,$5,$6)',[company,vehicle,1.234,'2026-09-01','Invalid precision',null]),/valid monthly rent/);
await db.exec(`update fleet_vehicle_cost_placements set effective_to='2026-09-15' where vehicle_id='${vehicle}'; insert into fleet_vehicle_cost_placements(company_id,vehicle_id,station_code,ownership_type,deployed,effective_from) values('${company}','${vehicle}','B','own',true,'2026-09-16');`);
assert.equal((await costs('ops_cps_vehicle_costs',['A'])).breakup.reduce((s,r)=>s+r.amount,0),7500);
assert.equal((await costs('ops_cps_vehicle_costs',['B'])).breakup.reduce((s,r)=>s+r.amount,0),21000);
await db.exec(`update fleet_vehicles set station_code='B' where id='${vehicle}'`);
assert.equal((await costs('ops_cps_vehicle_costs',['A'])).breakup.reduce((s,r)=>s+r.amount,0),7500,'future transfer does not rewrite September');
assert.equal((await query("select count(*) n from pg_tables where schemaname='public' and tablename like 'fleet_vehicle_%' and rowsecurity"))[0].n,3);
assert.equal((await query("select has_function_privilege('authenticated','fleet_save_vehicle_rent(uuid,uuid,numeric,date,text,uuid)','execute') allowed"))[0].allowed,false);
await db.exec(`
insert into payment_heads values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','${company}','ELECTRICITY','Electricity'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','${company}','ADHOC_DRIVER','Adhoc Driver'),('cccccccc-cccc-cccc-cccc-cccccccccccc','${company}','STATION_RENT','Station Rent');
insert into payment_requests(company_id,work_date,request_no,utr,payment_head_id,location_id,amount,approval_status,status) values
('${company}','2026-09-05','REQ1','BANK1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','${station}',1000,'FINAL_APPROVED','PENDING'),
('${company}','2026-09-05','REQ2','BANK2','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','${station}',700,'FINAL_APPROVED','PENDING'),
('${company}','2026-08-31','PREVMONTH','BANK3','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','${station}',300,'FINAL_APPROVED','PENDING'),
('${company}','2026-09-05','PENDING','BANK4','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','${station}',9999,'INITIAL_APPROVED','PENDING'),
('${company}','2026-09-05','RENT','BANK5','cccccccc-cccc-cccc-cccc-cccccccccccc','${station}',9000,'FINAL_APPROVED','PENDING');
insert into finance_rent_master values('${company}','A',9000,0,'2026-01-01',null,null);
insert into cps_cashbook_daily values
('${company}','A','2026-09-06','Electricity','Other CPS',null,'','{"UPI Ref No":"BANK1"}',1000),
('${company}','B','2026-09-06','Electricity','Other CPS',null,'','{"UPI Ref No":"BANK2"}',700),
('${company}','B','2026-09-06','Electricity','Other CPS',null,'','{"UPI Ref No":"BANK3"}',300),
('${company}','A','2026-09-06','Electricity','Other CPS',null,'unrelated same amount','{}',1000),
('${company}','A','2026-09-06','Generator Fuel','VAN CPS',null,'','{}',500),
('${company}','A','2026-09-06','Station Rent','Other CPS',null,'','{}',9000);
insert into cps_fuel_daily values('${company}','A','2026-09-05','IOCL',200),('${company}','A','2026-09-05','BPCL',300);
`);
result=await costs('ops_cps_base_v2');
const sum=source=>result.breakup.filter(r=>r.source===source).reduce((s,r)=>s+r.amount,0);
assert.equal(sum('Approved payment requests'),1700,'all approved expense heads, no initial approval or rent duplicate');
assert.equal(sum('Cashbook'),1500,'dedupe stable refs across station and date; preserve unrelated same amount');
assert.equal(sum('Fuel import'),500);assert.equal(sum('Finance Rent Master'),9000);
assert.equal(result.breakup.find(r=>r.sub_head==='Adhoc Driver').head,'Van');
assert.equal(result.breakup.find(r=>r.sub_head==='Generator Fuel').head,'Other');
assert.equal((await costs('ops_cps_base_v2',['B'])).breakup.length,0,'scope cannot resurrect paid requests from cashbook');
assert.equal(result.daily.reduce((s,r)=>s+r.total,0),12700);
assert.equal(result.source_dates.cashbook,'2026-09-06');

await db.exec(`create table designations(company_id uuid,code text,name text);
insert into designations values('${company}','HRM','HR Head'),('${company}','CLM','Cluster Manager');
alter table payment_requests add column id uuid default gen_random_uuid();
alter table cps_cashbook_daily add column id uuid default gen_random_uuid();`);
await db.exec(readFileSync(new URL('../supabase/migrations/20261004171601_cps_allocation_privacy_and_period_costs.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('../supabase/migrations/20261004182514_cps_expense_lookup_performance.sql',import.meta.url),'utf8'));
assert.equal((await query("select mode from ops_cps_people_policies where designation_code='HRM'"))[0].mode,'excluded');
assert.equal((await query("select allocation from ops_cps_people_policies where designation_code='CLM'"))[0].allocation,'equal');
await db.exec(`insert into ops_cps_expense_policies(company_id,cost_label,mode,effective_from) values('${company}','electricity','monthly','2026-09-01');`);
result=await costs('ops_cps_base_v2');
assert.ok(Math.abs(result.breakup.reduce((s,r)=>s+r.amount,0)-12700)<0.001,'recognition changes timing, not full-month total');
let bills=(await query('select ops_cps_period_expenses($1,$2,$3,$4) result',[company,'2026-09-01','2026-09-01',['A']]))[0].result;
assert.equal(bills.length,2,'bill source deduplication survives monthly accrual');
assert.ok(bills.every(b=>!b.confirmed&&b.period_from==='2026-09-01'&&b.period_to==='2026-09-30'));
const dailyBill=(await costs('ops_cps_base_v2',['A'],'2026-09-01','2026-09-01')).breakup.filter(r=>r.sub_head==='Electricity').reduce((s,r)=>s+r.amount,0);
assert.equal(dailyBill,66.66,'monthly bills accrue before payment date and divide by September calendar days');
const bill=bills.find(b=>b.source==='payment');
await query("insert into ops_cps_expense_periods(company_id,source,source_id,period_from,period_to,reason) values($1,'payment',$2,'2026-08-16','2026-09-15','Verified bill')",[company,bill.source_id]);
result=await costs('ops_cps_base_v2',['A']);
assert.ok(Math.abs(result.breakup.filter(r=>r.source==='Approved payment requests'&&r.sub_head==='Electricity').reduce((s,r)=>s+r.amount,0)-483.87)<0.001,'cross-month service period conserves its total and allocates covered days');
assert.equal((await costs('ops_cps_base_v2',['B'])).breakup.length,0,'selected station cannot regain a duplicate');
const august=await costs('ops_cps_base_v2',['A'],'2026-08-01','2026-08-31');
assert.ok(Math.abs(august.breakup.filter(r=>r.source==='Approved payment requests'&&r.sub_head==='Electricity').reduce((s,r)=>s+r.amount,0)-816.13)<0.001,'a later-booked bill remains visible through an overlapping service-date override');
assert.equal(result.expense_periods.length,2,'base RPC returns the same bill evidence used in cost calculation');
assert.equal((await query("select has_function_privilege('authenticated','ops_cps_base_v2(uuid,date,date,text[])','execute') allowed"))[0].allowed,false);

assert.equal((await query("select count(*) n from ops_cps_configuration_changes"))[0].n,2,'settings and bill changes are audited');
await assert.rejects(query("insert into ops_cps_expense_periods(company_id,source,source_id,period_from,period_to,reason) values($1,'cashbook',$2,'2026-09-02','2026-09-01','Invalid')",[company,bill.source_id]),/check constraint/);
assert.equal((await query("select has_table_privilege('authenticated','ops_cps_people_policies','select') allowed"))[0].allowed,false);

await db.exec(`alter table fleet_vehicles add column color text;alter table fleet_vehicles add column rc_location text;
create table document_types(id uuid default gen_random_uuid(),company_id uuid,code text,name text,description text,requires_expiry boolean,document_module text,is_active boolean,sort_order integer);`);
await db.exec(readFileSync(new URL('../supabase/migrations/20261004171605_fleet_vehicle_identity_master.sql',import.meta.url),'utf8'));
await query("update fleet_vehicles set chassis_number='TEST-CHASSIS',purchase_value=400000,invoice_number='INV-TEST',master_updated_by=$1 where id=$2",[station,vehicle]);
assert.equal((await query('select count(*) n from fleet_vehicle_master_changes'))[0].n,1);
assert.equal((await query("select before_values->>'chassis_number' old,after_values->>'chassis_number' new from fleet_vehicle_master_changes"))[0].new,'TEST-CHASSIS');
await assert.rejects(query('update fleet_vehicles set purchase_value=-1 where id=$1',[vehicle]),/check constraint/);
assert.equal((await query("select count(*) n from document_types where code='VEHICLE_INVOICE' and not requires_expiry"))[0].n,2);
assert.equal((await query("select has_table_privilege('authenticated','fleet_vehicle_master_changes','select') allowed"))[0].allowed,false);
await db.close();
console.log('CPS sources verified: rates, revisions, transfers, permissions, missing rates, approval milestones, rent and cashbook dedupe, scoped totals.');
