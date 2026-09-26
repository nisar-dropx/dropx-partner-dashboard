import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const company='00000000-0000-0000-0000-000000000001', station='00000000-0000-0000-0000-000000000002', worker='00000000-0000-0000-0000-000000000003', head='00000000-0000-0000-0000-000000000004', shipment='00000000-0000-0000-0000-000000000005', actor='00000000-0000-0000-0000-000000000006', provider='00000000-0000-0000-0000-000000000007', run='00000000-0000-0000-0000-000000000008';
await db.exec(`
create role anon; create role authenticated;
create table workforce(id uuid primary key,company_id uuid,location_id uuid,full_name text,dropx_id text,is_active boolean default true,source_profile_id uuid,deleted_at timestamptz,migration_state text default 'native');
create table stations(id uuid primary key,company_id uuid,station_code text);
create table payment_heads(id uuid primary key,company_id uuid,code text);
create table providers(id uuid primary key,company_id uuid,code text,name text);
create table cps_shipment_daily(id uuid primary key,company_id uuid,station_code text,work_date date,provider_employee_id text,provider_employee_name text,client text);
create table field_executive_provider_mappings(company_id uuid,station_id uuid,provider_id uuid,provider_member_id text,workforce_id uuid,field_executive_id uuid,contractor_id uuid,employee_id uuid,effective_from date,effective_to date,status text);
create table workforce_adjustments(id uuid primary key default gen_random_uuid(),company_id uuid,workforce_id uuid,adjustment_type text,category text,amount numeric,effective_date date,reason text,external_reference text,status text,requested_by uuid,reviewed_by uuid,reviewed_at timestamptz,review_remarks text,payroll_run_id uuid,
check(amount>0),check(category in ('cash_recovery','other')),check(status in ('pending','approved','posted','cancelled')),check(status<>'posted' or payroll_run_id is not null),check(reviewed_by is null or requested_by is null or reviewed_by<>requested_by),check(status not in ('approved','posted') or (reviewed_by is not null and reviewed_at is not null)));
create table payment_requests(id uuid primary key default gen_random_uuid(),company_id uuid,location_id uuid,payment_head_id uuid,source_system text,work_date date,requested_for_name text,request_no text,status text default 'pending',amount numeric,amount_requested numeric,amount_approved numeric,updated_by uuid,current_approver_user_id uuid);
create table workforce_payroll_runs(id uuid primary key,company_id uuid,status text,period_start date,period_end date);
create table workforce_payroll_items(id uuid primary key default gen_random_uuid(),company_id uuid,payroll_run_id uuid,workforce_id uuid,status text);
insert into workforce(id,company_id,location_id,full_name,dropx_id) values('${worker}','${company}','${station}','DA One','D001');
insert into stations values('${station}','${company}','ERSE');
insert into payment_heads values('${head}','${company}','ADHOC_DA');
insert into providers values('${provider}','${company}','AMAZON','Amazon');
insert into cps_shipment_daily values('${shipment}','${company}','ERSE','2026-09-10','A001','DA One','Amazon');
insert into field_executive_provider_mappings(company_id,station_id,provider_id,provider_member_id,workforce_id,effective_from,status) values('${company}','${station}','${provider}','A001','${worker}','2026-09-01','active');
`);
await db.exec(readFileSync(new URL('../supabase/migrations/20260923143000_adhoc_da_payment_tracking.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('../supabase/migrations/20260923144000_adhoc_da_bank_amount_alignment.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('../supabase/migrations/20260926133000_adhoc_da_latest_roster_manual_scc.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('../supabase/migrations/20260926193000_adhoc_da_current_mapping.sql',import.meta.url),'utf8'));
const insert=async(overrides={})=>{
 const row={company_id:company,location_id:station,payment_head_id:head,source_system:'OPS_ADHOC_DA',adhoc_shipment_id:shipment,adhoc_work_date:'2026-09-10',request_no:'R1',amount:100,amount_requested:100,amount_approved:90,updated_by:actor,...overrides};
 const keys=Object.keys(row); return (await db.query(`insert into payment_requests(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning *`,Object.values(row))).rows[0];
};
const count=async()=>Number((await db.query('select count(*) from workforce_adjustments')).rows[0].count);
// A current Provider Mapping may start after the payroll deduction work date.
// The roster identity must still resolve because the report date and recovery
// date are intentionally independent.
await db.exec(`update field_executive_provider_mappings set effective_from=current_date`);
const independentDate=await insert({request_no:'DATE1',adhoc_work_date:'2026-09-11'});
assert.equal(independentDate.work_date.toISOString().slice(0,10),'2026-09-11','Roster source date must not replace the selected work date');
await assert.rejects(()=>insert({location_id:actor}),/valid station/);
await assert.rejects(()=>insert({company_id:actor}),/DA selection/);
await db.exec(`update field_executive_provider_mappings set status='cancelled'`);
await assert.rejects(()=>insert(),/Workforce mapping/);
await db.exec(`update field_executive_provider_mappings set status='active'`);
await db.exec(`update cps_shipment_daily set provider_employee_id='1.234E+15'`);
await assert.rejects(()=>insert(),/scientific notation/);
await db.exec(`update cps_shipment_daily set provider_employee_id='A001'`);
const unpaid=await insert();
assert.equal(unpaid.adhoc_workforce_id,worker); assert.equal(unpaid.adhoc_provider_employee_id,'A001');
const manual=await insert({request_no:'MANUAL1',adhoc_shipment_id:null,adhoc_work_date:'2026-09-12',adhoc_da_name:'SCC NAME EXACT',adhoc_workforce_id:worker});
assert.equal(manual.adhoc_workforce_id,worker); assert.equal(manual.adhoc_da_name,'SCC NAME EXACT');
assert.match(manual.adhoc_provider_employee_id,/^(A001|MANUAL:)/);
assert.equal(await count(),0);
await db.query("update payment_requests set status='rejected' where id=$1",[unpaid.id]);
assert.equal(await count(),0);
await db.query("update payment_requests set status='pending' where id=$1",[unpaid.id]);
await db.query("update payment_requests set status='processed' where id=$1",[unpaid.id]);
assert.equal(await count(),1);
const adjustment=(await db.query('select * from workforce_adjustments')).rows[0];
assert.equal(Number(adjustment.amount),100,'Recovery must match bank export, not the legacy approved amount'); assert.equal(adjustment.adjustment_type,'deduction'); assert.equal(adjustment.status,'approved');
await db.query("update payment_requests set status='processed' where id=$1",[unpaid.id]);
assert.equal(await count(),1,'Retry must not double recover');
await assert.rejects(()=>db.query('update payment_requests set amount=200 where id=$1',[unpaid.id]),/cannot be changed/);
await assert.rejects(()=>db.query("update payment_requests set adhoc_provider_employee_id='WRONG' where id=$1",[unpaid.id]),/identity is frozen/);
await assert.rejects(()=>db.query('delete from payment_requests where id=$1',[unpaid.id]),/must be cancelled/);
await assert.rejects(()=>db.query("update workforce_adjustments set amount=1 where id=$1",[adjustment.id]),/immutable/);
await assert.rejects(()=>db.query('delete from workforce_adjustments where id=$1',[adjustment.id]),/cannot be deleted/);
await db.exec(`insert into workforce_payroll_runs values('${run}','${company}','draft','2026-09-01','2026-09-30');insert into workforce_payroll_items(company_id,payroll_run_id,workforce_id,status) values('${company}','${run}','${worker}','ready');`);
await assert.rejects(()=>db.query("update workforce_payroll_runs set status='review' where id=$1",[run]),/missing from this payroll/);
await db.query("update workforce_adjustments set status='posted',payroll_run_id=$1 where id=$2",[run,adjustment.id]);
await db.query("update workforce_payroll_runs set status='review' where id=$1",[run]);
await db.query("update workforce_payroll_runs set status='approved' where id=$1",[run]);
const late=await insert({request_no:'R2',status:'processed'});
const carried=(await db.query('select effective_date from workforce_adjustments where id=$1',[late.adhoc_adjustment_id])).rows[0];
assert.equal(carried.effective_date.toISOString().slice(0,10),'2026-10-01','Late payment must move to next open period');
// Ordinary adjustments with NULL references remain unaffected.
await db.exec(`insert into workforce_adjustments(company_id,workforce_id,amount,status,category) values('${company}','${worker}',1,'pending','other'); update workforce_adjustments set amount=2 where external_reference is null; delete from workforce_adjustments where external_reference is null;`);
assert.equal(await count(),2);
// The live head requires expense approval. Identity is added only when an
// already-approved request reaches Submit payment details, not at expense intake.
const legacy=await insert({request_no:'EXP1',source_system:null,adhoc_shipment_id:null,adhoc_work_date:null,status:'approved'});
assert.equal(legacy.adhoc_workforce_id,null);
await db.query("update payment_requests set source_system='OPS_ADHOC_DA',adhoc_shipment_id=$1,adhoc_work_date='2026-09-10' where id=$2",[shipment,legacy.id]);
assert.equal((await db.query('select adhoc_workforce_id from payment_requests where id=$1',[legacy.id])).rows[0].adhoc_workforce_id,worker);
assert.equal(await count(),2,'Adding payment details is not proof of payment');
await db.query("update payment_requests set status='processed' where id=$1",[legacy.id]);
assert.equal(await count(),3);
await db.close();
console.log('PASS Adhoc DA SQL: latest-roster identity with independent work date, guarded manual SCC fallback, station/company validation, exact mapping, unpaid exclusion, one-time paid recovery, immutable audit, payroll gate, late carry-forward and unrelated adjustments.');
