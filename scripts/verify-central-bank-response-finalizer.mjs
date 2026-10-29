import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL(
  "../supabase/migrations/20261017123000_central_bank_response_finalizer.sql",
  import.meta.url
), "utf8");
const partialMigration = readFileSync(new URL(
  "../supabase/migrations/20261017150000_central_bank_response_partial_rows.sql",
  import.meta.url
), "utf8");
const debitAccountPolicyMigration = readFileSync(new URL(
  "../supabase/migrations/20261022250000_central_bank_response_ignore_debit_account_mismatch.sql",
  import.meta.url
), "utf8");
const replayRowNumbersMigration = readFileSync(new URL(
  "../supabase/migrations/20261022260000_central_bank_partial_replay_row_numbers.sql",
  import.meta.url
), "utf8");
const executableMigration = migration.replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const executablePartialMigration = partialMigration.replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const executableDebitAccountPolicyMigration = debitAccountPolicyMigration.replace(
  /notify\s+pgrst\s*,\s*'reload schema'\s*;/gi,
  ""
);
const executableReplayRowNumbersMigration = replayRowNumbersMigration.replace(
  /notify\s+pgrst\s*,\s*'reload schema'\s*;/gi,
  ""
);

assert.match(migration, /create table if not exists public\.central_bank_response_imports/i);
assert.match(migration, /normalized_payload_hash/i);
assert.match(migration, /create table if not exists public\.central_bank_paid_transaction_registry/i);
assert.match(migration, /create or replace function public\.resolve_central_bank_response_references/i);
assert.match(migration, /create or replace function public\.finalize_central_bank_response/i);
assert.match(partialMigration, /create or replace function public\.finalize_central_bank_response_partially/i);
assert.match(partialMigration, /input_meaningful_utrs\s+as\s+materialized/i);
assert.match(partialMigration, /existing_utr_claims\s+as\s+materialized/i);
assert.match(partialMigration, /payment_request\.request_no\s*=\s*candidate\.reference_no/i);
assert.match(partialMigration, /payroll\.reference\s*=\s*candidate\.reference_no/i);
assert.doesNotMatch(partialMigration, /left\s+join\s+lateral/i);
assert.match(migration, /public\.finalize_owned_payout_payment_response\(/i);
assert.match(migration, /public\.hr_sync_paid_pay_documents\(/i);
assert.match(migration, /pg_advisory_xact_lock[\s\S]*central-bank-paid-utr/i);
assert.match(migration, /from public, anon, authenticated, service_role/i);
assert.match(migration, /to service_role/i);
assert.match(debitAccountPolicyMigration, /Response debit account is audit evidence only/i);
assert.match(debitAccountPolicyMigration, /finalize_central_bank_response_partially/i);
assert.match(debitAccountPolicyMigration, /finalize_central_bank_response\(/i);
assert.match(replayRowNumbersMigration, /replayed_row_numbers/i);
assert.match(replayRowNumbersMigration, /successful replayed rows separately/i);
assert.match(replayRowNumbersMigration, /invalid replayed row result/i);

const db = new PGlite();
await db.exec(`
  create schema auth;
  create role anon;
  create role authenticated;
  create role service_role bypassrls;

  create table auth.users(id uuid primary key);
  create table public.companies(id uuid primary key);

  create function public.workforce_payout_bank_reference_canonical(p_value text)
  returns text language sql immutable as $$
    select regexp_replace(upper(coalesce(p_value, '')), '[[:space:]]', '', 'g')
  $$;
  create function public.workforce_payout_bank_account_canonical(p_value text)
  returns text language sql immutable as $$
    select regexp_replace(upper(coalesce(p_value, '')), '[[:space:]]', '', 'g')
  $$;
  create function public.workforce_payout_bank_ifsc_canonical(p_value text)
  returns text language sql immutable as $$
    select regexp_replace(upper(coalesce(p_value, '')), '[[:space:]]', '', 'g')
  $$;

  create table public.workforce_payout_payment_batches(
    id uuid primary key,
    debit_account_no_snapshot text not null,
    value_date date not null
  );
  create table public.helper_payout_payment_batches(
    id uuid primary key,
    debit_account_no_snapshot text not null,
    value_date date not null
  );
  create table public.workforce_payout_payment_items(
    id uuid primary key,
    company_id uuid not null,
    reference_no text not null,
    location_id_snapshot uuid,
    status text not null,
    utr_cin text,
    batch_id uuid not null,
    workforce_id uuid not null,
    unique(company_id, reference_no)
  );
  create table public.helper_payout_payment_items(
    id uuid primary key,
    company_id uuid not null,
    reference_no text not null,
    location_id_snapshot uuid,
    status text not null,
    utr_cin text,
    batch_id uuid not null,
    helper_id uuid not null,
    unique(company_id, reference_no)
  );
  create table public.payout_bank_paid_transaction_registry(
    company_id uuid not null,
    normalized_utr text not null,
    payout_audience text not null,
    payment_item_id uuid not null,
    reference_no text not null,
    claimed_at timestamptz not null default now(),
    primary key(company_id, normalized_utr)
  );

  create table public.payment_requests(
    id uuid primary key,
    company_id uuid not null,
    request_no text not null,
    location_id uuid,
    payment_process_role_ids uuid[] not null default '{}',
    status text,
    approval_status text,
    current_approver_user_id uuid,
    current_approver_role_id uuid,
    current_approver_role_ids uuid[] not null default '{}',
    payment_mode text,
    beneficiary_account_number text,
    beneficiary_account_no text,
    bank_account_no text,
    beneficiary_ifsc text,
    ifsc text,
    amount numeric(14,2),
    amount_requested numeric(14,2),
    utr_cin text,
    bank_status text,
    bank_processing_remarks text,
    processing_started_at timestamptz,
    processed_at timestamptz,
    updated_at timestamptz default now(),
    created_at timestamptz default now(),
    updated_by uuid,
    approval_cycle integer not null default 1,
    unique(company_id, request_no)
  );
  create table public.payment_request_approvals(
    id uuid primary key default gen_random_uuid(),
    company_id uuid,
    request_id uuid not null,
    payment_request_id uuid,
    sequence_no integer not null,
    role_code text not null,
    status text not null default 'pending',
    action text,
    comments text,
    approver_user_id uuid,
    approver_role_id uuid,
    approval_cycle integer not null default 1,
    created_at timestamptz default now(),
    unique(company_id, request_id, sequence_no)
  );

  create table public.hr_payroll_bank_lines(
    id uuid primary key,
    company_id uuid not null,
    run_id uuid not null,
    worker_type text not null,
    worker_id uuid not null,
    reference text not null,
    amount numeric(14,2) not null,
    credit_account text,
    ifsc text,
    debit_account_number text not null,
    value_date date not null,
    status text not null,
    utr text,
    bank_remarks text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(company_id, reference)
  );
  create table public.hr_payroll_run_people(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    run_id uuid not null,
    worker_type text not null,
    worker_id uuid not null,
    location_id uuid
  );
  create table public.test_hr_sync_calls(
    company_id uuid not null,
    run_id uuid not null,
    actor_id uuid not null
  );
  create function public.hr_sync_paid_pay_documents(
    p_company_id uuid,
    p_run_id uuid,
    p_actor_user_id uuid
  ) returns integer language plpgsql as $$
  begin
    insert into public.test_hr_sync_calls values(p_company_id, p_run_id, p_actor_user_id);
    return 1;
  end $$;

  create function public.finalize_owned_payout_payment_response(
    p_company_id uuid,
    p_actor_user_id uuid,
    p_operation_id uuid,
    p_file_sha256 text,
    p_file_name text,
    p_workforce_rows jsonb,
    p_helper_rows jsonb
  ) returns jsonb language plpgsql as $$
  declare
    response record;
    reference text;
    response_status text;
    response_utr text;
    normalized_utr text;
    item_id uuid;
    paid_count integer := 0;
    cancelled_count integer := 0;
    result_rows jsonb := '[]'::jsonb;
    workforce_result jsonb;
    helper_result jsonb;
  begin
    if exists (
      select 1 from (
        select value as row_value from jsonb_array_elements(p_workforce_rows)
        union all
        select value as row_value from jsonb_array_elements(p_helper_rows)
      ) response_row
      where response_row.row_value ->> 'remarks' = 'TEST_UNKNOWN_P0001'
    ) then
      raise exception 'Synthetic systemic finalizer failure.';
    end if;
    for response in
      select 'workforce'::text audience, value from jsonb_array_elements(p_workforce_rows)
      union all
      select 'helpers'::text, value from jsonb_array_elements(p_helper_rows)
    loop
      reference := public.workforce_payout_bank_reference_canonical(response.value ->> 'reference_no');
      response_status := upper(response.value ->> 'status');
      response_utr := response.value ->> 'utr_cin';
      if response.audience = 'workforce' then
        select id into item_id from public.workforce_payout_payment_items
        where company_id = p_company_id and reference_no = reference;
        update public.workforce_payout_payment_items
        set status = case when response_status = 'PAID' then 'paid' else 'cancelled' end,
            utr_cin = nullif(response_utr, '')
        where id = item_id;
      else
        select id into item_id from public.helper_payout_payment_items
        where company_id = p_company_id and reference_no = reference;
        update public.helper_payout_payment_items
        set status = case when response_status = 'PAID' then 'paid' else 'cancelled' end,
            utr_cin = nullif(response_utr, '')
        where id = item_id;
      end if;
      if response_status = 'PAID' then
        normalized_utr := regexp_replace(upper(response_utr), '[^A-Z0-9]', '', 'g');
        insert into public.payout_bank_paid_transaction_registry(
          company_id, normalized_utr, payout_audience, payment_item_id, reference_no
        ) values (p_company_id, normalized_utr, response.audience, item_id, reference);
        paid_count := paid_count + 1;
      else
        cancelled_count := cancelled_count + 1;
      end if;
      result_rows := result_rows || jsonb_build_array(response.value || jsonb_build_object(
        'outcome', case when response_status = 'PAID' then 'paid' else 'cancelled' end
      ));
    end loop;
    workforce_result := case when jsonb_array_length(p_workforce_rows) > 0
      then jsonb_build_object('rows', p_workforce_rows) end;
    helper_result := case when jsonb_array_length(p_helper_rows) > 0
      then jsonb_build_object('rows', p_helper_rows) end;
    return jsonb_build_object(
      'paid', paid_count, 'cancelled', cancelled_count,
      'replayed_items', 0, 'rejected', 0, 'unknown', 0,
      'batch_ids', '[]'::jsonb, 'rows', result_rows,
      'ledgers', jsonb_strip_nulls(jsonb_build_object(
        'workforce', workforce_result, 'helpers', helper_result
      )), 'replayed', false
    );
  end $$;

  insert into public.companies values ('10000000-0000-4000-8000-000000000001');
  insert into auth.users values ('10000000-0000-4000-8000-000000000002');
  insert into public.workforce_payout_payment_batches values(
    '10000000-0000-4000-8000-000000000010', '999988887777', date '2026-10-17'
  );
  insert into public.helper_payout_payment_batches values(
    '10000000-0000-4000-8000-000000000011', '999988887777', date '2026-10-17'
  );
  insert into public.workforce_payout_payment_items values(
    '10000000-0000-4000-8000-000000000020',
    '10000000-0000-4000-8000-000000000001', 'WFDA1001092026V1',
    '10000000-0000-4000-8000-000000000100', 'processing', null,
    '10000000-0000-4000-8000-000000000010',
    '10000000-0000-4000-8000-000000000120'
  );
  insert into public.helper_payout_payment_items values(
    '10000000-0000-4000-8000-000000000021',
    '10000000-0000-4000-8000-000000000001', 'HPH1001092026V1',
    '10000000-0000-4000-8000-000000000101', 'processing', null,
    '10000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000121'
  );
  insert into public.payment_requests(
    id,company_id,request_no,location_id,status,approval_status,payment_mode,
    beneficiary_account_number,beneficiary_ifsc,amount,approval_cycle
  ) values (
    '10000000-0000-4000-8000-000000000030',
    '10000000-0000-4000-8000-000000000001', 'REQABC1234',
    '10000000-0000-4000-8000-000000000102', 'approved','FINAL_APPROVED',
    'account_transfer','123456789012','SBIN0000001',100.25,1
  );
  insert into public.hr_payroll_bank_lines values(
    '10000000-0000-4000-8000-000000000040',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000050','employee',
    '10000000-0000-4000-8000-000000000060','E100092026',200.50,
    '223456789012','HDFC0000001','999988887777',date '2026-10-17',
    'processing',null,null,now(),now()
  );
  insert into public.hr_payroll_bank_lines values(
    '10000000-0000-4000-8000-000000000041',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000051','employee',
    '10000000-0000-4000-8000-000000000061','E200092026',50.00,
    '323456789012','ICIC0000001','999988887777',date '2026-10-17',
    'processing',null,null,now(),now()
  );
  -- Historical paid line with no UTR: adding its evidence after migration must
  -- still claim the new central registry.
  insert into public.hr_payroll_bank_lines values(
    '10000000-0000-4000-8000-000000000042',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000052','employee',
    '10000000-0000-4000-8000-000000000062','E300092026',10.00,
    '423456789012','UTIB0000001','999988887777',date '2026-10-17',
    'paid',null,'Historical paid line',now(),now()
  );
  insert into public.hr_payroll_run_people(company_id,run_id,worker_type,worker_id,location_id) values
    ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000050','employee','10000000-0000-4000-8000-000000000060','10000000-0000-4000-8000-000000000103'),
    ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000051','employee','10000000-0000-4000-8000-000000000061','10000000-0000-4000-8000-000000000104'),
    ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000052','employee','10000000-0000-4000-8000-000000000062','10000000-0000-4000-8000-000000000105');
`);

await db.exec(executableMigration);
await db.exec(executablePartialMigration);
await db.exec(executableMigration);
await db.exec(executablePartialMigration);
await db.exec(executableDebitAccountPolicyMigration);
await db.exec(executableDebitAccountPolicyMigration);
await db.exec(executableReplayRowNumbersMigration);
await db.exec(executableReplayRowNumbersMigration);
const adhocExceptionsMigration = readFileSync(new URL(
  '../supabase/migrations/20261029141756_bank_response_adhoc_row_exceptions.sql', import.meta.url
), 'utf8');
await db.exec(adhocExceptionsMigration);
await db.exec(adhocExceptionsMigration);

const effectiveDefinitions = await db.query(`
  select pg_get_functiondef(signature::regprocedure) definition
  from unnest(array[
    'public.finalize_central_bank_response(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)',
    'public.finalize_central_bank_response_partially(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)'
  ]) signature
`);
const effectiveDefinitionText = effectiveDefinitions.rows
  .map((row) => row.definition)
  .join("\n");
assert.match(effectiveDefinitionText, /Response debit account is audit evidence only/i);
assert.doesNotMatch(
  effectiveDefinitionText,
  /Debit account does not match the generated (?:bank )?instruction/i
);
assert.doesNotMatch(
  effectiveDefinitionText,
  /v_debit_account\s*<>\s*public\.workforce_payout_bank_account_canonical\(v_expected_debit_account\)/i
);
assert.doesNotMatch(
  effectiveDefinitionText,
  /public\.workforce_payout_bank_account_canonical\(v_payroll_line\.debit_account_number\)/i
);
assert.match(effectiveDefinitionText, /replayed_row_numbers/i);
assert.match(effectiveDefinitionText, /successful replayed rows separately/i);

const rows = {
  workforce: [{
    row_number: 2, reference_no: "WFDA1001092026V1",
    debit_account: "111122223333", credit_account: "523456789012",
    ifsc: "SBIN0000002", value_date: "2026-10-17",
    debit_amount_paise: 30000, status: "PAID", utr_cin: "UTR-WORKFORCE-1", remarks: "Success"
  }],
  helpers: [{
    row_number: 3, reference_no: "HPH1001092026V1",
    debit_account: "222233334444", credit_account: "623456789012",
    ifsc: "SBIN0000003", value_date: "2026-10-17",
    debit_amount_paise: 40000, status: "CANCELLED", utr_cin: "", remarks: "Account closed"
  }],
  generic: [{
    row_number: 4, reference_no: "REQABC1234", debit_account: "999988887777",
    credit_account: "123456789012", ifsc: "SBIN0000001", value_date: "2026-10-17",
    debit_amount_paise: 10025, status: "PAID", utr_cin: "UTR-GENERIC-1", remarks: "Success"
  }],
  payroll: [{
    row_number: 5, reference_no: "E100092026", debit_account: "333344445555",
    credit_account: "223456789012", ifsc: "HDFC0000001", value_date: "2026-10-17",
    debit_amount_paise: 20050, status: "PAID", utr_cin: "UTR-PAYROLL-1", remarks: "Success"
  }, {
    row_number: 6, reference_no: "E200092026", debit_account: "444455556666",
    credit_account: "323456789012", ifsc: "ICIC0000001", value_date: "2026-10-17",
    debit_amount_paise: 5000, status: "RETURNED", utr_cin: "", remarks: "Name differs"
  }]
};

const call = ({ operationId, fileHash = "a".repeat(64), payload = rows }) => db.query(`
  select public.finalize_central_bank_response(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '${operationId}', '${fileHash}', 'federal-enquiry.xlsx',
    '${JSON.stringify(payload.workforce ?? [])}'::jsonb,
    '${JSON.stringify(payload.helpers ?? [])}'::jsonb,
    '${JSON.stringify(payload.generic ?? [])}'::jsonb,
    '${JSON.stringify(payload.payroll ?? [])}'::jsonb
  ) result
`);

const partialCall = ({ operationId, fileHash, payload }) => db.query(`
  select public.finalize_central_bank_response_partially(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '${operationId}', '${fileHash}', 'mixed-federal-enquiry.xlsx',
    '${JSON.stringify(payload.workforce ?? [])}'::jsonb,
    '${JSON.stringify(payload.helpers ?? [])}'::jsonb,
    '${JSON.stringify(payload.generic ?? [])}'::jsonb,
    '${JSON.stringify(payload.payroll ?? [])}'::jsonb
  ) result
`);

const resolver = await db.query(`
  select public.resolve_central_bank_response_references(
    '10000000-0000-4000-8000-000000000001',
    '["WFDA1001092026V1","HPH1001092026V1","REQABC1234","E100092026","UNKNOWN"]'::jsonb
  ) result
`);
assert.equal(resolver.rows[0].result.length, 4);
assert.deepEqual(resolver.rows[0].result.map((row) => row.ledger), [
  "workforce", "helpers", "payment_requests", "people_payroll"
]);
assert.equal(resolver.rows[0].result[3].location_id, "10000000-0000-4000-8000-000000000103");

const first = await call({ operationId: "10000000-0000-4000-8000-000000000070" });
const result = first.rows[0].result;
assert.equal(result.paid, 3);
assert.equal(result.cancelled, 2);
assert.equal(result.failed, 1);
assert.equal(result.replayed, false);
assert.equal(result.payment_request_events.length, 1);
assert.equal(result.payment_request_events[0].event_type, "payment_processed");
assert.deepEqual(result.payroll_run_ids, ["10000000-0000-4000-8000-000000000050"]);
assert.equal(result.ledgers.people_payroll.failed, 1);

let saved = await db.query(`select status,utr_cin from public.payment_requests where request_no='REQABC1234'`);
assert.deepEqual(saved.rows[0], { status: "processed", utr_cin: "UTR-GENERIC-1" });
saved = await db.query(`select status,utr from public.hr_payroll_bank_lines where reference='E100092026'`);
assert.deepEqual(saved.rows[0], { status: "paid", utr: "UTR-PAYROLL-1" });
saved = await db.query(`select status,bank_remarks from public.hr_payroll_bank_lines where reference='E200092026'`);
assert.deepEqual(saved.rows[0], { status: "failed", bank_remarks: "Name differs" });
assert.equal((await db.query(`select count(*)::integer count from public.payment_request_approvals`)).rows[0].count, 1);
assert.equal((await db.query(`select count(*)::integer count from public.test_hr_sync_calls`)).rows[0].count, 1);
assert.equal((await db.query(`select count(*)::integer count from public.central_bank_response_imports`)).rows[0].count, 1);
assert.equal((await db.query(`
  select normalized_payload -> 'workforce' -> 0 ->> 'debit_account' response_debit_account
  from public.central_bank_response_imports
`)).rows[0].response_debit_account, "111122223333");

const replay = await call({ operationId: "10000000-0000-4000-8000-000000000071" });
assert.equal(replay.rows[0].result.replayed, true);
assert.deepEqual(replay.rows[0].result.payment_request_events, []);
assert.deepEqual(replay.rows[0].result.payroll_run_ids, []);
assert.equal((await db.query(`select count(*)::integer count from public.payment_request_approvals`)).rows[0].count, 1);
assert.equal((await db.query(`select count(*)::integer count from public.test_hr_sync_calls`)).rows[0].count, 1);

await assert.rejects(
  call({
    operationId: "10000000-0000-4000-8000-000000000070",
    payload: { ...rows, helpers: [] }
  }),
  /operation ID was already used for a different file or scoped payload/
);
await assert.rejects(
  call({
    operationId: "10000000-0000-4000-8000-000000000070",
    payload: {
      ...rows,
      workforce: [{ ...rows.workforce[0], debit_account: "777788889999" }]
    }
  }),
  /operation ID was already used for a different file or scoped payload/
);

await db.exec(`
  update public.hr_payroll_bank_lines set utr='UTR-HISTORICAL-1'
  where reference='E300092026';
`);
assert.equal((await db.query(`
  select count(*)::integer count from public.central_bank_paid_transaction_registry
  where normalized_utr='UTRHISTORICAL1' and reference_no='E300092026'
`)).rows[0].count, 1);

await db.exec(`
  insert into public.hr_payroll_bank_lines values(
    '10000000-0000-4000-8000-000000000043',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000053','employee',
    '10000000-0000-4000-8000-000000000063','E400092026',10.00,
    '723456789012','UTIB0000002','999988887777',date '2026-10-17',
    'processing',null,null,now(),now()
  );
`);
await assert.rejects(
  db.exec(`update public.hr_payroll_bank_lines set status='paid',utr='UTR-WORKFORCE-1' where reference='E400092026'`),
  /already recorded for another paid instruction/
);

// The retained People Payroll uploader predates mandatory UTR capture. Keep
// that path compatible: a legacy PAID write with no UTR must still succeed and
// must not create a meaningless registry claim.
await db.exec(`
  insert into public.hr_payroll_bank_lines values(
    '10000000-0000-4000-8000-000000000044',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000054','employee',
    '10000000-0000-4000-8000-000000000064','E500092026',10.00,
    '823456789012','UTIB0000003','999988887777',date '2026-10-17',
    'processing',null,null,now(),now()
  );
  update public.hr_payroll_bank_lines
  set status='paid', utr=null, bank_remarks='Legacy People upload'
  where reference='E500092026';
`);
saved = await db.query(`
  select status,utr from public.hr_payroll_bank_lines where reference='E500092026'
`);
assert.deepEqual(saved.rows[0], { status: "paid", utr: null });
assert.equal((await db.query(`
  select count(*)::integer count from public.central_bank_paid_transaction_registry
  where entity_id='10000000-0000-4000-8000-000000000044'
`)).rows[0].count, 0);

// The central uploader is intentionally stricter than that retained screen.
// A PAID row with a placeholder UTR is rejected before any mutation.
const placeholderPaid = await call({
  operationId: "10000000-0000-4000-8000-000000000072",
  fileHash: "b".repeat(64),
  payload: {
    workforce: [], helpers: [], generic: [], payroll: [{
      row_number: 2, reference_no: "E400092026", debit_account: "999988887777",
      credit_account: "723456789012", ifsc: "UTIB0000002", value_date: "2026-10-17",
      debit_amount_paise: 1000, status: "PAID", utr_cin: "NA", remarks: "Success"
    }]
  }
});
assert.equal(placeholderPaid.rows[0].result.rejected, 1);
assert.equal(placeholderPaid.rows[0].result.ledgers.people_payroll.rows[0].outcome, "rejected");
saved = await db.query(`
  select status,utr from public.hr_payroll_bank_lines where reference='E400092026'
`);
assert.deepEqual(saved.rows[0], { status: "processing", utr: null });

// A row returned as rejected/unknown by the existing finalizer was examined,
// but was not processed. Keep it out of processed_rows while surfacing it in
// the row-error channel.
const partialPlaceholder = (await partialCall({
  operationId: "10000000-0000-4000-8000-000000000073",
  fileHash: "8".repeat(64),
  payload: {
    workforce: [], helpers: [], generic: [], payroll: [{
      row_number: 2, reference_no: "E400092026", debit_account: "999988887777",
      credit_account: "723456789012", ifsc: "UTIB0000002", value_date: "2026-10-17",
      debit_amount_paise: 1000, status: "PAID", utr_cin: "NA", remarks: "Success"
    }]
  }
})).rows[0].result;
assert.equal(partialPlaceholder.processed_rows, 0);
assert.equal(partialPlaceholder.error_rows, 1);
assert.equal(partialPlaceholder.rejected, 1);
assert.equal(partialPlaceholder.row_errors[0].reference_no, "E400092026");

// A different source debit account is accepted and retained. An unrelated
// value-date mismatch remains a row error without discarding the valid row.
await db.exec(`
  insert into public.workforce_payout_payment_items values
    ('10000000-0000-4000-8000-000000000025',
     '10000000-0000-4000-8000-000000000001', 'WFDA2001092026V1',
     '10000000-0000-4000-8000-000000000100', 'processing', null,
     '10000000-0000-4000-8000-000000000010',
     '10000000-0000-4000-8000-000000000125'),
    ('10000000-0000-4000-8000-000000000026',
     '10000000-0000-4000-8000-000000000001', 'WFDA3001092026V1',
     '10000000-0000-4000-8000-000000000100', 'processing', null,
     '10000000-0000-4000-8000-000000000010',
     '10000000-0000-4000-8000-000000000126');
`);
const mixedPayload = {
  workforce: [{
    row_number: 10, reference_no: "WFDA2001092026V1",
    debit_account: "111100000000", credit_account: "123400000001",
    ifsc: "SBIN0000001", value_date: "2026-10-17",
    debit_amount_paise: 10000, status: "PAID", utr_cin: "UTR-MIXED-VALID", remarks: "Success"
  }, {
    row_number: 11, reference_no: "WFDA3001092026V1",
    debit_account: "222200000000", credit_account: "123400000002",
    ifsc: "SBIN0000001", value_date: "2026-10-18",
    debit_amount_paise: 10000, status: "PAID", utr_cin: "UTR-MIXED-BAD", remarks: "Success"
  }],
  helpers: [], generic: [], payroll: []
};
const mixed = (await partialCall({
  operationId: "10000000-0000-4000-8000-000000000080",
  fileHash: "c".repeat(64),
  payload: mixedPayload
})).rows[0].result;
assert.equal(mixed.processed_rows, 1);
assert.equal(mixed.error_rows, 1);
assert.equal(mixed.paid, 1);
assert.equal(mixed.row_errors.length, 1);
assert.equal(mixed.row_errors[0].row_number, 11);
assert.equal(mixed.row_errors[0].reference_no, "WFDA3001092026V1");
assert.match(mixed.row_errors[0].message, /value date/i);
saved = await db.query(`
  select reference_no,status,utr_cin from public.workforce_payout_payment_items
  where reference_no in ('WFDA2001092026V1','WFDA3001092026V1') order by reference_no
`);
assert.deepEqual(saved.rows, [
  { reference_no: "WFDA2001092026V1", status: "paid", utr_cin: "UTR-MIXED-VALID" },
  { reference_no: "WFDA3001092026V1", status: "processing", utr_cin: null }
]);

const samePartialOperation = (await partialCall({
  operationId: "10000000-0000-4000-8000-000000000080",
  fileHash: "c".repeat(64),
  payload: mixedPayload
})).rows[0].result;
assert.equal(samePartialOperation.processed_rows, 1);
assert.equal(samePartialOperation.error_rows, 1);
await assert.rejects(
  partialCall({
    operationId: "10000000-0000-4000-8000-000000000080",
    fileHash: "c".repeat(64),
    payload: { ...mixedPayload, workforce: [mixedPayload.workforce[0]] }
  }),
  /operation ID was already used for a different file or complete payload/
);
await assert.rejects(
  partialCall({
    operationId: "10000000-0000-4000-8000-000000000080",
    fileHash: "7".repeat(64),
    payload: mixedPayload
  }),
  /operation ID was already used for a different file or complete payload/
);
assert.equal((await db.query(`
  select count(*)::integer count
  from public.central_bank_response_partial_operations
  where company_id='10000000-0000-4000-8000-000000000001'
    and operation_id='10000000-0000-4000-8000-000000000080'
`)).rows[0].count, 1);

// Re-uploading the same physical file replays the successful instruction and
// deterministically reports the still-invalid row; it does not mutate twice.
const mixedReplay = (await partialCall({
  operationId: "10000000-0000-4000-8000-000000000081",
  fileHash: "c".repeat(64),
  payload: mixedPayload
})).rows[0].result;
assert.equal(mixedReplay.processed_rows, 1);
assert.equal(mixedReplay.error_rows, 1);
assert.equal(mixedReplay.paid, 1);
assert.equal(mixedReplay.replayed, false, "the remaining row error keeps the file result partial");
assert.deepEqual(
  mixedReplay.replayed_row_numbers,
  [10],
  "the successful replayed row remains distinguishable inside a partial file result"
);
assert.equal(mixedReplay.row_errors[0].row_number, 11);
assert.match(mixedReplay.row_errors[0].message, /value date/i);
assert.equal((await db.query(`
  select count(*)::integer count from public.central_bank_response_imports
  where file_sha256='${"c".repeat(64)}'
`)).rows[0].count, 1, "the valid row reuses its original scoped import");
assert.equal((await db.query(`
  select count(*)::integer count from public.payout_bank_paid_transaction_registry
  where normalized_utr='UTRMIXEDVALID'
`)).rows[0].count, 1);

// Unknown explicit exceptions are systemic: the partial wrapper must rethrow
// instead of leaking the raw message as a row error or committing siblings.
await assert.rejects(
  partialCall({
    operationId: "10000000-0000-4000-8000-000000000089",
    fileHash: "9".repeat(64),
    payload: {
      workforce: [{
        ...mixedPayload.workforce[1],
        value_date: "2026-10-17",
        utr_cin: "UTR-SYSTEMIC-FAILURE",
        remarks: "TEST_UNKNOWN_P0001"
      }],
      helpers: [], generic: [], payroll: []
    }
  }),
  /Synthetic systemic finalizer failure/
);
saved = await db.query(`
  select status,utr_cin from public.workforce_payout_payment_items
  where reference_no='WFDA3001092026V1'
`);
assert.deepEqual(saved.rows[0], { status: "processing", utr_cin: null });

// Duplicate references and duplicate meaningful UTRs are conflict groups:
// reject every occurrence before processing so row order cannot decide which
// instruction wins.
await db.exec(`
  insert into public.workforce_payout_payment_items values
    ('10000000-0000-4000-8000-000000000027',
     '10000000-0000-4000-8000-000000000001', 'WFDA4001092026V1',
     '10000000-0000-4000-8000-000000000100', 'processing', null,
     '10000000-0000-4000-8000-000000000010',
     '10000000-0000-4000-8000-000000000127'),
    ('10000000-0000-4000-8000-000000000028',
     '10000000-0000-4000-8000-000000000001', 'WFDA5001092026V1',
     '10000000-0000-4000-8000-000000000100', 'processing', null,
     '10000000-0000-4000-8000-000000000010',
     '10000000-0000-4000-8000-000000000128'),
    ('10000000-0000-4000-8000-000000000029',
     '10000000-0000-4000-8000-000000000001', 'WFDA6001092026V1',
     '10000000-0000-4000-8000-000000000100', 'processing', null,
     '10000000-0000-4000-8000-000000000010',
     '10000000-0000-4000-8000-000000000129'),
    ('10000000-0000-4000-8000-00000000002a',
     '10000000-0000-4000-8000-000000000001', 'WFDA7001092026V1',
     '10000000-0000-4000-8000-000000000100', 'processing', null,
     '10000000-0000-4000-8000-000000000010',
     '10000000-0000-4000-8000-000000000130'),
    ('10000000-0000-4000-8000-00000000002b',
     '10000000-0000-4000-8000-000000000001', 'WFDA8001092026V1',
     '10000000-0000-4000-8000-000000000100', 'processing', null,
     '10000000-0000-4000-8000-000000000010',
     '10000000-0000-4000-8000-000000000131');
`);
const duplicateReference = (await partialCall({
  operationId: "10000000-0000-4000-8000-000000000082",
  fileHash: "d".repeat(64),
  payload: {
    workforce: [
      ...[20, 21].map((rowNumber) => ({
        row_number: rowNumber, reference_no: "WFDA4001092026V1",
        debit_account: "999988887777", credit_account: "123400000004",
        ifsc: "SBIN0000001", value_date: "2026-10-17", debit_amount_paise: 10000,
        status: "PAID", utr_cin: `UTR-DUP-REF-${rowNumber}`, remarks: "Success"
      })),
      ...[
        { row_number: 22, reference_no: "WFDA7001092026V1", utr_cin: "UTR-NON-CONFLICT-1" },
        { row_number: 23, reference_no: "WFDA8001092026V1", utr_cin: "UTR-NON-CONFLICT-2" }
      ].map((row) => ({
        ...row, debit_account: "999988887777", credit_account: `1234000000${row.row_number}`,
        ifsc: "SBIN0000001", value_date: "2026-10-17", debit_amount_paise: 10000,
        status: "PAID", remarks: "Success"
      }))
    ],
    helpers: [], generic: [], payroll: []
  }
})).rows[0].result;
assert.equal(duplicateReference.processed_rows, 2);
assert.equal(duplicateReference.error_rows, 2);
assert.equal(duplicateReference.paid, 2);
assert.deepEqual(duplicateReference.row_errors.map((error) => error.row_number), [20, 21]);
assert.ok(duplicateReference.row_errors.every((error) => /duplicate Customer Ref/i.test(error.message)));
saved = await db.query(`
  select reference_no,status from public.workforce_payout_payment_items
  where reference_no in ('WFDA4001092026V1','WFDA7001092026V1','WFDA8001092026V1')
  order by reference_no
`);
assert.deepEqual(saved.rows, [
  { reference_no: "WFDA4001092026V1", status: "processing" },
  { reference_no: "WFDA7001092026V1", status: "paid" },
  { reference_no: "WFDA8001092026V1", status: "paid" }
]);
assert.equal((await db.query(`
  select count(*)::integer count from public.central_bank_response_imports
  where file_sha256='${"d".repeat(64)}'
`)).rows[0].count, 1, "non-conflicting rows remain one batch even when conflict groups are rejected");

const duplicateUtr = (await partialCall({
  operationId: "10000000-0000-4000-8000-000000000083",
  fileHash: "e".repeat(64),
  payload: {
    workforce: [
      { row_number: 30, reference_no: "WFDA5001092026V1", credit_account: "123400000005" },
      { row_number: 31, reference_no: "WFDA6001092026V1", credit_account: "123400000006" }
    ].map((row) => ({
      ...row, debit_account: "999988887777", ifsc: "SBIN0000001",
      value_date: "2026-10-17", debit_amount_paise: 10000,
      status: "PAID", utr_cin: "UTR-SHARED-IN-FILE", remarks: "Success"
    })),
    helpers: [], generic: [], payroll: []
  }
})).rows[0].result;
assert.equal(duplicateUtr.processed_rows, 0);
assert.equal(duplicateUtr.error_rows, 2);
assert.deepEqual(duplicateUtr.row_errors.map((error) => error.row_number), [30, 31]);
assert.ok(duplicateUtr.row_errors.every((error) => /UTR/i.test(error.message)));
saved = await db.query(`
  select reference_no,status from public.workforce_payout_payment_items
  where reference_no in ('WFDA5001092026V1','WFDA6001092026V1') order by reference_no
`);
assert.deepEqual(saved.rows, [
  { reference_no: "WFDA5001092026V1", status: "processing" },
  { reference_no: "WFDA6001092026V1", status: "processing" }
]);

// Known value-date/ownership/UTR validations are classified in one set
// before finalization. Many bad rows therefore do not create a 2n-1 isolation
// tree, while all unrelated valid rows remain one central batch.
await db.exec(`
  insert into public.workforce_payout_payment_items
  select
    md5('partial-perf-item-' || sequence::text)::uuid,
    '10000000-0000-4000-8000-000000000001'::uuid,
    'WFPERF' || lpad(sequence::text, 4, '0') || '092026V1',
    md5('partial-perf-worker-' || sequence::text)::uuid,
    'processing', null,
    '10000000-0000-4000-8000-000000000010'::uuid,
    md5('partial-perf-source-' || sequence::text)::uuid
  from generate_series(1, 40) sequence;
`);
const prevalidationPayload = {
  workforce: Array.from({ length: 40 }, (_, index) => {
    const sequence = index + 1;
    return {
      row_number: 100 + sequence,
      reference_no: `WFPERF${String(sequence).padStart(4, "0")}092026V1`,
      debit_account: "000000000000",
      credit_account: `82340000${String(sequence).padStart(4, "0")}`,
      ifsc: "SBIN0000001",
      value_date: sequence % 10 === 0 ? "2026-10-17" : "2026-10-18",
      debit_amount_paise: 10000,
      status: "PAID", utr_cin: `UTR-PREVALIDATION-${sequence}`, remarks: "Success"
    };
  }),
  helpers: [], generic: [], payroll: []
};
const prevalidationResult = (await partialCall({
  operationId: "10000000-0000-4000-8000-000000000084",
  fileHash: "f".repeat(64),
  payload: prevalidationPayload
})).rows[0].result;
assert.equal(prevalidationResult.processed_rows, 4);
assert.equal(prevalidationResult.error_rows, 36);
assert.equal(prevalidationResult.paid, 4);
assert.ok(prevalidationResult.row_errors.every((error) => /value date/i.test(error.message)));
assert.equal((await db.query(`
  select count(*)::integer count from public.central_bank_response_imports
  where file_sha256='${"f".repeat(64)}'
`)).rows[0].count, 1, "all prevalidated rows are skipped and valid rows remain one batch");

const access = await db.query(`
  select
    has_function_privilege(
      'service_role',
      'public.finalize_central_bank_response(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)',
      'EXECUTE'
    ) service_finalize,
    has_function_privilege(
      'authenticated',
      'public.finalize_central_bank_response(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)',
      'EXECUTE'
    ) authenticated_finalize,
    has_function_privilege(
      'service_role',
      'public.resolve_central_bank_response_references(uuid,jsonb)',
      'EXECUTE'
    ) service_resolve,
    has_function_privilege(
      'authenticated',
      'public.resolve_central_bank_response_references(uuid,jsonb)',
      'EXECUTE'
    ) authenticated_resolve,
    has_function_privilege(
      'service_role',
      'public.finalize_central_bank_response_partially(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)',
      'EXECUTE'
    ) service_partial_finalize,
    has_function_privilege(
      'authenticated',
      'public.finalize_central_bank_response_partially(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)',
      'EXECUTE'
    ) authenticated_partial_finalize,
    has_table_privilege(
      'service_role',
      'public.central_bank_response_partial_operations',
      'SELECT'
    ) service_partial_operations_select,
    has_table_privilege(
      'authenticated',
      'public.central_bank_response_partial_operations',
      'SELECT,INSERT,UPDATE,DELETE'
    ) authenticated_partial_operations_access
`);
assert.equal(access.rows[0].service_finalize, true);
assert.equal(access.rows[0].authenticated_finalize, false);
assert.equal(access.rows[0].service_resolve, true);
assert.equal(access.rows[0].authenticated_resolve, false);
assert.equal(access.rows[0].service_partial_finalize, true);
assert.equal(access.rows[0].authenticated_partial_finalize, false);
assert.equal(access.rows[0].service_partial_operations_select, true);
assert.equal(access.rows[0].authenticated_partial_operations_access, false);

// Exercise the real partial finalizer with a trigger raising each established
// ad hoc financial guard. Valid siblings must reconcile; conflicts keep their
// unpaid state, appear by source row, and stay exceptions on replay.
await db.exec(`
  create function test_adhoc_conflict() returns trigger language plpgsql as $$
  begin
    if new.request_no='ADHOCDUP' and new.status='processed' then
      raise exception 'This associate already has a paid ad hoc request for this location and work date';
    elsif new.request_no='ADHOCFINAL' and new.status='processed' then
      raise exception 'This work date is already in a finalized Workforce payout. Finance must review it before paying ad hoc';
    end if;
    return new;
  end $$;
  create trigger test_adhoc_conflict before update on payment_requests
    for each row execute function test_adhoc_conflict();
  insert into payment_requests(id,company_id,request_no,location_id,status,approval_status,payment_mode,
    beneficiary_account_number,beneficiary_ifsc,amount)
  select gen_random_uuid(),'10000000-0000-4000-8000-000000000001',ref,
    '10000000-0000-4000-8000-000000000102','processing','PROCESSING','account_transfer','123456789012','SBIN0000001',100
  from unnest(array['ADHOCVALID','ADHOCDUP','ADHOCFINAL']) ref;
`);
const adhocPayload={workforce:[],helpers:[],payroll:[],generic:['ADHOCVALID','ADHOCDUP','ADHOCFINAL'].map((ref,i)=>({
  ...rows.generic[0],row_number:101+i,reference_no:ref,debit_amount_paise:10000,utr_cin:`TEST-${ref}`
}))};
for (const operationId of ['10000000-0000-4000-8000-000000000e01','10000000-0000-4000-8000-000000000e02']) {
  const result=(await partialCall({operationId,fileHash:'e'.repeat(64),payload:adhocPayload})).rows[0].result;
  assert.equal(result.processed_rows,1);
  assert.equal(result.error_rows,2);
  assert.deepEqual(result.row_errors.map(r=>r.row_number),[102,103]);
  assert.match(result.row_errors[0].message,/already has a paid ad hoc/);
  assert.match(result.row_errors[1].message,/finalized Workforce payout/);
}
assert.deepEqual((await db.query("select request_no,status from payment_requests where request_no like 'ADHOC%' order by request_no")).rows,[
  {request_no:'ADHOCDUP',status:'processing'},
  {request_no:'ADHOCFINAL',status:'processing'},
  {request_no:'ADHOCVALID',status:'processed'}
]);
assert.equal((await db.query("select count(*)::integer n from payment_request_approvals a join payment_requests r on r.id=a.payment_request_id where r.request_no='ADHOCVALID' and a.action='processed'")).rows[0].n,1);
console.log("Central bank response finalizer verification passed, including ad hoc row exceptions and replay.");
