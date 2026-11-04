import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { providerFirstHistoricalLocationIsAllowed, providerFirstLocationIsAllowed, providerFirstMappingReferenceForRow } from './provider-first-mapping-view.ts';
const migration = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8');
const id = n => '83000000-0000-4000-8000-' + String(n).padStart(12, '0');
const company=id(1), worker=id(2), station=id(3), provider=id(4), actor=id(5), method=id(6), otherStation=id(7);

test('historical location writes preserve current station, later rates, and all integrity guards', async () => {
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
 await db.exec(`create table payment_methods(id uuid,company_id uuid,code text,is_active boolean);`);
 const financial = await migration('20261005160446_provider_mapping_finalized_payout_period_guard.sql');
 await db.exec(financial.slice(financial.indexOf('create or replace function public.workforce_joining_mapping_guard()'), financial.indexOf('create or replace function public.workforce_replace_joining_mapping(')));
 await db.exec(`create trigger historical_financial_guard before insert or update on field_executive_provider_mappings for each row execute function workforce_joining_mapping_guard();`);
 for(const file of ['20261012220000_provider_mapping_registered_location_exception.sql','20261016100000_provider_mapping_contiguous_coverage_final.sql','20261021103000_provider_mapping_registered_anchor_legacy_keep.sql','20261104153000_historical_exclusive_location_mapping.sql']) await db.exec(await migration(file));
 await db.exec(await migration('20261104153000_historical_exclusive_location_mapping.sql'));
 await db.query(`insert into workforce(id,company_id,location_id,dropx_id) values($1,$2,$3,'DX-HISTORY')`,[worker,company,station]);
 await db.query(`insert into stations values($1,$2,$3),($4,$2,$3)`,[station,company,provider,otherStation]);
 await db.query(`insert into payment_methods values($1,$2,'MG_PER_DAY',true)`,[method,company]);
 await db.query(`insert into field_executive_provider_mappings(company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from,status,payment_values) values($1,$2,$3,$4,'2000079389150','2026-10-31','active','{"DELIVERY":16}')`,[company,worker,provider,station]);
 const payload={provider_id:provider,station_id:otherStation,provider_member_id:'2000079389150',effective_from:'2026-10-11',effective_to:'2026-10-31',payment_method_id:method,payment_values:{MG_PER_DAY:1000},production_threshold_config:{enabled:false},pay_type:'MG_PER_DAY',status:'closed'};
 const save=(patch={},scope=null,owner=worker) => db.query(`select workforce_save_historical_location_mapping($1,$2,$3,$4::jsonb,$5::uuid[]) as id`,[company,actor,owner,JSON.stringify({...payload,...patch}),scope]);
 // Original case: a one-day overlap must not be silently overwritten.
 await assert.rejects(save(),/without another mapping/);
 await db.query(`update field_executive_provider_mappings set effective_from='2026-11-01' where workforce_id=$1`,[worker]);
 await assert.rejects(save({},[otherStation]),/station scope/);
 await assert.rejects(save({provider_member_id:'wrong-member'}),/without another mapping/);
 await assert.rejects(save({provider_id:id(98)}),/Provider and station/);
 await assert.rejects(save({effective_to:null}),/completed date range/);
 await assert.rejects(save({effective_from:'2099-01-01',effective_to:'2099-01-31'}),/completed date range/);
 await assert.rejects(save({effective_from:'2026-10-31',effective_to:'2026-10-11'}),/completed date range/);
 await db.query(`update workforce set lifecycle_status='offboarded' where id=$1`,[worker]);
 await assert.rejects(save(),/inactive/);
 await db.query(`update workforce set lifecycle_status='active' where id=$1`,[worker]);
 // A financially approved month still refuses the new historical assignment.
 await db.query(`insert into workforce_payroll_runs values($1,$2,'2026-10-01','2026-10-31','approved')`,[id(20),company]);
 await db.query(`insert into workforce_payroll_items values($1,$2,$3,'included')`,[company,worker,id(20)]);
 await assert.rejects(save(),/approved|paid|finalized|locked/i);
 await db.exec(`delete from workforce_payroll_items; delete from workforce_payroll_runs;`);
 const newId=(await save({},[station,otherStation])).rows[0].id;
 assert.ok(newId);
 await assert.rejects(db.query(`update field_executive_provider_mappings set effective_from='2026-10-31' where status='active'`),/overlaps an exclusive/);
 await assert.rejects(db.query(`update field_executive_provider_mappings set effective_to='2026-11-01' where id=$1`,[newId]),/overlaps an exclusive/);
 await db.query(`update field_executive_provider_mappings set payment_values='{"MG_PER_DAY":1100}' where id=$1`,[newId]);

 assert.equal((await db.query('select location_id from workforce where id=$1',[worker])).rows[0].location_id,station);
 const later=(await db.query(`select effective_from::text,payment_values from field_executive_provider_mappings where status='active'`)).rows[0];
 assert.deepEqual(later,{effective_from:'2026-11-01',payment_values:{DELIVERY:16}});
 assert.equal((await db.query(`select count(*)::int n from workforce_joining_events where event_code='provider_mapping_historical_location_saved'`)).rows[0].n,1);
 await assert.rejects(save(),/without another mapping/);
 // Same Provider ID cannot be assigned to a different person over these days.
 await db.query(`insert into workforce(id,company_id,location_id) values($1,$2,$3)`,[id(40),company,station]);
 await db.query(`insert into field_executive_provider_mappings(company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from,effective_to,status) values($1,$2,$3,$4,'2000079389150','2025-01-01','2025-01-31','closed')`,[company,id(40),provider,station]);
 await assert.rejects(save({},null,id(40)),/without another mapping/);
 assert.equal((await db.query(`select has_function_privilege('authenticated','workforce_save_historical_location_mapping(uuid,uuid,uuid,jsonb,uuid[])','execute') allowed`)).rows[0].allowed,false);
 } finally { await db.close(); }
});

const current = {mappingId:'current', stationId:'kgqa', providerId:'amazon',mappedProviderMemberId:'2000079389150',effectiveFrom:'2026-11-01',effectiveTo:'',status:'active'};
const person = {id:'worker', profileStationId:'kgqa', mappingHistory:[current],currentMappings:[current],registeredLocationMappings:[current]};
const row = {workforceId:'worker',stationId:'kgqc',providerId:'amazon',providerMemberId:'2000079389150',mappingId:'',effectiveFrom:'2026-10-11',effectiveTo:'2026-10-31'};
test('worksheet allows only an exclusive completed historical period for a verified identity', () => {
 assert.equal(providerFirstHistoricalLocationIsAllowed(row,person,'2026-11-04'),true);
 assert.equal(providerFirstLocationIsAllowed(row,person),true);
 assert.equal(providerFirstMappingReferenceForRow(row,person),undefined);
 for(const patch of [{effectiveTo:''},{effectiveTo:'2099-01-01'},{effectiveTo:'2026-10-10'},{effectiveFrom:'bad'},{providerMemberId:'unknown'},{workforceId:'other'},{mappingId:'current'}]) assert.equal(providerFirstHistoricalLocationIsAllowed({...row,...patch},person,'2026-11-04'),false,JSON.stringify(patch));
 assert.equal(providerFirstHistoricalLocationIsAllowed(row,{...person,hasRestrictedMapping:true},'2026-11-04'),false);
 assert.equal(providerFirstHistoricalLocationIsAllowed(row,{...person,mappingHistory:[{...current,status:'cancelled'}],currentMappings:[],registeredLocationMappings:[]},'2026-11-04'),false);
 assert.equal(providerFirstHistoricalLocationIsAllowed(row,{...person,mappingHistory:[{...current,effectiveFrom:'2026-10-31'}]},'2026-11-04'),false);
});
