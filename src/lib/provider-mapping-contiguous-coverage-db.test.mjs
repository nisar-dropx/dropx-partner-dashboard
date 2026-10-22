import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const migration = name => readFile(new URL('../../supabase/migrations/'+name, import.meta.url), 'utf8');

test('rate changes preserve continuous registered-location coverage across the complete schedule', async t => {
 const db = new PGlite();
 try {
 await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.workforce (
      id uuid primary key,
      company_id uuid not null,
      dropx_id text,
      full_name text,
      location_id uuid,
      deleted_at timestamptz,
      migration_state text default 'canonical',
      last_working_date date,
      lifecycle_status text,
      source_profile_type text,
      source_profile_id uuid,
      provider_employee_id text,
      provider_id_status text,
      updated_at timestamptz default now()
    );
    create table public.stations (
      id uuid primary key,
      company_id uuid not null,
      provider_id uuid not null
    );
    create table public.field_executive_provider_mappings (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      workforce_id uuid,
      field_executive_id uuid,
      employee_id uuid,
      contractor_id uuid,
      provider_id uuid,
      station_id uuid,
      provider_member_id text,
      effective_from date not null,
      effective_to date,
      payment_method_id uuid,
      payment_values jsonb default '{}'::jsonb,
      production_threshold_config jsonb,
      pay_type text,
      status text not null default 'active',
      created_by uuid,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create unique index field_executive_provider_mappings_one_current_member_idx
      on public.field_executive_provider_mappings(company_id, provider_id, upper(btrim(provider_member_id)))
      where effective_to is null and status = 'active';
    create table public.workforce_joining_events (
      company_id uuid,
      workforce_id uuid,
      event_code text,
      actor_id uuid,
      actor_name text,
      details jsonb
    );
    create function public.workforce_provider_mapping_person(uuid, uuid, uuid, uuid, uuid)
    returns uuid language sql immutable as $$ select coalesce($2, $3, $4, $5) $$;
  
 alter table workforce add column onboarding_status text, add column is_active boolean;
 alter table field_executive_provider_mappings add column delivery_rate numeric, add column pickup_rate numeric, add column mfn_rate numeric, add column mfn_return_rate numeric, add column guarantee_amount numeric, add column guarantee_schedule text, add column fuel_rate numeric, add column reason text;
 create table workforce_joining_plans(company_id uuid,workforce_id uuid,version int,updated_at timestamptz);
 create table workforce_payroll_runs(id uuid,company_id uuid,period_start date,period_end date,status text);
 create table workforce_payroll_items(company_id uuid,workforce_id uuid,payroll_run_id uuid,status text);
 create function public.lock_workforce_payment_allocation_company(uuid) returns void language sql as $$ select null::void $$;
 `);
 const finalized=await migration('20261005160446_provider_mapping_finalized_payout_period_guard.sql');
 await db.exec(finalized.slice(finalized.indexOf('create or replace function public.workforce_joining_mapping_guard()'),finalized.indexOf('create or replace function public.workforce_replace_joining_mapping(')));
 await db.exec(await migration('20261004095852_remove_workforce_mapping_approval_gate.sql'));
 await db.exec(await migration('20261009173118_workforce_provider_mapping_multi_location.sql'));
 await db.exec(await migration('20261012220000_provider_mapping_registered_location_exception.sql'));
 await db.exec(await migration('20261013150000_provider_mapping_historical_registered_location_periods_final.sql'));
 await db.exec(await migration('20261013190000_provider_mapping_payment_schedule.sql'));
 const id=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
 const company=id(1),worker=id(2),station=id(3),provider=id(4),actor=id(5),method=id(6);
 await db.query("insert into workforce(id,company_id,location_id,dropx_id) values($1,$2,$3,'DX1')",[worker,company,station]);
 await db.query('insert into stations(id,company_id,provider_id) values($1,$2,$3)',[station,company,provider]);

 const extra = id(8), otherWorker = id(9), otherStation = id(10);
 await db.query('insert into stations(id,company_id,provider_id) values($1,$2,$3),($4,$2,$3)', [extra,company,provider,otherStation]);
 await db.query("insert into workforce(id,company_id,location_id,dropx_id) values($1,$2,$3,'DX2')", [otherWorker,company,station]);
 const period = (from,to,rate,target=station) => ({company_id:company,workforce_id:worker,provider_id:provider,station_id:target,provider_member_id:'111',effective_from:from,effective_to:to,payment_method_id:method,payment_values:{DELIVERY:rate},status:to?'closed':'active',pay_type:'PER_PACKET'});
 const versions = async target => (await db.query("select id,updated_at from field_executive_provider_mappings where workforce_id=$1 and station_id=$2 and status <> 'cancelled'",[worker,target])).rows;
 const call = async plan => db.query('select workforce_save_mapping_schedule($1,$2,$3,$4,$5::jsonb,$6::uuid[],$7,$8::jsonb) as records',[company,actor,worker,'DX1',JSON.stringify(plan),null,'Reviewer',JSON.stringify(await versions(plan[0].station_id))]);
 const keep = async (anchor, row) => (await db.query('select workforce_keep_joining_mapping($1,$2,$3,$4,$5,$6::jsonb,null,$7) as id',[company,actor,worker,anchor,'DX1',JSON.stringify(row),'Reviewer'])).rows[0].id;
 const state = async () => ({mappings:(await db.query('select * from field_executive_provider_mappings order by id')).rows,events:(await db.query('select * from workforce_joining_events order by event_code,details::text')).rows});
 const anchorId=id(20);
 await db.query('insert into field_executive_provider_mappings select * from jsonb_populate_record(null::field_executive_provider_mappings,$1)',[JSON.stringify({...period('2026-01-01',null,1000),id:anchorId})]);
 const childId=await keep(anchorId,period('2026-10-01',null,1000,extra));
 const plan=[period('2026-01-01','2026-10-20',1000),{...period('2026-10-21',null,16),payment_method_id:id(25)}];
 const before=await state();
 // This reproduces the screenshot: continuous KGQA periods with ongoing KGQC.
 // Reproduce on both a clean migration history and the production writer.
 await assert.rejects(call(plan),/overlapping provider mapping/);
 const fix=await migration('20261015133000_provider_mapping_contiguous_payment_coverage.sql');
 await db.exec(fix.slice(fix.indexOf('do $save_writer$'),fix.indexOf('-- Do not overwrite unrelated deployed protections')));
 await assert.rejects(call(plan),/registered-location mapping must cover/);
 assert.deepEqual(await state(),before,'failed plans must roll back all rate changes and audit events');
 const contiguousMigration=await migration('20261015133000_provider_mapping_contiguous_payment_coverage.sql');
 const laterKeepMigration=await migration('20261015150000_provider_mapping_keep_registered_location.sql');
 const finalCoverageMigration=await migration('20261016100000_provider_mapping_contiguous_coverage_final.sql');
 await db.exec(contiguousMigration);
 await db.exec(laterKeepMigration);
 await assert.rejects(call(plan),/registered-location mapping must cover/,
   'the later Keep-all migration reproduces the single-row coverage regression');
 assert.match(finalCoverageMigration,/create or replace function public\.workforce_provider_mapping_period_covered/i);
 assert.match(finalCoverageMigration,/create or replace function public\.workforce_assert_provider_mapping_registered_location/i);
 assert.doesNotMatch(finalCoverageMigration,/workforce_save_mapping|workforce_keep_joining_mapping|workforce_save_mapping_schedule/,
   'the final migration must not duplicate unrelated mapping writers');
 await db.exec(finalCoverageMigration);
 // The final migration is safe to re-run after every historical writer.
 await db.exec(finalCoverageMigration);

 await t.test('legacy Keep-all events do not misclassify a closed registered anchor period',async()=>{
   const legacyWorker=id(40),legacyAnchor=id(41),legacyChild=id(42),legacyMember='LEGACY-111';
   const legacyPeriod=(from,to,rate,target=station)=>({...period(from,to,rate,target),workforce_id:legacyWorker,provider_member_id:legacyMember});
   await db.query("insert into workforce(id,company_id,location_id,dropx_id) values($1,$2,$3,'LEGACY1')",[legacyWorker,company,station]);
   for(const row of [
     {...legacyPeriod('2026-10-01',null,800),id:legacyAnchor},
     {...legacyPeriod('2026-10-01','2026-10-19',800,extra),id:legacyChild},
   ]) await db.query('insert into field_executive_provider_mappings select * from jsonb_populate_record(null::field_executive_provider_mappings,$1)',[JSON.stringify(row)]);
   await db.query("insert into workforce_joining_events(company_id,workforce_id,event_code,details) values($1,$2,'provider_mapping_location_kept',$3)",[company,legacyWorker,{
     existing_mapping_id:legacyChild,
     new_mapping_id:legacyAnchor,
     provider_id:provider,
     provider_member_id:legacyMember,
     existing_station_id:extra,
     new_station_id:station,
     effective_from:'2026-10-23'
   }]);
   const legacyVersions=async()=>(await db.query("select id,updated_at from field_executive_provider_mappings where workforce_id=$1 and station_id=$2 and status<>'cancelled'",[legacyWorker,station])).rows;
   const legacyCall=async plan=>db.query('select workforce_save_mapping_schedule($1,$2,$3,$4,$5::jsonb,$6::uuid[],$7,$8::jsonb) as records',[company,actor,legacyWorker,'LEGACY1',JSON.stringify(plan),null,'Reviewer',JSON.stringify(await legacyVersions())]);
   const legacyPlan=[legacyPeriod('2026-10-01','2026-10-22',800),{...legacyPeriod('2026-10-23',null,17),payment_method_id:id(25)}];
   const legacyChildBefore=(await db.query('select * from field_executive_provider_mappings where id=$1',[legacyChild])).rows[0];
   await assert.rejects(legacyCall(legacyPlan),/registered-location mapping must cover/,
     'the old assertion mistakes the registered anchor named by new_mapping_id for an additional-location row');

   const legacyAnchorMigration=await migration('20261021103000_provider_mapping_registered_anchor_legacy_keep.sql');
   assert.match(legacyAnchorMigration,/mapping\.station_id is distinct from registered_station/);
   await db.exec(legacyAnchorMigration);
   const saved=await legacyCall(legacyPlan);
   assert.deepEqual(saved.rows[0].records.map(row=>[row.effective_from,row.effective_to,row.payment_values.DELIVERY]),[
     ['2026-10-01','2026-10-22',800],
     ['2026-10-23',null,17]
   ]);
   assert.deepEqual((await db.query('select * from field_executive_provider_mappings where id=$1',[legacyChild])).rows,[legacyChildBefore],
     'the historical additional-location mapping must remain unchanged');
 });

 const keepAnchorMigration=await migration('20261022210000_provider_mapping_contiguous_keep_anchor.sql');
 assert.match(keepAnchorMigration,/workforce_provider_mapping_period_covered/);
 assert.match(keepAnchorMigration,/existing_mapping\.effective_to < mapping_payload\.effective_from/);
 await db.exec(keepAnchorMigration);
 await db.exec(keepAnchorMigration);

 const result=await call(plan);
 assert.equal(result.rows[0].records.length,2);
 assert.equal(result.rows[0].records[1].payment_method_id,id(25));
 assert.deepEqual(result.rows[0].records.map(r=>[r.effective_from,r.effective_to,r.payment_values.DELIVERY]),[['2026-01-01','2026-10-20',1000],['2026-10-21',null,16]]);
 assert.deepEqual((await db.query('select * from field_executive_provider_mappings where id=$1',[childId])).rows,[before.mappings.find(r=>r.id===childId)]);

 await t.test('Keep-all uses the contiguous timeline but requires the exact row effective on the requested start',async()=>{
   const fullSpanStation=id(11),laterStation=id(12);
   await db.query('insert into stations(id,company_id,provider_id) values($1,$2,$3),($4,$2,$3)',[fullSpanStation,company,provider,laterStation]);
   const fullSpan=await keep(anchorId,period('2026-10-01',null,18,fullSpanStation));
   assert.ok(fullSpan,'adjacent registered payment periods cover the complete open-ended assignment');
   await assert.rejects(
     keep(anchorId,period('2026-10-21',null,19,laterStation)),
     /registered-location mapping must cover/i,
     'the confirmed audit anchor must itself be effective on the requested start'
   );
   const openAnchor=(await db.query("select id from field_executive_provider_mappings where workforce_id=$1 and station_id=$2 and effective_from='2026-10-21' and effective_to is null",[worker,station])).rows[0].id;
   assert.ok(await keep(openAnchor,period('2026-10-21',null,19,laterStation)));
 });

 await t.test('starting the plan this month preserves the earlier payment history',async()=>{
   const result=await call([period('2026-10-01','2026-10-20',1000),plan[1]]);
   assert.deepEqual(result.rows[0].records.map(r=>[r.effective_from,r.effective_to]),[['2026-01-01','2026-09-30'],['2026-10-01','2026-10-20'],['2026-10-21',null]]);
 });

 await t.test('single-row closure cannot strand an ongoing additional assignment',async()=>{
   const saved=await state();
   await assert.rejects(db.query("update field_executive_provider_mappings set effective_to='2026-10-31',status='closed' where station_id=$1 and effective_to is null",[station]),/registered-location mapping must cover/);
   assert.deepEqual(await state(),saved);
 });
 await t.test('a one-day gap is rejected and leaves both locations unchanged',async()=>{
   const saved=await state();
   await assert.rejects(db.query("update field_executive_provider_mappings set effective_from='2026-10-22' where station_id=$1 and effective_to is null",[station]),/registered-location mapping must cover/);
   assert.deepEqual(await state(),saved);
 });
 await t.test('additional-location plans can span multiple registered payment periods',async()=>{
   const result=await call([period('2026-10-01','2026-10-10',1000,extra),period('2026-10-11',null,17,extra)]);
   assert.equal(result.rows[0].records.length,2);
   assert.equal(result.rows[0].records[1].payment_values.DELIVERY,17);
   assert.equal((await db.query('select location_id from workforce where id=$1',[worker])).rows[0].location_id,station);
 });
 await t.test('bounded historical Keep-all can span adjacent registered periods',async()=>{
   const boundedAnchor=(await db.query("select id from field_executive_provider_mappings where workforce_id=$1 and station_id=$2 and effective_from<='2026-10-01' and (effective_to is null or effective_to>='2026-10-01') order by effective_from desc,id limit 1",[worker,station])).rows[0].id;
   const bounded=await keep(boundedAnchor,period('2026-10-01','2026-10-31',15,otherStation));
   assert.ok(bounded);
   const saved=await state();
   await assert.rejects(db.query("update field_executive_provider_mappings set status='cancelled' where id=$1",[anchorId]),/registered-location mapping/);
   assert.deepEqual(await state(),saved);
 });
 await t.test('coverage cannot be borrowed from a different owner, provider, member or tenant',async()=>{
   for(const args of [
     [company,otherWorker,station,provider,'111'],
     [company,worker,station,id(91),'111'],
     [company,worker,station,provider,'222'],
     [id(92),worker,station,provider,'111'],
   ]) assert.equal((await db.query('select workforce_provider_mapping_period_covered($1,$2,$3,$4,$5,$6,$7) as covered',[...args,'2026-10-01',null])).rows[0].covered,false);
   const saved=await state();
   await assert.rejects(db.query('update field_executive_provider_mappings set workforce_id=$1 where station_id=$2 and effective_to is null',[otherWorker,station]),/same DropX ID|registered-location|Do not reassign/);
   assert.deepEqual(await state(),saved);
 });
 await t.test('real reverse-Keep-all evidence remains valid after rate splits',async()=>{
   const reverseWorker=id(30),reverseAnchor=id(31),reverseChild=id(32);
   await db.query("insert into workforce(id,company_id,location_id,dropx_id) values($1,$2,$3,'REV')",[reverseWorker,company,station]);
   await db.exec('begin');
   for(const row of [
     {...period('2026-10-01','2026-10-20',10),id:reverseAnchor,workforce_id:reverseWorker,provider_member_id:'REV'},
     {...period('2026-10-21',null,12),id:id(33),workforce_id:reverseWorker,provider_member_id:'REV'},
     {...period('2026-09-01',null,10,extra),id:reverseChild,workforce_id:reverseWorker,provider_member_id:'REV'},
   ]) await db.query('insert into field_executive_provider_mappings select * from jsonb_populate_record(null::field_executive_provider_mappings,$1)',[JSON.stringify(row)]);
   const details={keep_direction:'registered_anchor_added',registered_mapping_id:reverseAnchor,additional_mapping_id:reverseChild,registered_station_id:station,additional_station_id:extra,provider_id:provider,provider_member_id:'REV',effective_from:'2026-10-01',concurrent_from:'2026-10-01',existing_mapping_id:reverseAnchor,existing_station_id:station,new_mapping_id:reverseChild};
   await db.query("insert into workforce_joining_events(company_id,workforce_id,event_code,details) values($1,$2,'provider_mapping_location_kept',$3)",[company,reverseWorker,details]);
   await db.exec('commit');
   // Historical reverse proof continues to refer to its original anchor.
   await db.query("update field_executive_provider_mappings set status='closed',effective_to='2026-10-31' where id=$1",[reverseChild]);
   await assert.rejects(db.query("update field_executive_provider_mappings set effective_from='2026-10-22' where id=$1",[id(33)]),/registered-location mapping/);
   // A row without the exact audited proof cannot borrow this exception.
   await assert.rejects(db.query('insert into field_executive_provider_mappings select * from jsonb_populate_record(null::field_executive_provider_mappings,$1)',[JSON.stringify({...period('2026-09-01',null,10,otherStation),id:id(34),workforce_id:reverseWorker,provider_member_id:'REV'})]),/registered-location mapping/);
 });
 } finally { await db.close(); }
});
