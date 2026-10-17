import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL(
  "../supabase/migrations/20261017123000_central_bank_response_finalizer.sql",
  import.meta.url
), "utf8");
const executableMigration = migration.replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

assert.match(migration, /create table if not exists public\.central_bank_response_imports/i);
assert.match(migration, /normalized_payload_hash/i);
assert.match(migration, /create table if not exists public\.central_bank_paid_transaction_registry/i);
assert.match(migration, /create or replace function public\.resolve_central_bank_response_references/i);
assert.match(migration, /create or replace function public\.finalize_central_bank_response/i);
assert.match(migration, /public\.finalize_owned_payout_payment_response\(/i);
assert.match(migration, /public\.hr_sync_paid_pay_documents\(/i);
assert.match(migration, /pg_advisory_xact_lock[\s\S]*central-bank-paid-utr/i);
assert.match(migration, /from public, anon, authenticated, service_role/i);
assert.match(migration, /to service_role/i);

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
await db.exec(executableMigration);

const rows = {
  workforce: [{
    row_number: 2, reference_no: "WFDA1001092026V1",
    debit_account: "999988887777", credit_account: "523456789012",
    ifsc: "SBIN0000002", value_date: "2026-10-17",
    debit_amount_paise: 30000, status: "PAID", utr_cin: "UTR-WORKFORCE-1", remarks: "Success"
  }],
  helpers: [{
    row_number: 3, reference_no: "HPH1001092026V1",
    debit_account: "999988887777", credit_account: "623456789012",
    ifsc: "SBIN0000003", value_date: "2026-10-17",
    debit_amount_paise: 40000, status: "CANCELLED", utr_cin: "", remarks: "Account closed"
  }],
  generic: [{
    row_number: 4, reference_no: "REQABC1234", debit_account: "999988887777",
    credit_account: "123456789012", ifsc: "SBIN0000001", value_date: "2026-10-17",
    debit_amount_paise: 10025, status: "PAID", utr_cin: "UTR-GENERIC-1", remarks: "Success"
  }],
  payroll: [{
    row_number: 5, reference_no: "E100092026", debit_account: "999988887777",
    credit_account: "223456789012", ifsc: "HDFC0000001", value_date: "2026-10-17",
    debit_amount_paise: 20050, status: "PAID", utr_cin: "UTR-PAYROLL-1", remarks: "Success"
  }, {
    row_number: 6, reference_no: "E200092026", debit_account: "999988887777",
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
    ) authenticated_resolve
`);
assert.equal(access.rows[0].service_finalize, true);
assert.equal(access.rows[0].authenticated_finalize, false);
assert.equal(access.rows[0].service_resolve, true);
assert.equal(access.rows[0].authenticated_resolve, false);

console.log("Central bank response finalizer verification passed.");
