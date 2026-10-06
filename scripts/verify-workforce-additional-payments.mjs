import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const migration = readFileSync(
  new URL("../supabase/migrations/20261005181903_workforce_additional_payment_fields.sql", import.meta.url),
  "utf8"
)
  .replace(/create extension if not exists pgcrypto\s*;/gi, "")
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

const db = new PGlite({ extensions: { btree_gist } });
await db.exec(`
  create schema if not exists auth;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  create table auth.users(id uuid primary key);
  create table public.companies(id uuid primary key);
  create table public.stations(id uuid primary key, company_id uuid not null, station_code text);
  create table public.workforce(
    id uuid primary key,
    company_id uuid not null,
    location_id uuid,
    source_profile_type text,
    source_profile_id uuid
  );
  create table public.field_executive_provider_mappings(
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid,
    employee_id uuid,
    contractor_id uuid,
    field_executive_id uuid,
    station_id uuid,
    status text not null,
    effective_from date not null,
    effective_to date
  );
  create table public.workforce_payment_allocations(
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid,
    status text not null,
    effective_from date not null,
    effective_to date
  );
  create table public.workforce_payroll_runs(
    id uuid primary key,
    company_id uuid not null,
    status text,
    period_start date not null,
    period_end date not null
  );
  create table public.workforce_payroll_items(
    id uuid primary key,
    company_id uuid not null,
    payroll_run_id uuid not null,
    workforce_id uuid not null,
    status text
  );
  ${migration}
`);

const company = "00000000-0000-4000-8000-000000000001";
const actor = "00000000-0000-4000-8000-000000000002";
const station = "00000000-0000-4000-8000-000000000003";
const worker = "00000000-0000-4000-8000-000000000004";
const otherStation = "00000000-0000-4000-8000-000000000005";
const unrelatedStation = "00000000-0000-4000-8000-000000000006";
const directStation = "00000000-0000-4000-8000-000000000007";
await db.query("insert into auth.users(id) values ($1)", [actor]);
await db.query("insert into public.companies(id) values ($1)", [company]);
await db.query("insert into public.stations(id,company_id,station_code) values ($1,$2,'TEST'),($3,$2,'OTHER'),($4,$2,'UNRELATED'),($5,$2,'DIRECT')", [station, company, otherStation, unrelatedStation, directStation]);
await db.query("insert into public.workforce(id,company_id,location_id) values ($1,$2,$3)", [worker, company, station]);
await db.query(`insert into public.field_executive_provider_mappings
  (id,company_id,workforce_id,station_id,status,effective_from)
  values ('00000000-0000-4000-8000-000000000030',$1,$2,$3,'active','2026-01-01')`, [company, worker, station]);

const manual = "00000000-0000-4000-8000-000000000010";
const units = "00000000-0000-4000-8000-000000000011";
await db.query(`
  insert into public.workforce_additional_payment_fields
    (id,company_id,code,name,calculation_type,default_rate_value,created_by,updated_by)
  values
    ($1,$2,'BONUS','Bonus','manual_amount',null,$3,$3),
    ($4,$2,'KM_INCENTIVE','Kilometre incentive','units_x_rate',3,$3,$3)
`, [manual, company, actor, units]);

await assert.rejects(
  db.query(`insert into public.workforce_additional_payment_fields
    (company_id,code,name,calculation_type,default_rate_value)
    values ($1,'BROKEN','Broken','units_x_rate',null)`, [company]),
  /default_rate_check/i
);

await db.query(`
  insert into public.workforce_additional_payment_values
    (company_id,additional_payment_field_id,workforce_id,effective_from,effective_to,input_value,rate_value,final_amount,created_by,updated_by)
  values
    ($1,$2,$3,'2026-09-01','2026-09-30',250,null,0,$4,$4),
    ($1,$5,$3,'2026-09-01','2026-09-30',20,null,0,$4,$4)
`, [company, manual, worker, actor, units]);

await db.query(`update public.workforce_additional_payment_fields
  set name='Kilometre incentive revised', default_rate_value=9, is_active=false
  where id=$1`, [units]);

const calculated = await db.query(`
  select field_code_snapshot,station_code_snapshot,input_value,rate_value,final_amount
  from public.workforce_additional_payment_values
  order by field_code_snapshot
`);
assert.deepEqual(calculated.rows.map((row) => [
  row.field_code_snapshot,
  row.station_code_snapshot,
  Number(row.input_value),
  row.rate_value === null ? null : Number(row.rate_value),
  Number(row.final_amount)
]), [
  ["BONUS", "TEST", 250, null, 250],
  ["KM_INCENTIVE", "TEST", 20, 3, 60]
]);

await assert.rejects(
  db.query(`insert into public.workforce_additional_payment_values
    (company_id,additional_payment_field_id,workforce_id,effective_from,effective_to,input_value,final_amount)
    values ($1,$2,$3,'2026-09-15','2026-10-15',100,0)`, [company, manual, worker]),
  /no_overlap|conflicting key/i
);

const transferCurrentField = "00000000-0000-4000-8000-000000000012";
const transferHistoryField = "00000000-0000-4000-8000-000000000013";
const transferDefaultField = "00000000-0000-4000-8000-000000000014";
const unrelatedField = "00000000-0000-4000-8000-000000000015";
const directHistoryField = "00000000-0000-4000-8000-000000000016";
await db.query(`insert into public.workforce_additional_payment_fields
  (id,company_id,code,name,calculation_type)
  values
    ($1,$5,'TRANSFER_CURRENT','Transfer current','manual_amount'),
    ($2,$5,'TRANSFER_HISTORY','Transfer history','manual_amount'),
    ($3,$5,'TRANSFER_DEFAULT','Transfer default','manual_amount'),
    ($4,$5,'UNRELATED_BONUS','Unrelated bonus','manual_amount')`, [
  transferCurrentField,
  transferHistoryField,
  transferDefaultField,
  unrelatedField,
  company
]);
await db.query(`update public.field_executive_provider_mappings
  set effective_to='2026-09-15'
  where id='00000000-0000-4000-8000-000000000030'`);
await db.query(`insert into public.field_executive_provider_mappings
  (id,company_id,workforce_id,station_id,status,effective_from)
  values ('00000000-0000-4000-8000-000000000031',$1,$2,$3,'active','2026-09-16')`, [company, worker, otherStation]);
await db.query("update public.workforce set location_id=$1 where id=$2", [otherStation, worker]);
await db.query(`insert into public.workforce_additional_payment_values
  (company_id,additional_payment_field_id,workforce_id,station_id,effective_from,effective_to,input_value,final_amount)
  values
    ($1,$2,$3,$4,'2026-09-01','2026-09-30',100,0),
    ($1,$5,$3,$6,'2026-09-01','2026-09-30',110,0),
    ($1,$7,$3,null,'2026-09-01','2026-09-30',120,0)`, [
  company,
  transferCurrentField,
  worker,
  otherStation,
  transferHistoryField,
  station,
  transferDefaultField
]);
const transferLocations = await db.query(`select additional_payment_field_id,station_id
  from public.workforce_additional_payment_values
  where additional_payment_field_id in ($1,$2,$3)
  order by additional_payment_field_id`, [transferCurrentField, transferHistoryField, transferDefaultField]);
assert.deepEqual(transferLocations.rows, [
  { additional_payment_field_id: transferCurrentField, station_id: otherStation },
  { additional_payment_field_id: transferHistoryField, station_id: station },
  { additional_payment_field_id: transferDefaultField, station_id: otherStation }
]);
await assert.rejects(
  db.query(`insert into public.workforce_additional_payment_values
    (company_id,additional_payment_field_id,workforce_id,station_id,effective_from,effective_to,input_value,final_amount)
    values ($1,$2,$3,$4,'2026-09-01','2026-09-30',100,0)`, [company, unrelatedField, worker, unrelatedStation]),
  /current location or an overlapping historical payment location/i
);
await db.query(`insert into public.workforce_additional_payment_fields
  (id,company_id,code,name,calculation_type)
  values ($1,$2,'DIRECT_HISTORY','Direct history','manual_amount')`, [directHistoryField, company]);
await db.query(`insert into public.workforce_payment_allocations
  (id,company_id,workforce_id,station_id,status,effective_from,effective_to)
  values ('00000000-0000-4000-8000-000000000032',$1,$2,$3,'closed','2026-09-10','2026-09-12')`, [company, worker, directStation]);
await db.query(`insert into public.workforce_additional_payment_values
  (company_id,additional_payment_field_id,workforce_id,station_id,effective_from,effective_to,input_value,final_amount)
  values ($1,$2,$3,$4,'2026-09-01','2026-09-30',130,0)`, [company, directHistoryField, worker, directStation]);
const directLocation = await db.query(`select station_id
  from public.workforce_additional_payment_values
  where additional_payment_field_id=$1`, [directHistoryField]);
assert.equal(directLocation.rows[0].station_id, directStation,
  "an overlapping direct setup authorizes the explicit location without a payment method");

const run = "00000000-0000-4000-8000-000000000020";
await db.query(`insert into public.workforce_payroll_runs(id,company_id,status,period_start,period_end)
  values ($1,$2,'approved','2026-10-01','2026-10-31')`, [run, company]);
await assert.rejects(
  db.query(`insert into public.workforce_additional_payment_values
    (company_id,additional_payment_field_id,workforce_id,effective_from,effective_to,input_value,final_amount)
    values ($1,$2,$3,'2026-10-01','2026-10-31',100,0)`, [company, manual, worker]),
  /approved or paid/i
);

const rls = await db.query(`select relrowsecurity from pg_class where oid='public.workforce_additional_payment_values'::regclass`);
assert.equal(rls.rows[0].relrowsecurity, true);

console.log("Workforce additional-payment migration verification passed.");
