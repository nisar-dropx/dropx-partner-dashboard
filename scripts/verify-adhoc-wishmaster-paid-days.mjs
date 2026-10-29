import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const company='00000000-0000-0000-0000-000000000001', station='00000000-0000-0000-0000-000000000002', worker='00000000-0000-0000-0000-000000000003', head='00000000-0000-0000-0000-000000000004', shipment='00000000-0000-0000-0000-000000000005', actor='00000000-0000-0000-0000-000000000006', provider='00000000-0000-0000-0000-000000000007', run='00000000-0000-0000-0000-000000000008';
await db.exec(`
create role anon; create role authenticated; create role service_role;
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
await db.exec(readFileSync(new URL('../supabase/migrations/20260928183000_adhoc_da_reference_only.sql',import.meta.url),'utf8'));
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
const unmapped=await insert({request_no:'UNMAPPED'});
assert.equal(unmapped.adhoc_workforce_id,null);
assert.equal(unmapped.adhoc_da_name,'DA One');
await db.exec(`update field_executive_provider_mappings set status='active'`);
await db.exec(`update cps_shipment_daily set provider_employee_id='1.234E+15'`);
const scientific=await insert({request_no:'SCI'});
assert.equal(scientific.adhoc_workforce_id,null,'Bad provider format must not guess payroll identity or block reference capture');
await db.exec(`update cps_shipment_daily set provider_employee_id='A001'`);
const unpaid=await insert();
assert.equal(unpaid.adhoc_workforce_id,worker); assert.equal(unpaid.adhoc_provider_employee_id,'A001');
const manual=await insert({request_no:'MANUAL1',adhoc_shipment_id:null,adhoc_work_date:'2026-09-12',adhoc_da_name:'SCC NAME EXACT',adhoc_workforce_id:worker});
assert.equal(manual.adhoc_workforce_id,null,'Ignore client-supplied Workforce ID'); assert.equal(manual.adhoc_da_name,'SCC NAME EXACT');
assert.equal(manual.adhoc_provider_employee_id,null);
const manualOnly=await insert({request_no:'NAMEONLY',adhoc_shipment_id:null,adhoc_work_date:null,adhoc_da_name:'NOT IN ROSTER'});
assert.equal(manualOnly.adhoc_workforce_id,null);
assert.ok(manualOnly.adhoc_work_date,'Backend supplies recovery date; no UI date needed');
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
await db.exec("update field_executive_provider_mappings set status='cancelled'");
const deferred=await insert({request_no:'DEFERRED',status:'processed'});
assert.equal(deferred.adhoc_adjustment_id,null);
assert.equal(deferred.adhoc_workforce_id,null);
await db.query("update payment_requests set status='processed' where id=$1",[manualOnly.id]);
await assert.rejects(()=>db.query("update payment_requests set adhoc_da_name='OTHER' where id=$1",[deferred.id]),/identity is frozen/);
await assert.rejects(()=>db.query("update payment_requests set amount=999 where id=$1",[deferred.id]),/cannot be changed/);
await db.exec("select reconcile_adhoc_da_recoveries()");
assert.equal(await count(),3);
await db.exec("update field_executive_provider_mappings set status='active'; select reconcile_adhoc_da_recoveries(); select reconcile_adhoc_da_recoveries();");
assert.equal(await count(),4,'Late identity resolution recovers once only');
assert.equal((await db.query('select adhoc_workforce_id from payment_requests where id=$1',[deferred.id])).rows[0].adhoc_workforce_id,worker);
assert.equal((await db.query('select adhoc_adjustment_id from payment_requests where id=$1',[manualOnly.id])).rows[0].adhoc_adjustment_id,null);
await db.exec(`insert into workforce(id,company_id,location_id,full_name) values('${actor}','${company}','${station}','DA Two');
insert into field_executive_provider_mappings(company_id,station_id,provider_id,provider_member_id,workforce_id,effective_from,status) values('${company}','${station}','${provider}','A001','${actor}',current_date,'active');`);
const ambiguous=await insert({request_no:'AMBIGUOUS',status:'processed'});
assert.equal(ambiguous.adhoc_workforce_id,null);
assert.equal(await count(),4);
const expenseUnmapped=await insert({request_no:'EXP2',source_system:null,adhoc_shipment_id:null,adhoc_work_date:null,status:'approved'});
await db.query("update payment_requests set source_system='OPS_ADHOC_DA',adhoc_shipment_id=$1 where id=$2",[shipment,expenseUnmapped.id]);
assert.equal((await db.query('select adhoc_da_name from payment_requests where id=$1',[expenseUnmapped.id])).rows[0].adhoc_da_name,'DA One');
await db.exec('set role authenticated');
await assert.rejects(()=>db.query('select reconcile_adhoc_da_recoveries()'),/permission denied/);
await db.exec('reset role');

// New policy is opt-in for newly captured identities; legacy audit stays intact.
await db.exec(`alter table stations add column provider_id uuid;
update stations set provider_id='${provider}';
create function lock_workforce_payment_allocation_company(uuid) returns void language sql as 'select';
create table test_dependency_bumps(company_id uuid,day date);
create function workforce_bump_payout_period_dependency_revision(uuid,date) returns void language sql as 'insert into public.test_dependency_bumps values($1,$2)';
create table test_dependency_refreshes(company_id uuid,workforce_id uuid,station_id uuid,starts date,ends date);
create function enqueue_workforce_payout_dependency_refresh(uuid,uuid,uuid,date,date,uuid) returns integer language plpgsql as $$
begin
  if $1 is null or $2 is null or $3 is null or $4 is null or $5 is null or $5<$4 then
    raise exception 'A payout dependency refresh requires company, Workforce, location, and a valid effective period.';
  end if;
  insert into public.test_dependency_refreshes values($1,$2,$3,$4,$5);
  return 1;
end $$;
create table workforce_payout_effective_paid_allocations(company_id uuid,credited_workforce_id uuid,station_id uuid,period_start date,period_end date);
`);
const migration=readFileSync(new URL('../supabase/migrations/20261025120000_adhoc_wishmaster_paid_days.sql',import.meta.url),'utf8').replace(/^\uFEFF/,'');
await db.exec(migration); await db.exec(migration);
const bankIsolate=readFileSync(new URL('../supabase/migrations/20261029210000_adhoc_paid_day_mapping_bank_isolate.sql',import.meta.url),'utf8').replace(/^\uFEFF/,'');
await db.exec(bankIsolate); await db.exec(bankIsolate);
const deferredMapping=readFileSync(new URL('../supabase/migrations/20261029210001_adhoc_paid_day_deferred_workforce.sql',import.meta.url),'utf8');
await db.exec(deferredMapping); await db.exec(deferredMapping);
await db.exec(`delete from field_executive_provider_mappings where workforce_id='${actor}';
update field_executive_provider_mappings set effective_from='2026-09-01';
update workforce_payroll_runs set status='draft';
`);
const before=await count();
const dated=await insert({request_no:'DATED-AMAZON',adhoc_payout_policy:'work_day',adhoc_work_date:'2026-10-11'});
await db.query("update payment_requests set status='approved' where id=$1",[dated.id]);
assert.equal(await count(),before);
await db.query("update payment_requests set status='paid' where id=$1",[dated.id]);
assert.equal(await count(),before,'Paid-day policy must not ALSO recover the ad hoc amount');
assert.equal((await db.query('select count(*) n from test_dependency_bumps')).rows[0].n,1,'Paid transition invalidates payout dependency');
await db.query("update payment_requests set status='paid' where id=$1",[dated.id]);
assert.equal((await db.query('select count(*) n from test_dependency_bumps')).rows[0].n,1,'Retry does not repeatedly invalidate');
await assert.rejects(()=>insert({request_no:'DUP',adhoc_payout_policy:'work_day',adhoc_work_date:'2026-10-11',status:'paid'}),/already has a paid/);
await assert.rejects(()=>db.query("update payment_requests set adhoc_payout_policy='cash_recovery' where id=$1",[dated.id]),/policy is frozen/);
await assert.rejects(()=>db.query("update payment_requests set adhoc_work_date='2026-10-12' where id=$1",[dated.id]),/identity is frozen/);
await db.exec(`update providers set code='FLIPKART',name='Flipkart'; update field_executive_provider_mappings set provider_member_id='001234567890';`);
for (const invalidId of ['123', '12345678901', '1234567890123', '12345678901A', '123 45678901', '1.2345678e11']) {
  await assert.rejects(()=>insert({adhoc_shipment_id:null,adhoc_payout_policy:'work_day',adhoc_provider_employee_id:invalidId,adhoc_da_name:'Missing'}),/12-digit/);
}
await assert.rejects(()=>insert({adhoc_payout_policy:'work_day'}),/this station and provider/);
const wm=await insert({request_no:'FHR-MANUAL',adhoc_shipment_id:null,adhoc_payout_policy:'work_day',adhoc_work_date:'2026-10-12',adhoc_provider_employee_id:'001234567890',adhoc_da_name:'Wishmaster'});
assert.equal(wm.adhoc_client,'Flipkart'); assert.equal(wm.adhoc_provider_employee_id,'001234567890'); assert.equal(wm.adhoc_workforce_id,worker);
await db.query("update payment_requests set status='paid' where id=$1",[wm.id]);
assert.equal(await count(),before);
await db.exec(`insert into cps_shipment_daily values(gen_random_uuid(),'${company}','ERSE','2026-10-12','001234567890','Wishmaster','Flipkart');
insert into cps_shipment_daily values(gen_random_uuid(),'${company}','ERSE','2026-10-13','001234567891','Other','Flipkart');`);
const roster=(await db.query('select * from payment_adhoc_da_roster($1,$2)',[company,station])).rows;
assert.equal(roster.length,2,'Fortnight roster includes associates absent on the final report day');
assert.ok(roster.some(x=>x.provider_member_id==='001234567890'));
const imported=await insert({request_no:'FHR-IMPORTED',adhoc_shipment_id:roster.find(x=>x.provider_member_id==='001234567890').shipment_id,adhoc_payout_policy:'work_day',adhoc_work_date:'2026-10-14'});
assert.equal(imported.adhoc_client,'Flipkart');assert.equal(imported.adhoc_provider_employee_id,'001234567890');
await db.exec(`insert into workforce_payout_effective_paid_allocations values('${company}','${worker}','${station}','2026-10-14','2026-10-14')`);
await assert.rejects(()=>db.query("update payment_requests set status='paid' where id=$1",[imported.id]),/finalized Workforce payout/);
const otherStation='00000000-0000-0000-0000-000000000009';
await db.exec(`insert into stations(id,company_id,station_code,provider_id) values('${otherStation}','${company}','OTHER','${provider}');
insert into cps_shipment_daily values(gen_random_uuid(),'${company}','OTHER','2026-10-15','001234567892','Moved DA','Flipkart');`);
const moved=await insert({request_no:'MOVED-STATION',location_id:otherStation,adhoc_shipment_id:null,adhoc_payout_policy:'work_day',adhoc_work_date:'2026-10-15',adhoc_provider_employee_id:'001234567890',adhoc_da_name:'Wishmaster'});
assert.equal(moved.adhoc_workforce_id,worker,'Company-unique provider-member resolves when the request station has no mapping');
await db.query("update payment_requests set status='paid' where id=$1",[moved.id]);
assert.equal((await db.query('select adhoc_workforce_id from payment_requests where id=$1',[moved.id])).rows[0].adhoc_workforce_id,worker);
const unmappedPaid=await insert({request_no:'UNMAPPED-PAID',location_id:otherStation,adhoc_shipment_id:null,adhoc_payout_policy:'work_day',adhoc_work_date:'2026-10-16',adhoc_provider_employee_id:'001234567899',adhoc_da_name:'No Map'});
const refreshCount=async()=>Number((await db.query('select count(*) n from test_dependency_refreshes')).rows[0].n);
const bumpCount=async()=>Number((await db.query('select count(*) n from test_dependency_bumps')).rows[0].n);
const queuedBefore=await refreshCount(), bumpsBefore=await bumpCount();
await db.query("update payment_requests set status='processed' where id=$1",[unmappedPaid.id]);
let deferredPaid=(await db.query('select * from payment_requests where id=$1',[unmappedPaid.id])).rows[0];
assert.equal(deferredPaid.status,'processed','Missing mapping must not block bank confirmation');
assert.equal(deferredPaid.adhoc_workforce_id,null);
assert.equal(deferredPaid.adhoc_provider_employee_id,'001234567899');
assert.equal(deferredPaid.adhoc_work_date.toISOString().slice(0,10),'2026-10-16');
assert.equal(deferredPaid.adhoc_adjustment_id,null,'Paid work days never also become cash recoveries');
assert.equal(await refreshCount(),queuedBefore,'Do not queue a null Workforce target');
assert.equal(await bumpCount(),bumpsBefore+1,'Bank confirmation invalidates the payout period even before mapping');
await db.query("update payment_requests set status='processed' where id=$1",[unmappedPaid.id]);
await db.exec('select reconcile_adhoc_da_recoveries(); select reconcile_adhoc_da_recoveries();');
assert.equal(await refreshCount(),queuedBefore);
assert.equal(await bumpCount(),bumpsBefore+1,'Unmapped retries must not repeatedly invalidate the period');
await assert.rejects(()=>insert({request_no:'UNMAPPED-DUP',location_id:otherStation,adhoc_shipment_id:null,adhoc_payout_policy:'work_day',adhoc_work_date:'2026-10-16',adhoc_provider_employee_id:'001234567899',adhoc_da_name:'No Map',status:'processed'}),/already has a paid/);
await assert.rejects(()=>db.query('update payment_requests set adhoc_workforce_id=$1 where id=$2',[worker,unmappedPaid.id]),/identity is frozen/);

// Mapping entered later must cover the actual work date. The scheduled RPC
// resolves it, refreshes once, and leaves immutable bank amounts/dates intact.
await db.exec(`insert into field_executive_provider_mappings(company_id,station_id,provider_id,provider_member_id,workforce_id,effective_from,status)
 values('${company}','${otherStation}','${provider}','001234567899','${worker}','2026-10-17','active');
 select reconcile_adhoc_da_recoveries();`);
assert.equal((await db.query('select adhoc_workforce_id from payment_requests where id=$1',[unmappedPaid.id])).rows[0].adhoc_workforce_id,null,'A future-only mapping must not claim an earlier work day');
await db.exec(`update field_executive_provider_mappings set effective_from='2026-10-16' where provider_member_id='001234567899';
 insert into field_executive_provider_mappings(company_id,station_id,provider_id,provider_member_id,workforce_id,effective_from,status)
 values('${company}','${otherStation}','${provider}','001234567899','${actor}','2026-10-16','active');
 select reconcile_adhoc_da_recoveries();`);
assert.equal((await db.query('select adhoc_workforce_id from payment_requests where id=$1',[unmappedPaid.id])).rows[0].adhoc_workforce_id,null,'Ambiguous mappings cannot guess who owes the paid day');
assert.equal(await refreshCount(),queuedBefore);
await db.exec(`update field_executive_provider_mappings set status='cancelled' where provider_member_id='001234567899' and workforce_id='${actor}'; select reconcile_adhoc_da_recoveries();`);
deferredPaid=(await db.query('select * from payment_requests where id=$1',[unmappedPaid.id])).rows[0];
assert.equal(deferredPaid.adhoc_workforce_id,worker);
assert.equal(deferredPaid.status,'processed');
assert.equal(Number(deferredPaid.amount),100);
assert.equal(deferredPaid.adhoc_adjustment_id,null);
assert.equal(await refreshCount(),queuedBefore+1);
assert.equal(await bumpCount(),bumpsBefore+2);
await db.exec('select reconcile_adhoc_da_recoveries(); select reconcile_adhoc_da_recoveries();');
assert.equal(await refreshCount(),queuedBefore+1,'Deferred mapping refreshes once, even on repeated job runs');
assert.equal((await db.query("select count(*) n from workforce_adjustments where external_reference=$1",['OPS-ADHOC-DA:'+unmappedPaid.id])).rows[0].n,0);

const closedLate=await insert({request_no:'LATE-CLOSED',location_id:otherStation,adhoc_shipment_id:null,adhoc_payout_policy:'work_day',adhoc_work_date:'2026-10-18',adhoc_provider_employee_id:'001234567898',adhoc_da_name:'Closed period',status:'processed'});
await db.exec(`insert into field_executive_provider_mappings(company_id,station_id,provider_id,provider_member_id,workforce_id,effective_from,status)
 values('${company}','${otherStation}','${provider}','001234567898','${worker}','2026-10-18','active');
 insert into workforce_payout_effective_paid_allocations values('${company}','${worker}','${otherStation}','2026-10-18','2026-10-18');`);
const lateClosedResult=(await db.query('select reconcile_adhoc_da_recoveries() result')).rows[0].result;
assert.ok(lateClosedResult.errors.some(error=>error.id===closedLate.id && /finalized Workforce payout/.test(error.error)));
assert.deepEqual((await db.query('select status,adhoc_workforce_id,adhoc_adjustment_id from payment_requests where id=$1',[closedLate.id])).rows[0],{status:'processed',adhoc_workforce_id:null,adhoc_adjustment_id:null},'Late reconciliation must not rewrite a finalized payout or undo bank confirmation');
assert.equal(await refreshCount(),queuedBefore+1);
await db.exec('set role authenticated');
await assert.rejects(()=>db.query('select * from payment_adhoc_da_roster($1,$2)',[company,station]),/permission denied/);
await assert.rejects(()=>db.query('select reconcile_adhoc_da_recoveries()'),/permission denied/);
await db.exec('reset role');
await db.close();
console.log('PASS legacy recovery + paid work-day policy, bank confirmation before mapping, deferred reconciliation exactly once, idempotent migrations.');
