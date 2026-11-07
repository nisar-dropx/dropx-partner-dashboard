import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const read=name=>readFileSync(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const company=id(1),provider=id(2),base=id(3),xpt=id(4),outside=id(5),worker=id(6),other=id(7),head=id(8),model=id(9),xmodel=id(10),wrongProvider=id(11),foreign=id(12);
await db.exec(`
create role anon;create role authenticated;create role service_role;
create table location_models(id uuid,company_id uuid,code text);
create table stations(id uuid,company_id uuid,station_code text,provider_id uuid,location_model_id uuid,parent_station_id uuid);
create table providers(id uuid,company_id uuid,code text,name text);
create table workforce(id uuid,company_id uuid,full_name text,dropx_id text,source_profile_id uuid);
create table field_executive_provider_mappings(company_id uuid,station_id uuid,provider_id uuid,provider_member_id text,workforce_id uuid,field_executive_id uuid,contractor_id uuid,employee_id uuid,status text,effective_from date,effective_to date);
create table cps_shipment_daily(id uuid,company_id uuid,station_code text,client text,provider_employee_id text,provider_employee_name text,work_date date);
create table payment_heads(id uuid,company_id uuid,delivery_identity_policy text);
create table payment_requests(
 id int primary key,company_id uuid,location_id uuid,payment_head_id uuid,source_system text,status text,approval_status text,amount numeric,amount_requested numeric,amount_approved numeric,work_date date,payment_mode text,bank_account_no text,beneficiary_account_no text,beneficiary_account_number text,ifsc text,beneficiary_ifsc text,account_holder_name text,beneficiary_account_holder text,
 delivery_performer_mode text,delivery_work_date date,delivery_shipment_id uuid,delivery_provider_employee_id text,delivery_performer_workforce_id uuid,delivery_performer_name text,delivery_identity_confirmed boolean not null default false,adhoc_payout_effect text default 'none',adhoc_client text,updated_at timestamptz,updated_by uuid,processing_started_at timestamptz,bank_utr text,bank_status text,requested_for_name text);
create table workforce_payout_effective_paid_allocations(company_id uuid,credited_workforce_id uuid,station_id uuid,period_start date,period_end date);
create table workforce_payroll_runs(id uuid,company_id uuid,status text,period_start date,period_end date);
create table workforce_payroll_items(payroll_run_id uuid,company_id uuid,workforce_id uuid,status text);
create table refresh_audit(company_id uuid,worker_id uuid,station_id uuid,start_date date,end_date date);
create table revision_audit(company_id uuid,work_date date);
create function lock_workforce_payment_allocation_company(uuid) returns void language sql as $$select pg_advisory_xact_lock(hashtextextended($1::text,0))$$;
create function workforce_bump_payout_period_dependency_revision(uuid,date) returns void language sql as $$insert into public.revision_audit values($1,$2)$$;
create function enqueue_workforce_payout_dependency_refresh(uuid,uuid,uuid,date,date,uuid) returns void language sql as $$insert into public.refresh_audit values($1,$2,$3,$4,$5)$$;
insert into providers values('${provider}','${company}','AMAZON','Amazon'),('${wrongProvider}','${company}','FLIPKART','Flipkart');
insert into location_models values('${model}','${company}','EDSP'),('${xmodel}','${company}','XPT');
insert into stations values('${base}','${company}','BASE','${provider}','${model}',null),('${xpt}','${company}','XPT','${provider}','${xmodel}','${base}'),('${outside}','${company}','OTHER','${provider}','${model}',null),('${id(20)}','${company}','WRONG','${wrongProvider}','${xmodel}','${base}'),('${id(21)}','${foreign}','FOREIGN','${provider}','${xmodel}','${base}');
insert into workforce values('${worker}','${company}','Test DA','T1005',null),('${other}','${company}','Other DA','T1006',null);
insert into payment_heads values('${head}','${company}','van_execution');
-- An approved legacy row must remain exportable after the migration.
insert into payment_requests(id,company_id,location_id,payment_head_id,status,amount) values(1,'${company}','${base}','${head}','approved',1200);
`);
// Simulate a confirmed payment already in bank processing before this release.
await db.query(`insert into payment_requests(id,company_id,location_id,payment_head_id,status,amount,delivery_performer_mode,delivery_provider_employee_id,delivery_work_date,delivery_identity_confirmed,delivery_performer_workforce_id,adhoc_payout_effect,adhoc_client) values(7,$1,$2,$3,'processing',1200,'van_driver','DA001','2026-11-08',true,$4,'full_day','Amazon')`,[company,base,head,worker]);
const migration=read('20261107042407_adhoc_delivery_station_family.sql');
await db.exec(migration);await db.exec(migration);
await db.exec(read('20261104202500_preserve_inflight_delivery_payments.sql'));
await db.exec(read('20261105121205_preserve_approved_delivery_bank_exports.sql'));
await db.exec("update payment_requests set status='processing' where id=1;update payment_requests set status='paid' where id=1");
assert.equal((await db.query('select delivery_identity_confirmed from payment_requests where id=1')).rows[0].delivery_identity_confirmed,false);
const map=async(member,station=base,w=worker,from='2026-11-01',to=null,status='active',p=provider)=>db.query('insert into field_executive_provider_mappings(company_id,station_id,provider_id,provider_member_id,workforce_id,status,effective_from,effective_to) values($1,$2,$3,$4,$5,$6,$7,$8)',[company,station,p,member,w,status,from,to]);
await map('DA001');await map('DA001',xpt);await map('DA002',xpt);await map('DA003',outside);await map('FUTURE',base,worker,'2026-11-07');await map('EXPIRED',base,worker,'2026-10-01','2026-11-05','closed');await map('AMBIGUOUS');await map('AMBIGUOUS',xpt,other);await map('UNMAPPED',base,null);await map('CANCELLED',base,worker,'2026-11-01',null,'cancelled');await map('WRONG',id(20),worker,'2026-11-01',null,'active',wrongProvider);await map('DA001');
const roster=async(station=base)=> (await db.query('select * from payment_delivery_identity_roster_v2($1,$2,$3)',[company,station,'2026-11-06'])).rows;
assert.deepEqual((await roster()).map(r=>r.provider_member_id),['DA001','DA002'],'Mapping-first, no delivery import required; exclude ambiguous, expired, future, unmapped and unrelated stations');
assert.deepEqual(await roster(xpt),await roster(base),'Base and XPT can see the same configured family');
assert.deepEqual((await roster())[0].station_ids,[base,xpt]);
assert.equal((await db.query('select * from payment_delivery_identity_roster($1,$2,$3)',[company,base,'2026-11-06'])).rows.length,0);
await db.query('insert into cps_shipment_daily values($1,$2,$3,$4,$5,$6,$7)',[id(30),company,'XPT','Amazon','DA002','Imported DA','2026-11-05']);
assert.equal((await db.query('select * from payment_delivery_identity_roster($1,$2,$3)',[company,base,'2026-11-06'])).rows[0].shipment_id,id(30),'Old clients can select imported XPT DA');
const insert=async(n,mode='van_driver',member='DA001',location=base,date='2026-11-06',shipment=null)=>db.query(`insert into payment_requests(id,company_id,location_id,payment_head_id,status,amount,delivery_performer_mode,delivery_provider_employee_id,delivery_work_date,delivery_identity_confirmed,delivery_shipment_id,delivery_payout_station_ids) values($1,$2,$3,$4,'approved',1200,$5,$6,$7,true,$8,array[$9::uuid]) returning *`,[n,company,location,head,mode,member,date,shipment,outside]);
let row=(await insert(2)).rows[0];assert.equal(row.delivery_performer_workforce_id,worker);assert.equal(row.adhoc_payout_effect,'full_day');assert.deepEqual(row.delivery_payout_station_ids,[base,xpt],'DB overwrites client-supplied scope');
row=(await insert(3,'existing_odcd','DA002',base,'2026-11-06',id(30))).rows[0];assert.equal(row.adhoc_payout_effect,'base_only');assert.deepEqual(row.delivery_payout_station_ids,[xpt]);
row=(await insert(4,'bike_da')).rows[0];assert.equal(row.adhoc_payout_effect,'none');
await assert.rejects(()=>insert(5,'van_driver','DA003'),/unmapped/);
await assert.rejects(()=>insert(5,'van_driver','AMBIGUOUS'),/unmapped/);
await assert.rejects(()=>db.exec(`update payment_requests set delivery_payout_station_ids=array['${outside}'::uuid] where id=2`),/frozen/);
await assert.rejects(()=>db.exec('delete from payment_requests where id=2'),/cancelled/);
// A paid allocation at XPT also protects an ad hoc payment submitted at its base.
await db.query('insert into workforce_payout_effective_paid_allocations values($1,$2,$3,$4,$5)',[company,worker,xpt,'2026-11-01','2026-11-30']);
await assert.rejects(()=>db.exec("update payment_requests set status='paid' where id=2"),/finalized Workforce payout/);
await db.exec('delete from workforce_payout_effective_paid_allocations');
await db.exec("update payment_requests set status='paid' where id=2");
assert.deepEqual((await db.query('select station_id from refresh_audit order by station_id')).rows.map(r=>r.station_id),[base,xpt]);
assert.equal((await db.query('select count(*)::int n from revision_audit')).rows[0].n,1);
await assert.rejects(()=>db.exec("update payment_requests set status='paid' where id=3"),/already has a paid ad hoc/);
await db.exec("update payment_requests set status='paid' where id=2;update payment_requests set status='paid' where id=4");
assert.equal((await db.query('select count(*)::int n from revision_audit')).rows[0].n,1,'Retry and separate bike DA do not create duplicate deduction/refresh');
await db.exec("update payment_requests set status='processed' where id=7");
assert.deepEqual((await db.query('select delivery_payout_station_ids from payment_requests where id=7')).rows[0].delivery_payout_station_ids,[base,xpt],'In-flight confirmed request captures family scope on bank confirmation');
// A distinct work date remains payable; existing confirmed snapshots survive mapping changes.
await insert(6,'existing_odcd','DA001',base,'2026-11-07');
await db.exec("update field_executive_provider_mappings set status='cancelled';update payment_requests set status='paid' where id=6");
assert.equal((await db.query('select count(*)::int n from refresh_audit')).rows[0].n,6);
for (const role of ['anon','authenticated']) {
 await db.exec(`set role ${role}`);
 await assert.rejects(()=>roster(),/permission denied/);
 await db.exec('reset role');
}
await db.exec('set role service_role');assert.deepEqual(await roster(),[]);await db.exec('reset role');
await db.close();console.log('PASS station-family migration twice, mapping-only DA roster, XPT imports, date/owner/provider isolation, frozen scope, legacy bank export, paid-XPT protection, duplicate prevention, refreshes, role grants.');
