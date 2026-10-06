import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const migration = readFileSync(
  new URL("../supabase/migrations/20261005223000_workforce_payout_input_freshness.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const deductionUploadMigration = readFileSync(
  new URL("../supabase/migrations/20261006041500_workforce_payout_deduction_upload.sql", import.meta.url),
  "utf8"
)
  .replace(/create extension if not exists btree_gist\s*;/gi, "")
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const attendanceValuesMigration = readFileSync(
  new URL("../supabase/migrations/20261006153000_workforce_payout_attendance_values.sql", import.meta.url),
  "utf8"
)
  .replace(/create extension if not exists btree_gist\s*;/gi, "")
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

assert.match(migration, /payout_input_snapshot_hash/i);
assert.match(migration, /lower\(coalesce\(payroll_run\.status, ''\)\) in \('approved', 'paid'\)/i);
assert.doesNotMatch(migration, /lower\(coalesce\(payroll_run\.status, ''\)\) in \('review', 'under_review'/i);
assert.doesNotMatch(migration, /lock table public\.workforce_payout_/i);
assert.match(deductionUploadMigration, /from public\.workforce_payout_deduction_values item/i);
assert.match(deductionUploadMigration, /workforce_payout_deduction_values_01_finalized_guard/i);
assert.match(attendanceValuesMigration, /workforce_payout_attendance_values_01_finalized_guard/i);
assert.match(attendanceValuesMigration, /workforce_payout_input_snapshot_hash_without_attendance_values/i);
assert.match(attendanceValuesMigration, /attendance_values/i);

const db = new PGlite({ extensions: { btree_gist } });
await db.exec(`
  create extension if not exists btree_gist;
  create schema auth;
  create role anon;
  create role authenticated;
  create role service_role;
  create table auth.users (id uuid primary key);
  create table public.companies (id uuid primary key);
  create table public.stations (
    id uuid primary key,
    company_id uuid not null,
    unique(company_id,id)
  );
  create table public.workforce (
    id uuid primary key,
    company_id uuid not null,
    dropx_id text,
    location_id uuid,
    date_of_join date,
    last_working_date date,
    is_active boolean not null default true,
    deleted_at timestamptz,
    migration_state text,
    source_profile_type text,
    source_profile_id uuid,
    unique(company_id,id)
  );
  create table public.workforce_deduction_heads (
    id uuid primary key,
    company_id uuid not null,
    code text not null,
    name text not null,
    calculation_type text not null,
    is_system boolean not null default false,
    is_active boolean not null default true
  );
  create table public.workforce_payroll_runs (
    id uuid primary key,
    company_id uuid not null,
    period_start date not null,
    period_end date not null,
    status text not null,
    calculated_at timestamptz
  );
  create table public.workforce_payout_attendance_overrides (
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid not null,
    work_date date not null,
    attendance_status text not null,
    work_day_units numeric not null,
    work_minutes integer,
    updated_at timestamptz not null default now()
  );
  create table public.workforce_payment_field_overrides (
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid not null,
    payment_field_id uuid not null,
    field_code_snapshot text not null,
    effective_from date not null,
    effective_to date not null,
    input_value numeric not null,
    updated_at timestamptz not null default now()
  );
  create table public.workforce_custom_production_inputs (
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid not null,
    payment_field_id uuid not null,
    field_code_snapshot text not null,
    work_date date not null,
    units numeric not null,
    updated_at timestamptz not null default now()
  );
  create table public.workforce_additional_payment_values (
    id uuid primary key,
    company_id uuid not null,
    additional_payment_field_id uuid not null,
    workforce_id uuid not null,
    station_id uuid,
    field_code_snapshot text not null,
    field_name_snapshot text not null,
    calculation_type_snapshot text not null,
    effective_from date not null,
    effective_to date not null,
    input_value numeric not null,
    rate_value numeric,
    final_amount numeric not null,
    updated_at timestamptz not null default now()
  );
  create table public.workforce_payout_import_batches (
    id uuid primary key,
    company_id uuid not null,
    effective_from date not null,
    effective_to date not null,
    file_name text not null,
    file_sha256 text not null,
    status text not null,
    row_count integer not null,
    created_by uuid,
    created_at timestamptz not null default now(),
    committed_at timestamptz
  );
  create table public.workforce_payout_import_rows (
    id uuid primary key,
    batch_id uuid not null,
    company_id uuid not null,
    row_number integer not null,
    action text not null,
    workforce_id uuid not null,
    dropx_id_snapshot text not null,
    station_id uuid not null,
    input_type text not null,
    payment_field_id uuid,
    additional_payment_field_id uuid,
    field_code_snapshot text,
    effective_from date not null,
    effective_to date not null,
    numeric_value numeric,
    text_value text,
    work_minutes integer,
    remark text,
    raw_payload jsonb not null default '{}'::jsonb,
    constraint workforce_payout_import_rows_input_type_check
      check (input_type in ('ATTENDANCE','PRODUCTION_UNITS','PAYMENT_FIELD_VALUE','ADDITIONAL_PAYMENT')),
    constraint workforce_payout_import_rows_value_shape_check
      check ((action='CLEAR' and numeric_value is null and text_value is null and work_minutes is null)
        or (action='UPSERT' and ((input_type='ATTENDANCE' and text_value in ('P','HD','A') and numeric_value is null)
          or (input_type<>'ATTENDANCE' and numeric_value is not null and numeric_value>=0 and text_value is null)))),
    constraint workforce_payout_import_rows_field_shape_check
      check ((input_type='ATTENDANCE' and payment_field_id is null and additional_payment_field_id is null)
        or (input_type in ('PRODUCTION_UNITS','PAYMENT_FIELD_VALUE') and payment_field_id is not null and additional_payment_field_id is null)
        or (input_type='ADDITIONAL_PAYMENT' and payment_field_id is null and additional_payment_field_id is not null))
  );
  create or replace function public.workforce_additional_payment_location_is_authorized(
    p_company_id uuid,
    p_workforce_id uuid,
    p_station_id uuid,
    p_effective_from date,
    p_effective_to date
  ) returns boolean language sql stable security definer set search_path='' as $$
    select true
  $$;
  create or replace function public.workforce_apply_payout_import(
    p_company_id uuid,
    p_effective_from date,
    p_effective_to date,
    p_file_name text,
    p_file_sha256 text,
    p_rows jsonb,
    p_actor_user_id uuid,
    p_allowed_location_ids uuid[] default null
  ) returns uuid language plpgsql security definer set search_path='' as $$
  begin
    /* Verifier stub marker retained so the follow-up migration can exercise
       its compatibility patch against the production importer definition.
       if v_input_type = 'PRODUCTION_UNITS'
        and not (v_payment_field.field_type = 'production' and v_payment_field.is_custom_production) then
        raise exception 'Row % field is not configured for custom production units.', v_row_number;
      end if; */
    return gen_random_uuid();
  end $$;
  create or replace function public.lock_workforce_payment_allocation_company(p_company_id uuid)
  returns void language plpgsql security definer set search_path='' as $$
  begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'workforce-payment-allocation-company:' || p_company_id::text, 0
    ));
  end $$;
  ${migration}
  ${deductionUploadMigration}
  ${attendanceValuesMigration}
`);

const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const company = id(1);
const worker = id(2);
const station = id(3);
const run = id(4);
const user = id(8);
const manualDeductionHead = id(9);
const batch = id(20);
const importRow = id(21);
const attendanceImportRow = id(23);
const attendanceValue = id(24);
await db.query("insert into auth.users(id) values ($1)", [user]);
await db.query("insert into public.companies(id) values ($1)", [company]);
await db.query("insert into public.stations(id,company_id) values ($1,$2)", [station, company]);
await db.query("insert into public.workforce(id,company_id,dropx_id,location_id) values ($1,$2,'DX1001',$3)", [worker, company, station]);
await db.query(`insert into public.workforce_deduction_heads
  (id,company_id,code,name,calculation_type,is_active)
  values ($1,$2,'LOAN_RECOVERY','Loan recovery','manual',true)`, [manualDeductionHead, company]);

for (const [suffix, status] of [[5, "review"], [6, "approved"], [7, "paid"]]) {
  await assert.rejects(
    db.query(`insert into public.workforce_payroll_runs
      (id,company_id,period_start,period_end,status,calculated_at)
      values ($1,$2,'2026-08-01','2026-08-31',$3,now())`, [id(suffix), company, status]),
    /must be created in draft status/i
  );
}

await db.query(`insert into public.workforce_payroll_runs
  (id,company_id,period_start,period_end,status,calculated_at)
  values ($1,$2,'2026-09-01','2026-09-30','draft',now())`, [run, company]);

const capturedEmpty = await db.query("select payout_input_snapshot_hash from public.workforce_payroll_runs where id=$1", [run]);
assert.match(capturedEmpty.rows[0].payout_input_snapshot_hash, /^[a-f0-9]{32}$/);

await db.query(`insert into public.workforce_payout_attendance_overrides
  (id,company_id,workforce_id,station_id,work_date,attendance_status,work_day_units,work_minutes)
  values ($1,$2,$3,$4,'2026-09-05','P',1,480)`, [id(10), company, worker, station]);
await assert.rejects(
  db.query("update public.workforce_payroll_runs set status='review' where id=$1", [run]),
  /inputs changed after this payroll was calculated/i
);

await db.query("update public.workforce_payroll_runs set calculated_at=clock_timestamp() where id=$1", [run]);
await db.query("update public.workforce_payroll_runs set status='review' where id=$1", [run]);

// Review is deliberately non-locking. A subsequent change invalidates the
// calculation hash and is caught before approval.
await db.query("update public.workforce_payout_attendance_overrides set work_minutes=420 where id=$1", [id(10)]);
await db.query(`insert into public.workforce_payout_import_batches
  (id,company_id,effective_from,effective_to,file_name,file_sha256,status,row_count,created_by,committed_at)
  values ($1,$2,'2026-09-01','2026-09-30','deductions.xlsx',$3,'committed',1,$4,now())`,
  [batch, company, "b".repeat(64), user]);
await db.query(`insert into public.workforce_payout_import_rows
  (id,batch_id,company_id,row_number,action,workforce_id,dropx_id_snapshot,station_id,input_type,
   payment_field_id,additional_payment_field_id,deduction_head_id,field_code_snapshot,effective_from,effective_to,
   numeric_value,text_value,work_minutes,raw_payload)
  values ($1,$2,$3,2,'UPSERT',$4,'DX1001',$5,'DEDUCTION',null,null,$6,'LOAN_RECOVERY',
    '2026-09-01','2026-09-30',300,null,null,'{}')`,
  [importRow, batch, company, worker, station, manualDeductionHead]);
await db.query(`insert into public.workforce_payout_deduction_values
  (id,company_id,deduction_head_id,workforce_id,station_id,head_code_snapshot,head_name_snapshot,
   effective_from,effective_to,amount,source_batch_id,source_row_id,created_by,updated_by)
  values ($1,$2,$3,$4,$5,'ignored','ignored','2026-09-01','2026-09-30',300,$6,$7,$8,$8)`,
  [id(22), company, manualDeductionHead, worker, station, batch, importRow, user]);
await assert.rejects(
  db.query("update public.workforce_payroll_runs set status='approved' where id=$1", [run]),
  /inputs changed after this payroll was calculated/i
);

await db.query("update public.workforce_payroll_runs set calculated_at=clock_timestamp() where id=$1", [run]);
await db.query(`insert into public.workforce_payout_import_rows
  (id,batch_id,company_id,row_number,action,workforce_id,dropx_id_snapshot,station_id,input_type,
   payment_field_id,additional_payment_field_id,deduction_head_id,field_code_snapshot,effective_from,effective_to,
   numeric_value,text_value,work_minutes,raw_payload)
  values ($1,$2,$3,3,'UPSERT',$4,'DX1001',$5,'ATTENDANCE',null,null,null,'WORK_HOURS',
    '2026-09-01','2026-09-30',30,null,null,'{}')`,
  [attendanceImportRow, batch, company, worker, station]);
await db.query(`insert into public.workforce_payout_attendance_values
  (id,company_id,workforce_id,station_id,attendance_basis,effective_from,effective_to,quantity,
   source_batch_id,source_row_id,created_by,updated_by)
  values ($1,$2,$3,$4,'hours','2026-09-01','2026-09-30',30,$5,$6,$7,$7)`,
  [attendanceValue, company, worker, station, batch, attendanceImportRow, user]);
await assert.rejects(
  db.query("update public.workforce_payroll_runs set status='approved' where id=$1", [run]),
  /inputs changed after this payroll was calculated/i,
  "aggregate attendance ranges participate in the payroll input snapshot"
);

await db.query("update public.workforce_payroll_runs set calculated_at=clock_timestamp() where id=$1", [run]);
await db.query("update public.workforce_payroll_runs set status='approved' where id=$1", [run]);
await assert.rejects(
  db.query("update public.workforce_payroll_runs set status='draft' where id=$1", [run]),
  /cannot be downgraded or reopened/i
);
await db.query("update public.workforce_payroll_runs set status='paid' where id=$1", [run]);
await assert.rejects(
  db.query("update public.workforce_payroll_runs set status='approved' where id=$1", [run]),
  /cannot be downgraded or reopened/i
);
await assert.rejects(
  db.query("delete from public.workforce_payroll_runs where id=$1", [run]),
  /cannot be deleted or reopened/i
);
await assert.rejects(
  db.query("update public.workforce_payroll_runs set period_start='2026-10-01',period_end='2026-10-31' where id=$1", [run]),
  /cannot be moved or reassigned/i
);
await assert.rejects(
  db.query("update public.workforce_payout_attendance_overrides set work_minutes=400 where id=$1", [id(10)]),
  /approved or paid/i
);
await assert.rejects(
  db.query("update public.workforce_payout_deduction_values set amount=350 where id=$1", [id(22)]),
  /approved or paid/i
);
await assert.rejects(
  db.query("update public.workforce_payout_attendance_values set quantity=35 where id=$1", [attendanceValue]),
  /approved or paid/i
);

console.log("Workforce payout input freshness verification passed.");
