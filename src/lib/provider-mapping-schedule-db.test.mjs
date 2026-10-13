import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const migration=async name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
test('payment plans save atomically, preserve payroll locks and reject concurrent edits',async()=>{
 const db=new PGlite();
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
 await db.query('insert into workforce(id,company_id,location_id) values($1,$2,$3)',[worker,company,station]);
 await db.query('insert into stations(id,company_id,provider_id) values($1,$2,$3)',[station,company,provider]);
 const period=(from,to,rate)=>({company_id:company,workforce_id:worker,provider_id:provider,station_id:station,provider_member_id:'111',effective_from:from,effective_to:to,payment_method_id:method,payment_values:{DELIVERY:rate},status:to?'closed':'active',pay_type:'PER_PACKET'});
 const versions=async()=>(await db.query('select id,updated_at from field_executive_provider_mappings where status <> $1',['cancelled'])).rows;
 const call=async(plan,expected,locations=null)=>db.query('select workforce_save_mapping_schedule($1,$2,$3,$4,$5::jsonb,$6::uuid[],$7,$8::jsonb) as records',[company,actor,worker,'DX1',JSON.stringify(plan),locations,'Real Reviewer',JSON.stringify(expected ?? await versions())]);
 const plan=[period('2026-10-01','2026-10-31',10),period('2026-11-01',null,12)];
 const result=await call(plan);
 assert.equal(result.rows[0].records.length,2);
 assert.equal(result.rows[0].records[0].effective_to,'2026-10-31');
 assert.equal(result.rows[0].records[1].payment_values.DELIVERY,12);
 assert.equal((await db.query('select count(*)::int n from workforce_joining_events')).rows[0].n,2);
 const before=await db.query('select * from field_executive_provider_mappings order by effective_from');
 // Reject whole plan when a later row overlaps another period; earlier row changes roll back.
 const overlap=[period('2026-10-01','2026-10-15',7),period('2026-10-16',null,8)];
 await assert.rejects(call(overlap),/overlapping/);
 assert.deepEqual((await db.query('select * from field_executive_provider_mappings order by effective_from')).rows,before.rows);
 await assert.rejects(call(plan,[]),/changed while/);
 await assert.rejects(call(plan,await versions(),[id(99)]),/station scope/);
 await assert.rejects(call([plan[0],period('2026-11-02',null,5)]),/adjacent/);
 // A plan with an approved November payout cannot alter that period or retain the first edit.
 await db.query('insert into workforce_payroll_runs values($1,$2,$3,$4,$5)',[id(7),company,'2026-11-01','2026-11-30','approved']);
 await db.query('insert into workforce_payroll_items values($1,$2,$3,$4)',[company,worker,id(7),'included']);
 await assert.rejects(call([period('2026-10-01','2026-10-31',8),period('2026-11-01',null,9)]),/locked period/);
 assert.deepEqual((await db.query('select * from field_executive_provider_mappings order by effective_from')).rows,before.rows);
 assert.equal((await db.query('select count(*)::int n from workforce_joining_events')).rows[0].n,2);
 } finally {await db.close();}
});
