import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL(
  "../supabase/migrations/20261011190000_transactional_biometric_enrolment_assignment.sql",
  import.meta.url
), "utf8").replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

const company = "10000000-0000-4000-8000-000000000001";
const stationA = "20000000-0000-4000-8000-000000000001";
const stationB = "20000000-0000-4000-8000-000000000002";
const employeeA = "30000000-0000-4000-8000-000000000001";
const employeeB = "30000000-0000-4000-8000-000000000002";
const helper = "40000000-0000-4000-8000-000000000001";

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create table public.companies(id uuid primary key);
  create table public.stations(
    id uuid primary key, company_id uuid not null, unique(company_id, id)
  );
  create table public.employees(
    id uuid primary key, company_id uuid not null, biometric_id text,
    location_id uuid, is_active boolean, date_of_join date
  );
  create table public.workforce(
    id uuid primary key, company_id uuid not null, biometric_id text,
    location_id uuid, is_active boolean, date_of_join date
  );
  create table public.contractors(
    id uuid primary key, company_id uuid not null, biometric_id text,
    location_id uuid, is_active boolean, date_of_join date
  );
  create table public.vendors(
    id uuid primary key, company_id uuid not null, biometric_id text,
    location_id uuid, is_active boolean, date_of_join date
  );
  create table public.helpers(
    id uuid primary key, company_id uuid not null, biometric_id text,
    location_id uuid, is_active boolean, date_of_join date
  );
  create table public.workforce_helpers(
    id uuid primary key, company_id uuid not null, biometric_id text,
    location_id uuid, is_active boolean, date_of_join date
  );
  create table public.workforce_pickers(
    id uuid primary key, company_id uuid not null, biometric_id text,
    location_id uuid, is_active boolean, date_of_join date
  );
  create table public.biometric_enrolments(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    enrolment_id text not null,
    worker_type text not null,
    employee_id uuid,
    field_executive_id uuid,
    profile_type text,
    account_id uuid,
    location_id uuid,
    status text not null default 'Active',
    effective_from date not null default current_date,
    effective_to date,
    notes text,
    created_by uuid,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    constraint biometric_enrolments_one_person_check check (
      (worker_type = 'employee' and employee_id is not null and field_executive_id is null)
      or (worker_type = 'individual_contract' and field_executive_id is not null and employee_id is null)
    )
  );
  create unique index biometric_enrolments_company_enrolment_active_uidx
    on public.biometric_enrolments(company_id, enrolment_id)
    where effective_to is null and status = 'Active';
  create table public.helper_payout_payment_items(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    helper_id uuid not null, period_start date not null, period_end date not null,
    status text not null
  );
  create or replace function public.normalize_people_biometric_id(p_value text)
  returns text language sql immutable parallel safe returns null on null input
  set search_path = '' as $$
    select case
      when nullif(pg_catalog.btrim(p_value), '') is null then null
      when pg_catalog.btrim(p_value) ~ '^[0-9]{1,20}$'
        then coalesce(nullif(pg_catalog.ltrim(pg_catalog.btrim(p_value), '0'), ''), '0')
      else null
    end
  $$;
  create or replace function public.lock_workforce_payment_allocation_company(p_company_id uuid)
  returns void language plpgsql set search_path = '' as $$ begin return; end $$;
`);

await db.exec(migration);
await db.exec(`
  create trigger biometric_enrolments_helper_processing_insert
  after insert on public.biometric_enrolments
  referencing new table as helper_processing_new_rows
  for each statement execute function public.guard_helper_payout_period_source_processing(
    'company_id', 'effective_from', 'effective_to'
  );
  create trigger biometric_enrolments_helper_processing_update
  after update on public.biometric_enrolments
  referencing old table as helper_processing_old_rows new table as helper_processing_new_rows
  for each statement execute function public.guard_helper_payout_period_source_processing(
    'company_id', 'effective_from', 'effective_to'
  );
  create trigger biometric_enrolments_helper_processing_delete
  after delete on public.biometric_enrolments
  referencing old table as helper_processing_old_rows
  for each statement execute function public.guard_helper_payout_period_source_processing(
    'company_id', 'effective_from', 'effective_to'
  );
`);
await db.query(`insert into public.companies(id) values ($1)`, [company]);
await db.query(`insert into public.stations(id,company_id) values ($1,$3),($2,$3)`, [stationA, stationB, company]);
await db.query(`
  insert into public.employees(id,company_id,biometric_id,location_id,is_active,date_of_join)
  values
    ($1,$3,'00123',$4,true,current_date - 40),
    ($2,$3,'999',$4,true,current_date - 40)
`, [employeeA, employeeB, company, stationA]);
await db.query(`
  insert into public.helpers(id,company_id,biometric_id,location_id,is_active,date_of_join)
  values ($1,$2,'123',$3,false,current_date - 39)
`, [helper, company, stationA]);

const sync = (profileType, accountId) => db.query(
  `select * from public.replace_biometric_enrolment_assignment($1,null,$2,$3,$4)`,
  [company, profileType, accountId, stationA]
);

await sync("employee", employeeA);
await sync("worker", helper);
let current = await db.query(`
  select profile_type, account_id, enrolment_id, location_id
  from public.biometric_enrolments where effective_to is null order by profile_type
`);
assert.equal(current.rows.length, 2, "cross-category owners must remain mapped");
assert.deepEqual(current.rows.map((row) => row.enrolment_id), ["123", "123"]);

await db.query(`update public.employees set location_id=$1 where id=$2`, [stationB, employeeA]);
await sync("employee", employeeA);
current = await db.query(`
  select profile_type, account_id, location_id
  from public.biometric_enrolments where effective_to is null order by profile_type
`);
assert.equal(current.rows.length, 2, "a location transfer must not close the Helper owner");
assert.equal(current.rows.find((row) => row.profile_type === "employee").location_id, stationB);
assert.equal(current.rows.find((row) => row.profile_type === "worker").location_id, stationA);

await sync("employee", employeeB);
await db.query(`update public.employees set biometric_id='123' where id=$1`, [employeeB]);
await assert.rejects(sync("employee", employeeB), /already assigned to another worker/i);
const originalEmployeeB = await db.query(`
  select enrolment_id from public.biometric_enrolments
  where profile_type='employee' and account_id=$1 and effective_to is null
`, [employeeB]);
assert.equal(originalEmployeeB.rows[0]?.enrolment_id, "999", "a failed replacement must roll its close back");

await db.query(`update public.employees set biometric_id='ABC123' where id=$1`, [employeeB]);
await assert.rejects(sync("employee", employeeB), /1 to 20 digits only/i);

await db.query(`update public.helpers set biometric_id=null where id=$1`, [helper]);
await sync("worker", helper);
current = await db.query(`select profile_type, account_id from public.biometric_enrolments where effective_to is null order by account_id`);
assert.deepEqual(current.rows, [
  { profile_type: "employee", account_id: employeeA },
  { profile_type: "employee", account_id: employeeB }
], "clearing the Helper must retain both Employee assignments");

await db.query(`
  insert into public.helper_payout_payment_items(
    company_id, helper_id, period_start, period_end, status
  ) values (
    $1, $2, date_trunc('month', current_date)::date,
    (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
    'processing'
  )
`, [company, helper]);
await db.query(`
  update public.biometric_enrolments set notes='unrelated employee edit'
  where account_id=$1 and effective_to is null
`, [employeeB]);
await assert.rejects(db.query(`
  update public.biometric_enrolments set notes='shared Helper ID edit'
  where account_id=$1 and effective_to is null
`, [employeeA]), /overlapping Helper payment is Processing/i);

console.log("Transactional biometric enrolment assignment verified.");
await db.close();
