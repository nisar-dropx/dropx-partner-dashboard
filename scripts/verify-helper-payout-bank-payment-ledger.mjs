import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL(
  "../supabase/migrations/20261010210000_helper_payout_bank_payment_ledger.sql",
  import.meta.url
), "utf8")
  .replace(/create extension if not exists pgcrypto\s*;/gi, "")
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

const db = new PGlite();
await db.exec(`
  create schema auth;
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create table auth.users(id uuid primary key);
  create table public.companies(id uuid primary key);
  create table public.payment_banks(
    id uuid primary key, company_id uuid not null, bank_code text not null,
    display_name text not null, account_no text not null, ifsc text not null,
    is_active boolean not null default true, unique(company_id,id)
  );
  create table public.stations(
    id uuid primary key, company_id uuid not null, station_code text,
    station_name text, is_active boolean not null default true, unique(company_id,id)
  );
  create table public.helpers(
    id uuid primary key, company_id uuid not null, dropx_id text, full_name text,
    email text, bank_account_no text, ifsc_code text, onboarding_status text,
    is_active boolean not null default true, unique(company_id,id)
  );
  create table public.workforce_payout_review_submissions(
    id uuid primary key, company_id uuid not null, subject_type text not null,
    subject_id uuid not null, location_id uuid not null, period_start date not null,
    period_end date not null, status text not null, calculation_snapshot jsonb
  );
  create table public.helper_payout_publications(
    id uuid primary key, company_id uuid not null, helper_id uuid not null,
    station_id uuid not null, revision integer not null, snapshot jsonb not null,
    snapshot_hash text not null, review_submission_id uuid not null,
    published_at timestamptz not null default clock_timestamp(),
    period_start date not null, period_end date not null,
    payout_source_change_id bigint not null default 0,
    payout_dependency_hash text not null default repeat('f', 32),
    unique(company_id,id)
  );
  create table public.helper_payout_dependency_changes(
    id bigint generated always as identity primary key,
    company_id uuid not null, helper_id uuid not null, station_id uuid not null,
    effective_from date not null, effective_to date,
    source_table text not null, source_row_id uuid not null
  );
  create table public.helper_payment_allocations(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null, helper_id uuid not null, station_id uuid not null,
    station_code_snapshot text not null default 'STUB',
    designation_id uuid not null default '20000000-0000-4000-8000-000000000001',
    designation_code_snapshot text not null default 'HELPER',
    designation_name_snapshot text not null default 'Helper',
    payment_method_id uuid not null default '20000000-0000-4000-8000-000000000002',
    payment_values jsonb not null default '{}'::jsonb,
    payment_components jsonb not null default '[]'::jsonb,
    status text not null, effective_from date not null, effective_to date
  );
  create table public.helper_payout_attendance_values(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    helper_id uuid not null, station_id uuid not null,
    effective_from date not null, effective_to date not null,
    attendance_basis text not null default 'days', quantity numeric not null default 0,
    source_batch_id uuid, source_row_id uuid, created_by uuid, updated_by uuid,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp()
  );
  create table public.helper_additional_payment_values(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    helper_id uuid not null, station_id uuid not null,
    effective_from date not null, effective_to date not null,
    final_amount numeric not null default 0,
    source_batch_id uuid, source_row_id uuid, created_by uuid, updated_by uuid,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp()
  );
  create table public.helper_payout_deduction_values(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    helper_id uuid not null, station_id uuid not null,
    effective_from date not null, effective_to date not null,
    amount numeric not null default 0,
    source_batch_id uuid, source_row_id uuid, created_by uuid, updated_by uuid,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp()
  );
  create table public.connect_profile_verifications(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null, profile_type text not null, account_id uuid not null,
    kind text not null, verified boolean not null default false
  );
  create table public.biometric_enrolments(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    enrolment_id text not null, effective_from date not null, effective_to date
  );
  create table public.attendance_daily(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    enrolment_id text not null, punch_date date not null, status text
  );
  create table public.workforce_payment_settings(
    id bigint generated always as identity primary key, company_id uuid not null,
    effective_from date not null
  );
  create table public.workforce_deduction_heads(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    code text not null, name text not null
  );
  create table public.workforce_additional_payment_fields(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    code text not null, name text not null
  );
  create table public.payment_methods(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    name text not null
  );
  create table public.payment_fields(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    label text not null
  );
  create table public.payment_method_components(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    component_code text not null
  );
  create table public.workforce_payout_payment_items(
    id uuid primary key, company_id uuid not null, status text not null, utr_cin text,
    reference_no text not null, period_start date not null, period_end date not null,
    finalized_at timestamptz,
    created_at timestamptz not null default clock_timestamp()
  );
  create function public.workforce_payout_bank_account_canonical(text)
    returns text language sql immutable as $$
      select regexp_replace(upper(coalesce($1,'')), '[[:space:]]', '', 'g')
    $$;
  create function public.workforce_payout_bank_ifsc_canonical(text)
    returns text language sql immutable as $$
      select regexp_replace(upper(coalesce($1,'')), '[[:space:]]', '', 'g')
    $$;
  create function public.workforce_payout_bank_reference_canonical(text)
    returns text language sql immutable as $$
      select regexp_replace(upper(coalesce($1,'')), '[[:space:]]', '', 'g')
    $$;
  create function public.helper_payout_shared_dependency_hash(uuid,date,date)
    returns text language sql stable as $$ select repeat('f', 32) $$;
  create function public.lock_workforce_payment_allocation_company(uuid)
    returns void language plpgsql as $$ begin return; end $$;
  create function public.workforce_transition_payout_review_status(
    p_company_id uuid, p_subject_type text, p_subject_id uuid,
    p_location_id uuid, p_period_start date, p_period_end date,
    p_expected_status text, p_new_status text,
    p_allowed_location_ids uuid[] default null
  ) returns jsonb language plpgsql security definer as $$
  declare
    v_subject_type text := lower(btrim(p_subject_type));
  begin
    perform public.lock_workforce_payment_allocation_company(p_company_id);
    return '{}'::jsonb;
  end $$;
`);

await db.exec(migration);

const tables = await db.query(`
  select tablename from pg_tables
  where schemaname = 'public' and tablename like 'helper_payout_payment_%'
  order by tablename
`);
assert.deepEqual(tables.rows.map((row) => row.tablename), [
  "helper_payout_payment_batches",
  "helper_payout_payment_events",
  "helper_payout_payment_hold_events",
  "helper_payout_payment_items",
  "helper_payout_payment_response_imports"
]);

const sharedRegistry = await db.query(`
  select tablename from pg_tables
  where schemaname = 'public' and tablename = 'payout_bank_paid_transaction_registry'
`);
assert.equal(sharedRegistry.rows.length, 1);

const claimTriggers = await db.query(`
  select event_object_table
  from information_schema.triggers
  where trigger_schema = 'public'
    and trigger_name like '%_paid_transaction_claim'
  order by event_object_table
`);
assert.deepEqual([...new Set(claimTriggers.rows.map((row) => row.event_object_table))], [
  "helper_payout_payment_items",
  "workforce_payout_payment_items"
]);

const functions = await db.query(`
  select proname from pg_proc join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
  where pg_namespace.nspname = 'public' and proname like 'helper%payout%payment%'
`);
const names = new Set(functions.rows.map((row) => row.proname));
for (const name of [
  "helper_preview_payout_payment_rows",
  "helper_create_payout_payment_row_batch",
  "helper_finalize_payout_payment_response",
  "helper_transition_payout_payment_item",
  "helper_set_payout_payment_hold",
  "helper_cancel_payout_payment_items",
  "helper_get_payout_payment_redownload"
]) assert.ok(names.has(name), `missing ${name}`);

const bulkCancelDefinition = await db.query(`
  select pg_get_functiondef(
    'public.helper_cancel_payout_payment_items(uuid,uuid,uuid,uuid[],date,date,text)'::regprocedure
  ) as definition
`);
assert.match(
  String(bulkCancelDefinition.rows[0]?.definition ?? ""),
  /v_existing\.actor_user_id <> p_actor_user_id/
);

const collisionSafeReferences = await db.query(`
  select
    public.helper_payout_payment_reference(
      '30000000-0000-4000-8000-000000000001', 'H-100', '2026-10-01', 1
    ) first_reference,
    public.helper_payout_payment_reference(
      '30000000-0000-4000-8000-000000000002', 'H100', '2026-10-01', 1
    ) second_reference
`);
assert.notEqual(
  collisionSafeReferences.rows[0]?.first_reference,
  collisionSafeReferences.rows[0]?.second_reference
);
assert.match(collisionSafeReferences.rows[0]?.first_reference, /^HP[A-Z0-9]+102026V1$/);
assert.ok(collisionSafeReferences.rows[0]?.first_reference.length <= 64);

const processingHook = await db.query(`
  select count(*)::integer as count
  from pg_proc
  join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
  where pg_namespace.nspname = 'public'
    and pg_proc.proname = 'helper_payout_input_processing_locked'
`);
assert.equal(processingHook.rows[0]?.count, 1);

await db.exec(`
  insert into public.companies(id) values ('10000000-0000-4000-8000-000000000001');
  insert into auth.users(id) values ('10000000-0000-4000-8000-000000000002');
  insert into public.payment_banks(
    id, company_id, bank_code, display_name, account_no, ifsc
  ) values (
    '10000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'FEDERAL_BANK', 'Federal Bank', '12345678', 'FDRL0000123'
  );
  insert into public.stations(id, company_id, station_code, station_name) values
    ('10000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'AAA', 'Alpha'),
    ('10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'BBB', 'Beta');
  insert into public.helpers(
    id, company_id, dropx_id, full_name, email, bank_account_no, ifsc_code,
    onboarding_status, is_active
  ) values (
    '10000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001',
    'D1001', 'Test Helper', 'helper@example.test', '87654321', 'FDRL0000123',
    'active', true
  );
  insert into public.workforce_payout_review_submissions(
    id, company_id, subject_type, subject_id, location_id,
    period_start, period_end, status
  ) values (
    '10000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000001', 'helper',
    '10000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000004',
    '2026-10-01', '2026-10-31', 'under_review'
  );
  insert into public.helper_payment_allocations(
    company_id, helper_id, station_id, status, effective_from, effective_to
  ) values (
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000004',
    'active', '2026-01-01', null
  );
  insert into public.helper_payout_publications(
    id, company_id, helper_id, station_id, revision, snapshot, snapshot_hash,
    review_submission_id, period_start, period_end
  ) values (
    '10000000-0000-4000-8000-000000000007',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000004',
    1, '{"schema_version":"2","source":"helper_payout_worksheet","item":{"net_amount":"100.00"}}',
    repeat('a', 64), '10000000-0000-4000-8000-000000000008',
    '2026-10-01', '2026-10-31'
  );
  insert into public.connect_profile_verifications(
    company_id, profile_type, account_id, kind, verified
  ) values (
    '10000000-0000-4000-8000-000000000001', 'worker',
    '10000000-0000-4000-8000-000000000006', 'pan_aadhaar', true
  );
  select set_config('app.helper_payout_payment_mutation', 'allowed', false);
  insert into public.helper_payout_payment_batches(
    id, company_id, operation_id, request_fingerprint, selected_helper_ids,
    bank_id, period_start, period_end, value_date, debit_account_no_snapshot,
    bank_code_snapshot, generated_by
  ) values (
    '10000000-0000-4000-8000-000000000009',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000010', repeat('b', 64),
    array['10000000-0000-4000-8000-000000000006'::uuid],
    '10000000-0000-4000-8000-000000000003',
    '2026-10-01', '2026-10-31', '2026-10-15', '12345678',
    'FEDERAL_BANK', '10000000-0000-4000-8000-000000000002'
  );
  insert into public.helper_payout_payment_items(
    id, company_id, batch_id, helper_id, period_start, period_end,
    payment_version, reference_no, dropx_id_snapshot, beneficiary_name_snapshot,
    beneficiary_email_snapshot, bank_account_no_snapshot, ifsc_snapshot,
    location_id_snapshot, location_code_snapshot, credit_remarks_snapshot,
    helper_publication_id, target_snapshot_hash, current_target_amount,
    paid_before_amount, instruction_amount
  ) values (
    '10000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000009',
    '10000000-0000-4000-8000-000000000006',
    '2026-10-01', '2026-10-31', 1, 'HPD1001102026V1', 'D1001',
    'Test Helper', 'helper@example.test', '87654321', 'FDRL0000123',
    '10000000-0000-4000-8000-000000000004', 'AAA', 'AAA',
    '10000000-0000-4000-8000-000000000007', repeat('a', 64),
    100, 0, 100
  );
`);

const lockChecks = await db.query(`
  select
    public.helper_payout_input_processing_locked(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000004',
      '2026-10-01', '2026-10-31'
    ) as same_location,
    public.helper_payout_input_processing_locked(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000005',
      '2026-10-01', '2026-10-31'
    ) as other_location,
    public.helper_payout_input_processing_locked(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000004',
      '2026-11-01', '2026-11-30'
    ) as other_month
`);
assert.equal(lockChecks.rows[0]?.same_location, true);
assert.equal(lockChecks.rows[0]?.other_location, false);
assert.equal(lockChecks.rows[0]?.other_month, false);

const sharedIntervalLock = await db.query(`
  select public.workforce_payout_payment_interval_is_processing(
    '10000000-0000-4000-8000-000000000001',
    '2026-10-01', '2026-11-01'
  ) as locked
`);
assert.equal(sharedIntervalLock.rows[0]?.locked, true);

const replayedBatch = await db.query(`
  select public.helper_replay_payout_payment_row_batch(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000010',
    repeat('b', 64),
    '10000000-0000-4000-8000-000000000003',
    '2026-10-01', '2026-10-31', '2026-10-15'
  ) as result
`);
assert.equal(replayedBatch.rows[0]?.result?.replayed, true);

await assert.rejects(
  db.exec(`
    update public.helpers
    set full_name = 'Changed During Processing'
    where id = '10000000-0000-4000-8000-000000000006';
  `),
  /Helper profile cannot change while its payout is Payment Processing/
);

await assert.rejects(
  db.exec(`
    update public.connect_profile_verifications
    set verified = false
    where account_id = '10000000-0000-4000-8000-000000000006';
  `),
  /Shared payout configuration cannot change while a Helper payment is Processing/
);

await assert.rejects(
  db.exec(`
    update public.stations set station_name = 'Changed Alpha'
    where id = '10000000-0000-4000-8000-000000000004';
  `),
  /Shared payout configuration cannot change while a Helper payment is Processing/
);

await assert.rejects(
  db.exec(`
    insert into public.workforce_deduction_heads(company_id, code, name)
    values (
      '10000000-0000-4000-8000-000000000001', 'TEST', 'Test deduction'
    );
  `),
  /Shared payout configuration cannot change while a Helper payment is Processing/
);

await assert.rejects(
  db.exec(`
    insert into public.attendance_daily(company_id, enrolment_id, punch_date, status)
    values (
      '10000000-0000-4000-8000-000000000001', 'BIO-1', '2026-10-10', 'present'
    );
  `),
  /Biometric or attendance data cannot change while an overlapping Helper payment is Processing/
);
await db.exec(`
  insert into public.attendance_daily(company_id, enrolment_id, punch_date, status)
  values (
    '10000000-0000-4000-8000-000000000001', 'BIO-1', '2026-11-10', 'present'
  );
`);

await assert.rejects(
  db.exec(`
    insert into public.biometric_enrolments(
      company_id, enrolment_id, effective_from, effective_to
    ) values (
      '10000000-0000-4000-8000-000000000001', 'BIO-1',
      '2026-10-01', '2026-10-31'
    );
  `),
  /Biometric or attendance data cannot change while an overlapping Helper payment is Processing/
);
await db.exec(`
  insert into public.biometric_enrolments(
    company_id, enrolment_id, effective_from, effective_to
  ) values (
    '10000000-0000-4000-8000-000000000001', 'BIO-1',
    '2026-11-01', '2026-11-30'
  );
`);

await assert.rejects(
  db.exec(`
    update public.workforce_payout_review_submissions
    set status = 'returned'
    where id = '10000000-0000-4000-8000-000000000008';
  `),
  /Helper payout cannot change while its bank payment is Payment Processing/
);

await assert.rejects(
  db.exec(`
    select public.workforce_transition_payout_review_status(
      '10000000-0000-4000-8000-000000000001', 'helper',
      '10000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000004',
      '2026-10-01', '2026-10-31', 'under_review', 'returned', null
    );
  `),
  /Helper payout cannot change while its bank payment is Payment Processing/
);

await assert.rejects(
  db.exec(`
    insert into public.helper_payout_publications(
      id, company_id, helper_id, station_id, revision, snapshot, snapshot_hash,
      review_submission_id, period_start, period_end
    ) values (
      '10000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000004', 2,
      '{"schema_version":"2","source":"helper_payout_worksheet","item":{"net_amount":"101.00"}}',
      repeat('c', 64), '10000000-0000-4000-8000-000000000008',
      '2026-10-01', '2026-10-31'
    );
  `),
  /Helper payout cannot change while its bank payment is Payment Processing/
);

await assert.rejects(
  db.exec(`truncate table public.helper_payout_attendance_values;`),
  /Helper payout source data cannot be truncated while a payment is Processing/
);

await assert.rejects(
  db.exec(`
    select set_config('app.helper_payout_payment_mutation', 'allowed', false);
    insert into public.helper_payout_payment_batches(
      id, company_id, operation_id, request_fingerprint, selected_helper_ids,
      bank_id, period_start, period_end, value_date, debit_account_no_snapshot,
      bank_code_snapshot, generated_by
    ) values (
      '10000000-0000-4000-8000-000000000016',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000017', repeat('e', 64),
      array['10000000-0000-4000-8000-000000000006'::uuid],
      '10000000-0000-4000-8000-000000000003',
      '2026-10-01', '2026-10-31', '1899-12-31', '12345678',
      'FEDERAL_BANK', '10000000-0000-4000-8000-000000000002'
    );
  `),
  /helper_payout_payment_batches_value_date_check/
);

await assert.rejects(
  db.exec(`
    update public.helper_payment_allocations
    set effective_to = '2026-10-15'
    where company_id = '10000000-0000-4000-8000-000000000001'
      and helper_id = '10000000-0000-4000-8000-000000000006'
      and station_id = '10000000-0000-4000-8000-000000000004';
  `),
  /cannot change while its payout is Payment Processing/
);

await db.exec(`
  insert into public.helper_payment_allocations(
    company_id, helper_id, station_id, status, effective_from, effective_to
  ) values (
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000005',
    'active', '2026-10-01', '2026-10-31'
  );
  update public.helper_payment_allocations
  set status = 'cancelled'
  where company_id = '10000000-0000-4000-8000-000000000001'
    and helper_id = '10000000-0000-4000-8000-000000000006'
    and station_id = '10000000-0000-4000-8000-000000000005';
`);

await db.exec(`
  select set_config('app.helper_payout_payment_mutation', 'allowed', false);
  update public.helper_payout_payment_items
  set status = 'cancelled', bank_response_status = 'MANUAL_CANCELLED',
      bank_processing_remarks = 'Verifier release',
      finalized_by = '10000000-0000-4000-8000-000000000002',
      finalized_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = '10000000-0000-4000-8000-000000000011';
  update public.helper_payout_payment_batches
  set status = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = '10000000-0000-4000-8000-000000000009';
`);

const freshPreview = await db.query(`
  select eligible, eligibility_code, current_target_amount, balance_payable
  from public.helper_preview_payout_payment_rows(
    '10000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-31',
    jsonb_build_array(jsonb_build_object(
      'workforce_id', '10000000-0000-4000-8000-000000000006',
      'station_id', '10000000-0000-4000-8000-000000000004',
      'current_target_amount', 100,
      'current_snapshot_hash', repeat('a', 64)
    ))
  )
`);
assert.equal(freshPreview.rows[0]?.eligible, true);
assert.equal(freshPreview.rows[0]?.eligibility_code, "eligible");
assert.equal(Number(freshPreview.rows[0]?.current_target_amount), 100);
assert.equal(Number(freshPreview.rows[0]?.balance_payable), 100);

await db.exec(`
  insert into public.helper_payout_dependency_changes(
    company_id, helper_id, station_id, effective_from, effective_to,
    source_table, source_row_id
  ) values (
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000005',
    '2026-10-01', '2026-10-31', 'helper_payment_allocations',
    '10000000-0000-4000-8000-000000000018'
  );
`);
const siblingLocationChange = await db.query(`
  select eligible, eligibility_code
  from public.helper_preview_payout_payment_rows(
    '10000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-31',
    jsonb_build_array(jsonb_build_object(
      'workforce_id', '10000000-0000-4000-8000-000000000006',
      'station_id', '10000000-0000-4000-8000-000000000004',
      'current_target_amount', 100,
      'current_snapshot_hash', repeat('a', 64)
    ))
  )
`);
assert.equal(siblingLocationChange.rows[0]?.eligible, false);
assert.equal(siblingLocationChange.rows[0]?.eligibility_code, "publication_outdated");

await db.exec(`
  insert into public.helper_payout_publications(
    id, company_id, helper_id, station_id, revision, snapshot, snapshot_hash,
    review_submission_id, period_start, period_end, payout_source_change_id
  ) values (
    '10000000-0000-4000-8000-000000000019',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000004',
    2, '{"schema_version":"2","source":"helper_payout_worksheet","item":{"net_amount":"100.00"}}',
    repeat('a', 64), '10000000-0000-4000-8000-000000000008',
    '2026-10-01', '2026-10-31', 1
  );
`);
const republishedPreview = await db.query(`
  select eligible, eligibility_code
  from public.helper_preview_payout_payment_rows(
    '10000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-31',
    jsonb_build_array(jsonb_build_object(
      'workforce_id', '10000000-0000-4000-8000-000000000006',
      'station_id', '10000000-0000-4000-8000-000000000004',
      'current_target_amount', 100,
      'current_snapshot_hash', repeat('a', 64)
    ))
  )
`);
assert.equal(republishedPreview.rows[0]?.eligible, true);
assert.equal(republishedPreview.rows[0]?.eligibility_code, "eligible");

const stalePreview = await db.query(`
  select eligible, eligibility_code
  from public.helper_preview_payout_payment_rows(
    '10000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-31',
    jsonb_build_array(jsonb_build_object(
      'workforce_id', '10000000-0000-4000-8000-000000000006',
      'station_id', '10000000-0000-4000-8000-000000000004',
      'current_target_amount', 100,
      'current_snapshot_hash', repeat('c', 64)
    ))
  )
`);
assert.equal(stalePreview.rows[0]?.eligible, false);
assert.equal(stalePreview.rows[0]?.eligibility_code, "publication_outdated");

await db.exec(`
  select set_config('app.helper_payout_payment_mutation', 'allowed', false);
  insert into public.helper_payout_payment_response_imports(
    id, company_id, operation_id, file_sha256, file_name, normalized_rows,
    result_snapshot, imported_by
  ) values (
    '10000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000013', repeat('d', 64),
    'helper-bank-response.xlsx', '[{}]'::jsonb, '{}'::jsonb,
    '10000000-0000-4000-8000-000000000002'
  );
  insert into public.helper_payout_payment_items(
    id, company_id, batch_id, helper_id, period_start, period_end,
    payment_version, reference_no, dropx_id_snapshot, beneficiary_name_snapshot,
    beneficiary_email_snapshot, bank_account_no_snapshot, ifsc_snapshot,
    location_id_snapshot, location_code_snapshot, credit_remarks_snapshot,
    helper_publication_id, target_snapshot_hash, current_target_amount,
    paid_before_amount, instruction_amount, status, bank_response_status,
    utr_cin, response_import_id, finalized_by, finalized_at
  ) values (
    '10000000-0000-4000-8000-000000000014',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000009',
    '10000000-0000-4000-8000-000000000006',
    '2026-10-01', '2026-10-31', 2, 'HPD1001102026V2', 'D1001',
    'Test Helper', 'helper@example.test', '87654321', 'FDRL0000123',
    '10000000-0000-4000-8000-000000000004', 'AAA', 'AAA',
    '10000000-0000-4000-8000-000000000007', repeat('a', 64),
    100, 50, 50, 'paid', 'PAID', 'Cross-UTR 1',
    '10000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000002', clock_timestamp()
  );
`);

const helperClaim = await db.query(`
  select payout_audience, payment_item_id, normalized_utr
  from public.payout_bank_paid_transaction_registry
  where company_id = '10000000-0000-4000-8000-000000000001'
    and normalized_utr = 'CROSSUTR1'
`);
assert.deepEqual(helperClaim.rows, [{
  payout_audience: "helpers",
  payment_item_id: "10000000-0000-4000-8000-000000000014",
  normalized_utr: "CROSSUTR1"
}]);

await assert.rejects(
  db.exec(`
    select set_config('app.workforce_payout_payment_mutation', 'allowed', false);
    insert into public.workforce_payout_payment_items(
      id, company_id, status, utr_cin, reference_no,
      period_start, period_end, finalized_at
    ) values (
      '10000000-0000-4000-8000-000000000015',
      '10000000-0000-4000-8000-000000000001',
      'paid', 'CROSSUTR1', 'WPD2001102026V1',
      '2026-10-01', '2026-10-31', clock_timestamp()
    );
  `),
  /already recorded for another paid instruction/
);

await db.close();
console.log("Helper payout bank payment ledger migration verified.");
