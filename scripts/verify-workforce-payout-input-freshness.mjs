import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../supabase/migrations/20261005223000_workforce_payout_input_freshness.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

assert.match(migration, /payout_input_snapshot_hash/i);
assert.match(migration, /lower\(coalesce\(payroll_run\.status, ''\)\) in \('approved', 'paid'\)/i);
assert.doesNotMatch(migration, /lower\(coalesce\(payroll_run\.status, ''\)\) in \('review', 'under_review'/i);
assert.doesNotMatch(migration, /lock table public\.workforce_payout_/i);

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table public.workforce (
    id uuid primary key,
    company_id uuid not null,
    unique(company_id,id)
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
  create or replace function public.lock_workforce_payment_allocation_company(p_company_id uuid)
  returns void language plpgsql security definer set search_path='' as $$
  begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'workforce-payment-allocation-company:' || p_company_id::text, 0
    ));
  end $$;
  ${migration}
`);

const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const company = id(1);
const worker = id(2);
const station = id(3);
const run = id(4);
await db.query("insert into public.workforce(id,company_id) values ($1,$2)", [worker, company]);

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
await assert.rejects(
  db.query("update public.workforce_payroll_runs set status='approved' where id=$1", [run]),
  /inputs changed after this payroll was calculated/i
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

console.log("Workforce payout input freshness verification passed.");
