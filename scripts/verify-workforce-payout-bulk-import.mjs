import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const migration = readFileSync(
  new URL("../supabase/migrations/20261005181943_workforce_payout_bulk_import.sql", import.meta.url),
  "utf8"
);
const additionalPaymentMigration = readFileSync(
  new URL("../supabase/migrations/20261005181903_workforce_additional_payment_fields.sql", import.meta.url),
  "utf8"
)
  .replace(/create extension if not exists pgcrypto\s*;/gi, "")
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const deductionUploadMigration = readFileSync(
  new URL("../supabase/migrations/20261006041500_workforce_payout_deduction_upload.sql", import.meta.url),
  "utf8"
)
  .replace(/create extension if not exists btree_gist\s*;/gi, "")
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const deductionIndexMigration = readFileSync(
  new URL("../supabase/migrations/20261006043000_workforce_payout_deduction_fk_indexes.sql", import.meta.url),
  "utf8"
);
const attendanceValuesMigration = readFileSync(
  new URL("../supabase/migrations/20261006153000_workforce_payout_attendance_values.sql", import.meta.url),
  "utf8"
)
  .replace(/create extension if not exists btree_gist\s*;/gi, "")
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const apiSource = readFileSync(
  new URL("../src/app/api/payments/workforce-payouts/bulk-upload/route.ts", import.meta.url),
  "utf8"
);
const templateSource = readFileSync(
  new URL("../src/app/api/payments/workforce-payouts/bulk-upload/template/route.ts", import.meta.url),
  "utf8"
);

assert.match(migration, /create table public\.workforce_payout_import_batches/i);
assert.match(migration, /create table public\.workforce_payout_import_rows/i);
assert.match(migration, /create table public\.workforce_payout_attendance_overrides/i);
assert.match(migration, /create table public\.workforce_payment_field_overrides/i);
assert.match(migration, /create table public\.workforce_custom_production_inputs/i);
assert.match(migration, /create or replace function public\.workforce_apply_payout_import/i);
assert.match(migration, /p_allowed_location_ids uuid\[\]/i);
assert.match(migration, /duplicates resolved % input from row %/i);
assert.match(migration, /lower\(coalesce\(payroll_run\.status, ''\)\) in \('approved', 'paid'\)/i);
assert.doesNotMatch(migration, /insert into public\.attendance_daily/i);
assert.doesNotMatch(migration, /insert into public\.cps_shipment_daily/i);
assert.match(apiSource, /currentAdminAccessSurface\(\) === "ops" \? "ops_workforce_payouts" : "workforce_payouts"/);
assert.match(apiSource, /hasPermission\(authorization, pageCode, "edit"\)/);
assert.match(apiSource, /if \(!sameOrigin\(request\)\)/);
assert.match(apiSource, /p_allowed_location_ids:/);
assert.match(templateSource, /hasPermission\(authorization, pageCode, "edit"\)/);
assert.match(deductionUploadMigration, /create table public\.workforce_payout_deduction_values/i);
assert.match(deductionUploadMigration, /calculation_type = 'manual'/i);
assert.match(deductionUploadMigration, /is_system = false/i);
assert.equal([...deductionUploadMigration.matchAll(/and head\.is_system = false/gi)].length, 2,
  "both the table preparation trigger and importer must reject system-managed heads");
assert.match(deductionUploadMigration, /deduction must use the exact selected payout period/i);
assert.match(deductionUploadMigration, /duplicates resolved DEDUCTION input/i);
assert.match(deductionUploadMigration, /workforce_payout_deduction_values_01_finalized_guard/i);
assert.match(deductionUploadMigration, /'deduction'::text/i);
assert.match(attendanceValuesMigration, /create table public\.workforce_payout_attendance_values/i);
assert.match(attendanceValuesMigration, /workforce_payout_attendance_values_no_overlap/i);
assert.match(attendanceValuesMigration, /workforce_payout_attendance_values_single_month_check/i);
assert.match(attendanceValuesMigration, /stay within one calendar month/i);
assert.match(attendanceValuesMigration, /field_code_snapshot in \('WORK_HOURS', 'WORK_DAYS'\)/i);
assert.match(attendanceValuesMigration, /workforce_apply_payout_import_without_attendance_values/i);
assert.match(attendanceValuesMigration, /workforce_payout_attendance_values_01_finalized_guard/i);
assert.match(attendanceValuesMigration, /'attendance_values'/i);
for (const indexName of [
  "workforce_payout_deduction_values_workforce_fk_idx",
  "workforce_payout_deduction_values_source_batch_fk_idx",
  "workforce_payout_deduction_values_source_row_fk_idx",
  "workforce_payout_deduction_values_created_by_fk_idx",
  "workforce_payout_deduction_values_updated_by_fk_idx"
]) {
  assert.match(deductionIndexMigration, new RegExp(`create index if not exists ${indexName}`, "i"));
}

const db = new PGlite({ extensions: { btree_gist } });
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const company = id(1);
const station = id(2);
const otherStation = id(3);
const unrelatedStation = id(15);
const worker = id(4);
const user = id(5);
const method = id(6);
const amountField = id(7);
const productionField = id(8);
const additionalField = id(9);
const manualDeductionHead = id(19);
const fixedDeductionHead = id(20);
const providerProductionField = id(23);
const systemManualDeductionHead = id(25);
const attendanceField = id(26);
const dailyAttendanceField = id(31);
const monthlyAttendanceField = id(32);
const directWorker = id(33);
const directAllocation = id(34);

await db.exec(`
  create schema if not exists auth;
  create role anon;
  create role authenticated;
  create role service_role;
  create table auth.users (id uuid primary key);
  create table public.companies (id uuid primary key);
  create table public.stations (
    id uuid primary key,
    company_id uuid not null references public.companies(id),
    station_code text,
    is_active boolean not null default true,
    unique (company_id, id)
  );
  create table public.workforce (
    id uuid primary key,
    company_id uuid not null references public.companies(id),
    dropx_id text,
    full_name text,
    location_id uuid,
    date_of_join date,
    last_working_date date,
    is_active boolean not null default true,
    deleted_at timestamptz,
    migration_state text,
    source_profile_type text,
    source_profile_id uuid,
    unique (company_id, id)
  );
  create table public.payment_fields (
    id uuid primary key,
    company_id uuid not null references public.companies(id),
    code text not null,
    label text,
    field_type text not null,
    calculation_type text,
    calculation_source text,
    pay_schedule text,
    is_custom_production boolean not null default false,
    is_active boolean not null default true,
    unique (company_id, id)
  );
  create table public.payment_method_components (
    id uuid primary key,
    company_id uuid not null,
    payment_method_id uuid not null,
    payment_field_id uuid not null,
    component_code text not null,
    component_type text,
    pay_schedule text,
    is_active boolean not null default true
  );
  create table public.field_executive_provider_mappings (
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid,
    employee_id uuid,
    contractor_id uuid,
    field_executive_id uuid,
    station_id uuid,
    payment_method_id uuid,
    effective_from date not null,
    effective_to date,
    status text not null
  );
  create table public.workforce_payment_allocations (
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid,
    payment_method_id uuid,
    payment_components jsonb not null default '[]',
    effective_from date not null,
    effective_to date,
    status text not null
  );
  create table public.workforce_payroll_runs (
    id uuid primary key,
    company_id uuid not null,
    period_start date not null,
    period_end date not null,
    status text
  );
  create table public.workforce_payroll_items (
    id uuid primary key,
    company_id uuid not null,
    payroll_run_id uuid not null,
    workforce_id uuid not null,
    status text
  );
  create table public.workforce_payment_settings (
    id bigint generated always as identity primary key,
    company_id uuid not null,
    calculation_method text not null,
    paid_off_days smallint not null,
    work_units_per_paid_off numeric(5,2) not null,
    cap_at_monthly_amount boolean not null,
    effective_from date not null,
    change_reason text not null default 'Verifier',
    created_by uuid,
    updated_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table public.workforce_deduction_heads (
    id uuid primary key,
    company_id uuid not null references public.companies(id),
    code text not null,
    name text not null,
    calculation_type text not null,
    is_system boolean not null default false,
    is_active boolean not null default true
  );
  create or replace function public.lock_workforce_payment_allocation_company(p_company_id uuid)
  returns void language plpgsql security definer set search_path='' as $$
  begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'workforce-payment-allocation-company:' || p_company_id::text, 0
    ));
  end $$;
  create or replace function public.guard_finalized_workforce_payout_input()
  returns trigger language plpgsql security definer set search_path='' as $$
  begin
    if tg_op = 'DELETE' then return old; end if;
    new.updated_at := clock_timestamp();
    return new;
  end $$;
`);

await db.exec(additionalPaymentMigration);
await db.exec(migration
  .replace(/create extension if not exists pgcrypto\s*;/gi, "")
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, ""));
await db.exec(deductionUploadMigration);
await db.exec(attendanceValuesMigration);

await db.exec(`
  insert into auth.users(id) values ('${user}');
  insert into public.companies(id) values ('${company}');
  insert into public.stations(id,company_id,station_code) values
    ('${station}','${company}','ST1'),
    ('${otherStation}','${company}','ST2'),
    ('${unrelatedStation}','${company}','ST3');
  insert into public.workforce(id,company_id,dropx_id,full_name,location_id,date_of_join)
    values ('${worker}','${company}','DX1001','Test Worker','${station}','2026-01-01'),
           ('${directWorker}','${company}','DX2002','Direct Worker','${station}','2026-01-01');
  insert into public.payment_fields(id,company_id,code,label,field_type,calculation_type,calculation_source,pay_schedule,is_custom_production)
    values ('${amountField}','${company}','BASE_RATE','Base rate','amount','manual_input',null,null,false),
           ('${productionField}','${company}','EXTRA_UNITS','Extra units','production','count_x_rate',null,null,true),
           ('${providerProductionField}','${company}','DELIVERY','Delivery','production','count_x_rate',null,null,false),
           ('${attendanceField}','${company}','ATTENDANCE_HOURS','Attendance hours','amount','fixed_rate','attendance_eligibility','per_hour',false),
           ('${dailyAttendanceField}','${company}','ATTENDANCE_DAYS','Attendance days','amount','fixed_daily','attendance_eligibility','per_day',false),
           ('${monthlyAttendanceField}','${company}','FIXED_PAY_PER_MONTH','Monthly attendance','amount','fixed_monthly','attendance_eligibility','per_month',false);
  insert into public.payment_method_components(id,company_id,payment_method_id,payment_field_id,component_code,component_type,pay_schedule)
    values ('${id(10)}','${company}','${method}','${amountField}','BASE_RATE','amount',null),
           ('${id(11)}','${company}','${method}','${productionField}','EXTRA_UNITS','production',null),
           ('${id(24)}','${company}','${method}','${providerProductionField}','DELIVERY','production',null),
           ('${id(27)}','${company}','${method}','${attendanceField}','ATTENDANCE_HOURS','amount','per_hour');
  insert into public.field_executive_provider_mappings(id,company_id,workforce_id,station_id,payment_method_id,effective_from,status)
    values ('${id(12)}','${company}','${worker}','${station}','${method}','2026-01-01','active');
  insert into public.workforce_payment_allocations
    (id,company_id,workforce_id,station_id,payment_method_id,payment_components,effective_from,status)
    values (
      '${directAllocation}','${company}','${directWorker}','${station}',null,
      '[{"payment_field_id":"${attendanceField}","component_code":"ATTENDANCE_HOURS","component_type":"amount","calculation_type":"fixed_rate","calculation_source":"attendance_eligibility","pay_schedule":"per_hour"},{"payment_field_id":"${dailyAttendanceField}","component_code":"ATTENDANCE_DAYS","component_type":"amount","calculation_type":"fixed_daily","calculation_source":"attendance_eligibility","pay_schedule":"per_day"}]'::jsonb,
      '2026-01-01','active'
    );
  insert into public.workforce_additional_payment_fields(id,company_id,code,name,calculation_type)
    values ('${additionalField}','${company}','BONUS','Bonus','manual_amount');
  insert into public.workforce_deduction_heads(id,company_id,code,name,calculation_type,is_system,is_active)
    values ('${manualDeductionHead}','${company}','LOAN_RECOVERY','Loan recovery','manual',false,true),
           ('${fixedDeductionHead}','${company}','FIXED_RECOVERY','Fixed recovery','fixed',false,true),
           ('${systemManualDeductionHead}','${company}','SYSTEM_MANUAL','System manual','manual',true,true);
`);

const rows = [
  { row_number: 2, action: "UPSERT", dropx_id: "DX1001", input_type: "ATTENDANCE", field_code: "WORK_HOURS", workforce_id: worker, station_id: station, payment_field_id: null, additional_payment_field_id: null, deduction_head_id: null, effective_from: "2026-09-01", effective_to: "2026-09-30", numeric_value: 30, text_value: null, work_minutes: null, remark: "monthly hours" },
  { row_number: 3, action: "UPSERT", dropx_id: "DX1001", input_type: "PAYMENT_FIELD_VALUE", field_code: "BASE_RATE", workforce_id: worker, station_id: station, payment_field_id: amountField, additional_payment_field_id: null, effective_from: "2026-09-01", effective_to: "2026-09-30", numeric_value: 650, text_value: null, work_minutes: null, remark: null },
  { row_number: 4, action: "UPSERT", dropx_id: "DX1001", input_type: "PRODUCTION_UNITS", field_code: "EXTRA_UNITS", workforce_id: worker, station_id: station, payment_field_id: productionField, additional_payment_field_id: null, effective_from: "2026-09-02", effective_to: "2026-09-02", numeric_value: 5, text_value: null, work_minutes: null, remark: null },
  { row_number: 5, action: "UPSERT", dropx_id: "DX1001", input_type: "ADDITIONAL_PAYMENT", field_code: "BONUS", workforce_id: worker, station_id: station, payment_field_id: null, additional_payment_field_id: additionalField, deduction_head_id: null, effective_from: "2026-09-01", effective_to: "2026-09-30", numeric_value: 1200, text_value: null, work_minutes: null, remark: "period bonus" },
  { row_number: 6, action: "UPSERT", dropx_id: "DX1001", input_type: "DEDUCTION", field_code: "LOAN_RECOVERY", workforce_id: worker, station_id: station, payment_field_id: null, additional_payment_field_id: null, deduction_head_id: manualDeductionHead, effective_from: "2026-09-01", effective_to: "2026-09-30", numeric_value: 400, text_value: null, work_minutes: null, remark: "monthly recovery" }
];

const applyForPeriod = (hash, from, to, payload, allowed = [station]) => db.query(`
  select public.workforce_apply_payout_import(
    $1::uuid, $6::date, $7::date,
    'payout-inputs.xlsx', $2, $3::jsonb, $4::uuid, $5::uuid[]
  ) as id
`, [company, hash, JSON.stringify(payload), user, allowed, from, to]);
const apply = (hash, payload = rows, allowed = [station]) =>
  applyForPeriod(hash, "2026-09-01", "2026-09-30", payload, allowed);

const first = await apply("a".repeat(64));
assert.equal(first.rows.length, 1);
const counts = await db.query(`
  select
    (select count(*)::int from public.workforce_payout_import_batches) batches,
    (select count(*)::int from public.workforce_payout_import_rows) audit_rows,
    (select count(*)::int from public.workforce_payout_attendance_values) attendance,
    (select count(*)::int from public.workforce_payment_field_overrides) field_values,
    (select count(*)::int from public.workforce_custom_production_inputs) production,
    (select count(*)::int from public.workforce_additional_payment_values) additions,
    (select count(*)::int from public.workforce_payout_deduction_values) deductions
`);
assert.deepEqual(counts.rows[0], { batches: 1, audit_rows: 5, attendance: 1, field_values: 1, production: 1, additions: 1, deductions: 1 });
assert.equal(Number((await db.query(`select final_amount from public.workforce_additional_payment_values`)).rows[0].final_amount), 1200,
  "the bulk verifier must exercise the real additional-payment preparation trigger");
assert.equal(Number((await db.query(`select amount from public.workforce_payout_deduction_values`)).rows[0].amount), 400);
const attendanceAudit = await db.query(`select field_code_snapshot,numeric_value,text_value,work_minutes,
  effective_from::text effective_from,effective_to::text effective_to
  from public.workforce_payout_import_rows where input_type='ATTENDANCE'`);
assert.deepEqual(attendanceAudit.rows, [{
  field_code_snapshot: "WORK_HOURS",
  numeric_value: "30.0000",
  text_value: null,
  work_minutes: null,
  effective_from: "2026-09-01",
  effective_to: "2026-09-30"
}]);

await assert.rejects(
  apply("ca".repeat(32), [{ ...rows[0], row_number: 2, numeric_value: 721 }]),
  /WORK_HOURS VALUE cannot exceed 24 hours for each inclusive effective date/i
);
await assert.rejects(
  apply("cb".repeat(32), [{ ...rows[0], row_number: 2, field_code: "WORK_DAYS", numeric_value: 31 }]),
  /WORK_DAYS VALUE cannot exceed the inclusive effective-day count/i
);
await assert.rejects(
  db.query(`update public.workforce_payout_attendance_values set quantity=721 where workforce_id=$1`, [worker]),
  /WORK_HOURS quantity cannot exceed 24 hours for each inclusive effective date/i,
  "the table trigger enforces the same quantity ceiling outside the RPC"
);
await assert.rejects(
  apply("cc".repeat(32), [{
    ...rows[0],
    row_number: 2,
    effective_from: "2026-09-15",
    numeric_value: 10
  }]),
  /partially overlaps an existing attendance value/i
);

await db.query(`insert into public.payment_method_components
  (id,company_id,payment_method_id,payment_field_id,component_code,component_type,pay_schedule)
  values ($1,$2,$3,$4,'ATTENDANCE_DAYS','amount','per_day')`, [id(35), company, method, dailyAttendanceField]);
await assert.rejects(
  apply("c1".repeat(32), [{ ...rows[0], row_number: 2, numeric_value: 35 }]),
  /mixes hourly and daily or monthly attendance pay/i,
  "provider allocations with mixed attendance bases fail closed in the RPC"
);
await db.query("delete from public.payment_method_components where id=$1", [id(35)]);

const directAttendanceRow = {
  ...rows[0],
  row_number: 2,
  dropx_id: "DX2002",
  workforce_id: directWorker,
  station_id: station
};
await assert.rejects(
  apply("c2".repeat(32), [directAttendanceRow]),
  /mixes hourly and daily or monthly attendance pay/i,
  "direct allocation snapshots with mixed attendance bases fail closed in the RPC"
);

await db.query(`insert into public.workforce_payment_field_overrides
  (company_id,workforce_id,station_id,payment_field_id,field_code_snapshot,
   effective_from,effective_to,input_value,source_batch_id,source_row_id,created_by,updated_by)
  select $1,$2,$3,$4,'ATTENDANCE_HOURS','2026-09-15','2026-09-30',5,batch_id,id,$5,$5
  from public.workforce_payout_import_rows
  where input_type='ATTENDANCE'
  order by created_at
  limit 1`, [company, worker, station, attendanceField, user]);
await assert.rejects(
  apply("c3".repeat(32), [{ ...rows[0], row_number: 2, numeric_value: 35 }]),
  /rate override boundary inside its effective range/i
);
await db.query(`update public.workforce_payment_field_overrides
  set effective_from='2026-09-01'
  where workforce_id=$1 and payment_field_id=$2`, [worker, attendanceField]);
await apply("c4".repeat(32), [{ ...rows[0], row_number: 2, numeric_value: 35 }]);
await db.query(`delete from public.workforce_payment_field_overrides
  where workforce_id=$1 and payment_field_id=$2`, [worker, attendanceField]);

await db.query(`update public.workforce_payment_allocations
  set payment_components=$2::jsonb
  where id=$1`, [directAllocation, JSON.stringify([{
  payment_field_id: monthlyAttendanceField,
  component_code: "FIXED_PAY_PER_MONTH",
  component_type: "amount",
  calculation_type: "fixed_monthly",
  calculation_source: "attendance_eligibility",
  pay_schedule: "per_month"
}])]);
await assert.rejects(
  applyForPeriod("c0".repeat(32), "2026-08-15", "2026-09-30", [{
    ...directAttendanceRow,
    field_code: "WORK_DAYS",
    effective_from: "2026-08-15",
    effective_to: "2026-09-30",
    numeric_value: 30
  }]),
  /stay within one calendar month/i,
  "aggregate attendance cannot commit a range the payout loader cannot settle"
);
await db.query(`insert into public.workforce_payment_settings
  (company_id,calculation_method,paid_off_days,work_units_per_paid_off,cap_at_monthly_amount,effective_from)
  values ($1,'fixed_paid_offs',4,6,true,'2026-09-15')`, [company]);
await assert.rejects(
  apply("c5".repeat(32), [{
    ...directAttendanceRow,
    field_code: "WORK_DAYS",
    effective_from: "2026-09-01",
    effective_to: "2026-09-30",
    numeric_value: 30
  }]),
  /monthly attendance payment policy change inside its effective range/i
);
await db.query("delete from public.workforce_payment_settings where company_id=$1", [company]);

const legacyAttendance = {
  ...rows[0],
  row_number: 2,
  field_code: null,
  effective_from: "2026-09-05",
  effective_to: "2026-09-05",
  numeric_value: null,
  text_value: "P",
  work_minutes: 480,
  remark: "rolling-deploy compatibility"
};
await apply("cd".repeat(32), [legacyAttendance]);
assert.deepEqual((await db.query(`select attendance_status,work_minutes
  from public.workforce_payout_attendance_overrides where workforce_id=$1`, [worker])).rows,
[{ attendance_status: "P", work_minutes: 480 }]);

// A deduction-only workbook replaces only that exact manual head and period.
// Every other payout-input table must remain byte-for-byte untouched.
const unrelatedBefore = await db.query(`
  select
    (select row_to_json(item) from (select attendance_basis,quantity,effective_from,effective_to from public.workforce_payout_attendance_values) item) attendance,
    (select row_to_json(item) from (select input_value from public.workforce_payment_field_overrides) item) field_value,
    (select row_to_json(item) from (select units from public.workforce_custom_production_inputs) item) production,
    (select row_to_json(item) from (select input_value,final_amount from public.workforce_additional_payment_values) item) addition
`);
await apply("ab".repeat(32), [{ ...rows[4], row_number: 2, numeric_value: 525 }]);
assert.equal(Number((await db.query(`select amount from public.workforce_payout_deduction_values`)).rows[0].amount), 525);
const unrelatedAfterReplace = await db.query(`
  select
    (select row_to_json(item) from (select attendance_basis,quantity,effective_from,effective_to from public.workforce_payout_attendance_values) item) attendance,
    (select row_to_json(item) from (select input_value from public.workforce_payment_field_overrides) item) field_value,
    (select row_to_json(item) from (select units from public.workforce_custom_production_inputs) item) production,
    (select row_to_json(item) from (select input_value,final_amount from public.workforce_additional_payment_values) item) addition
`);
assert.deepEqual(unrelatedAfterReplace.rows[0], unrelatedBefore.rows[0]);

await assert.rejects(
  apply("ac".repeat(32), [{ ...rows[4], row_number: 2, deduction_head_id: fixedDeductionHead, field_code: "FIXED_RECOVERY" }]),
  /active manual-entry head/i
);
await assert.rejects(
  apply("a3".repeat(32), [{ ...rows[4], row_number: 2, deduction_head_id: systemManualDeductionHead, field_code: "SYSTEM_MANUAL" }]),
  /active manual-entry head/i
);
await assert.rejects(
  apply("ad".repeat(32), [{ ...rows[4], row_number: 2, effective_from: "2026-09-15" }]),
  /exact selected payout period/i
);
await assert.rejects(
  apply("a2".repeat(32), [{ ...rows[4], row_number: 2, station_id: otherStation }], [station, otherStation]),
  /current location or an overlapping historical payment location/i
);

await assert.rejects(apply("a".repeat(64)), /already imported/i);
await assert.rejects(apply("b".repeat(64), [{ ...rows[0], row_number: 2, station_id: otherStation }]), /location scope/i);

const duplicateTargetCases = [
  {
    hash: "3".repeat(64),
    inputType: "PAYMENT_FIELD_VALUE",
    payload: [{ ...rows[1], row_number: 2 }, { ...rows[1], row_number: 3, numeric_value: 700 }]
  },
  {
    hash: "4".repeat(64),
    inputType: "PRODUCTION_UNITS",
    payload: [{ ...rows[2], row_number: 2 }, { ...rows[2], row_number: 3, numeric_value: 8 }]
  },
  {
    hash: "5".repeat(64),
    inputType: "ATTENDANCE",
    payload: [rows[0], { ...rows[0], row_number: 3, station_id: otherStation, numeric_value: 45 }]
  },
  {
    hash: "6".repeat(64),
    inputType: "ADDITIONAL_PAYMENT",
    payload: [{ ...rows[3], row_number: 2 }, { ...rows[3], row_number: 3, station_id: otherStation, numeric_value: 1500 }]
  },
  {
    hash: "a1".repeat(32),
    inputType: "DEDUCTION",
    payload: [{ ...rows[4], row_number: 2 }, { ...rows[4], row_number: 3, station_id: otherStation, numeric_value: 650 }]
  }
];
const beforeDuplicateTargets = await db.query("select count(*)::int count from public.workforce_payout_import_batches");
for (const duplicateCase of duplicateTargetCases) {
  await assert.rejects(
    apply(duplicateCase.hash, duplicateCase.payload, [station, otherStation]),
    new RegExp(`Row 3 duplicates resolved ${duplicateCase.inputType} input from row 2`, "i")
  );
}
const afterDuplicateTargets = await db.query("select count(*)::int count from public.workforce_payout_import_batches");
assert.equal(afterDuplicateTargets.rows[0].count, beforeDuplicateTargets.rows[0].count, "duplicate canonical targets roll back before creating an audit batch");

await db.query(`insert into public.field_executive_provider_mappings(id,company_id,workforce_id,station_id,payment_method_id,effective_from,status)
  values ($1,$2,$3,$4,$5,'2026-01-01','active')`, [id(13), company, worker, otherStation, method]);
await apply("e".repeat(64), [{ ...rows[1], row_number: 2, station_id: otherStation, numeric_value: 725 }], [station, otherStation]);
await apply("f".repeat(64), [{ ...rows[2], row_number: 2, station_id: otherStation, numeric_value: 9 }], [station, otherStation]);
const stationSpecificCounts = await db.query(`
  select
    (select count(*)::int from public.workforce_payment_field_overrides) field_values,
    (select count(*)::int from public.workforce_custom_production_inputs) production
`);
assert.deepEqual(stationSpecificCounts.rows[0], { field_values: 2, production: 2 });
await assert.rejects(
  apply("1".repeat(64), [{ ...rows[0], row_number: 2, station_id: otherStation, numeric_value: 40 }], [station, otherStation]),
  /attendance period already belongs to another location/i
);
await apply("10".repeat(32), [{ ...rows[0], row_number: 2, numeric_value: 40 }]);
const replacedAttendance = await db.query(`select station_id,attendance_basis,quantity
  from public.workforce_payout_attendance_values where workforce_id=$1`, [worker]);
assert.deepEqual(replacedAttendance.rows, [{ station_id: station, attendance_basis: "hours", quantity: "40.0000" }]);
await apply("11".repeat(32), [{
  ...rows[0],
  row_number: 2,
  action: "CLEAR",
  field_code: "WORK_DAYS",
  numeric_value: null,
  remark: "clear by logical attendance-period identity"
}]);
assert.equal((await db.query(`select count(*)::int count from public.workforce_payout_attendance_values
  where workforce_id=$1`, [worker])).rows[0].count, 0,
"CLEAR cannot silently retain an exact attendance period merely because its supplied basis differs");
await apply("12".repeat(32), [{ ...rows[0], row_number: 2, numeric_value: 40 }]);
unrelatedBefore.rows[0].attendance.quantity = 40;
await assert.rejects(
  apply("10".repeat(32), [{ ...rows[0], row_number: 2, numeric_value: 40 }]),
  /already imported/i,
  "attendance-only workbooks use the same idempotency key"
);
await assert.rejects(
  apply("2".repeat(64), [{ ...rows[3], row_number: 2, station_id: otherStation }], [station, otherStation]),
  /unambiguous Workforce location|additional payment already belongs to another location/i
);

await db.query(`update public.field_executive_provider_mappings
  set effective_to='2026-09-15'
  where id=$1`, [id(12)]);
await db.query(`update public.field_executive_provider_mappings
  set effective_from='2026-09-16'
  where id=$1`, [id(13)]);
await db.query("update public.workforce set location_id=$1 where id=$2", [otherStation, worker]);
const transferCurrentField = id(14);
const transferHistoryField = id(16);
const transferDefaultField = id(17);
const unrelatedField = id(18);
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
await apply("7".repeat(64), [{
  ...rows[3],
  row_number: 2,
  field_code: "TRANSFER_CURRENT",
  additional_payment_field_id: transferCurrentField,
  station_id: otherStation
}], [station, otherStation]);
await apply("8".repeat(64), [{
  ...rows[3],
  row_number: 2,
  field_code: "TRANSFER_HISTORY",
  additional_payment_field_id: transferHistoryField,
  station_id: station
}], [station, otherStation]);
await apply("9".repeat(64), [{
  ...rows[3],
  row_number: 2,
  field_code: "TRANSFER_DEFAULT",
  additional_payment_field_id: transferDefaultField,
  station_id: null
}], [station, otherStation]);
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
  apply("0".repeat(64), [{
    ...rows[3],
    row_number: 2,
    field_code: "UNRELATED_BONUS",
    additional_payment_field_id: unrelatedField,
    station_id: unrelatedStation
  }], [station, otherStation, unrelatedStation]),
  /current location or an overlapping historical payment location/i
);
await assert.rejects(
  apply("6".repeat(64), [{
    ...rows[3],
    row_number: 2,
    field_code: "TRANSFER_HISTORY",
    additional_payment_field_id: transferHistoryField,
    station_id: station
  }], [otherStation]),
  /location scope/i,
  "historical ownership never bypasses the importing user's location scope"
);

const beforeFailed = await db.query("select count(*)::int count from public.workforce_payout_import_batches");
await assert.rejects(
  apply("c".repeat(64), [rows[0], { ...rows[2], row_number: 3, numeric_value: -1 }]),
  /non-negative numeric value/i
);
const afterFailed = await db.query("select count(*)::int count from public.workforce_payout_import_batches");
assert.equal(afterFailed.rows[0].count, beforeFailed.rows[0].count, "a rejected row rolls back the entire batch");

// Historical values remain clearable after an administrator changes the head.
// Replacement values must still obey the current active/manual/non-system rules.
await db.query(`update public.workforce_deduction_heads
  set is_active=false, calculation_type='fixed', is_system=true
  where id=$1`, [manualDeductionHead]);
await assert.rejects(
  apply("a4".repeat(32), [{ ...rows[4], row_number: 2, numeric_value: 600 }]),
  /active manual-entry head.*not system-managed/i
);
await apply("ae".repeat(32), [{
  ...rows[4],
  row_number: 2,
  action: "CLEAR",
  numeric_value: null,
  remark: "clear only loan recovery"
}]);
assert.equal((await db.query(`select count(*)::int count from public.workforce_payout_deduction_values`)).rows[0].count, 0);
const unrelatedAfterClear = await db.query(`
  select
    (select row_to_json(item) from (select attendance_basis,quantity,effective_from,effective_to from public.workforce_payout_attendance_values) item) attendance,
    (select row_to_json(item) from (select input_value from public.workforce_payment_field_overrides where station_id=$1) item) field_value,
    (select row_to_json(item) from (select units from public.workforce_custom_production_inputs where station_id=$1) item) production,
    (select row_to_json(item) from (select input_value,final_amount from public.workforce_additional_payment_values where additional_payment_field_id=$2) item) addition
`, [station, additionalField]);
assert.deepEqual(unrelatedAfterClear.rows[0], unrelatedBefore.rows[0]);

// PRODUCTION_UNITS is a field-scoped override for every production field,
// including provider-derived fields such as DELIVERY (not only custom fields).
await apply("af".repeat(32), [{
  ...rows[2],
  row_number: 2,
  field_code: "DELIVERY",
  payment_field_id: providerProductionField,
  effective_from: "2026-09-03",
  effective_to: "2026-09-03",
  numeric_value: 11
}]);
const providerProduction = await db.query(`select units,field_code_snapshot
  from public.workforce_custom_production_inputs
  where payment_field_id=$1 and work_date='2026-09-03'`, [providerProductionField]);
assert.deepEqual(providerProduction.rows, [{ units: "11.0000", field_code_snapshot: "DELIVERY" }]);

await db.query(`insert into public.workforce_payroll_runs(id,company_id,period_start,period_end,status)
  values ($1,$2,'2026-09-01','2026-09-30','approved')`, [id(30), company]);
await assert.rejects(
  apply("d".repeat(64), [{ ...rows[0], row_number: 2 }]),
  /approved or paid/i,
  "a finalized company period is locked even when the worker was omitted from payroll items"
);

console.log("Workforce payout bulk-import migration verification passed.");
