import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create table public.companies (id uuid primary key);
  create table public.workforce_payroll_runs (
    id uuid primary key,
    company_id uuid not null references public.companies(id),
    period_start date not null,
    period_end date not null,
    status text not null
  );
  insert into public.companies(id) values ('43866344-b550-4e8a-9a2d-9d23f3d8a997');
`);

const migration = readFileSync(
  new URL("../supabase/migrations/20260929150000_workforce_payment_settings.sql", import.meta.url),
  "utf8"
);
await db.exec(migration);

const { rows: [clock] } = await db.query(`
  with months as (
    select date_trunc('month', timezone('Asia/Kolkata', now()))::date as current_month
  )
  select
    to_char(current_month, 'YYYY-MM-DD') as current_month,
    to_char(current_month + interval '1 month', 'YYYY-MM-DD') as next_month,
    to_char(current_month + interval '2 months', 'YYYY-MM-DD') as second_month,
    to_char(current_month + interval '3 months', 'YYYY-MM-DD') as third_month,
    to_char(current_month + interval '25 months', 'YYYY-MM-DD') as beyond_limit,
    to_char(current_month + interval '2 months - 1 day', 'YYYY-MM-DD') as next_month_end
  from months;
`);

const insertPolicy = (values = `'fixed_paid_offs',4,6,true,'${clock.next_month}','Adopt four paid offs'`) => db.exec(`
  insert into public.workforce_payment_settings(
    company_id,calculation_method,paid_off_days,work_units_per_paid_off,
    cap_at_monthly_amount,effective_from,change_reason
  ) values ('43866344-b550-4e8a-9a2d-9d23f3d8a997',${values});
`);

await insertPolicy();
await assert.rejects(() => insertPolicy(`'unknown',4,6,true,'${clock.second_month}','Invalid method'`));
await assert.rejects(() => insertPolicy(`'earned_paid_offs',4,6.25,true,'${clock.second_month}','Invalid unit step'`));
await assert.rejects(() => insertPolicy(`'earned_paid_offs',4,6,true,'${clock.second_month.slice(0, 8)}02','Invalid month start'`));
await assert.rejects(() => insertPolicy(`'earned_paid_offs',4,6,true,'${clock.second_month}','x'`));
await assert.rejects(
  () => insertPolicy(`'calendar_days',4,6,true,'${clock.current_month}','Attempt active month'`),
  /next month through 24 months/i
);
await assert.rejects(
  () => insertPolicy(`'calendar_days',4,6,true,'${clock.beyond_limit}','Attempt distant month'`),
  /next month through 24 months/i
);

await insertPolicy(`'earned_paid_offs',4,6,true,'${clock.second_month}','Schedule second month'`);
await assert.rejects(() => db.exec(`
  update public.workforce_payment_settings
  set effective_from='${clock.current_month}',change_reason='Attempt move into active month'
  where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and effective_from='${clock.second_month}';
`), /next month through 24 months/i);

await db.exec(`
  insert into public.workforce_payroll_runs(id,company_id,period_start,period_end,status)
  values (
    '00000000-0000-4000-8000-000000000001',
    '43866344-b550-4e8a-9a2d-9d23f3d8a997',
    '${clock.next_month}','${clock.next_month_end}','approved'
  );
`);
await assert.rejects(() => db.exec(`
  update public.workforce_payment_settings
  set paid_off_days=5,change_reason='Attempt closed-month change'
  where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and effective_from='${clock.next_month}';
`), /cannot change after payroll/i);
await assert.rejects(() => db.exec(`
  update public.workforce_payment_settings
  set effective_from='${clock.third_month}',change_reason='Attempt move out of protected month'
  where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and effective_from='${clock.next_month}';
`), /cannot change after payroll/i);
await assert.rejects(() => db.exec(`
  delete from public.workforce_payment_settings
  where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' and effective_from='${clock.next_month}';
`), /cannot change after payroll/i);

const { rows: security } = await db.query(`
  select
    (select relrowsecurity from pg_class where oid='public.workforce_payment_settings'::regclass) as rls_enabled,
    has_table_privilege('anon','public.workforce_payment_settings','select') as anon_select,
    has_table_privilege('authenticated','public.workforce_payment_settings','select') as authenticated_select,
    has_table_privilege('service_role','public.workforce_payment_settings','select') as service_select,
    has_table_privilege('service_role','public.workforce_payment_settings','insert') as service_insert,
    has_table_privilege('service_role','public.workforce_payment_settings','update') as service_update;
`);
assert.deepEqual(security[0], {
  rls_enabled: true,
  anon_select: false,
  authenticated_select: false,
  service_select: true,
  service_insert: true,
  service_update: true
});

console.log("Workforce payment settings schema, future-month lock, finalized-run guard and service-only access verified.");
