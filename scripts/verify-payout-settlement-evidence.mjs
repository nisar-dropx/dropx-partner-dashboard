import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../supabase/migrations/20261013110000_payout_payment_settlement_evidence_manual_finalize.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

const db = new PGlite();
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const company = id(1);
const actor = id(2);
const workforce = id(3);
const helper = id(4);
const workforceBatch = id(5);
const helperBatch = id(6);
const workforceImport = id(7);
const helperImport = id(8);
const workforceItem = id(9);
const helperItem = id(10);
const workforceOperation = id(11);
const helperOperation = id(12);
const station = id(13);

const workforceLegacyRows = [{
  row_number: 2,
  reference_no: "WFDF1001092026V1",
  credit_account: "112233445566",
  ifsc: "ABCD0123456",
  debit_amount_paise: "10000",
  status: "PAID",
  utr_cin: "WFUTR1001",
  remarks: "Paid by bank"
}];
const helperLegacyRows = [{
  row_number: 3,
  reference_no: "HPH1001092026V1",
  credit_account: "998877665544",
  ifsc: "WXYZ0123456",
  debit_amount_paise: "7500",
  status: "PAID",
  utr_cin: "HPUTR1001",
  remarks: "Helper paid"
}];
const workforceReplayRows = [{
  ...workforceLegacyRows[0],
  debit_account: "0000111122223333",
  value_date: "2026-10-12"
}];
const helperReplayRows = [{
  ...helperLegacyRows[0],
  debit_account: "4444555566667777",
  value_date: "2026-10-13"
}];

await db.exec(`
  create schema auth;
  create role anon;
  create role authenticated;
  create role service_role bypassrls;

  create table auth.users(id uuid primary key);
  create table public.companies(id uuid primary key);
  create table public.workforce(
    id uuid primary key,
    company_id uuid not null,
    unique(company_id, id)
  );
  create table public.helpers(
    id uuid primary key,
    company_id uuid not null,
    unique(company_id, id)
  );

  create table public.workforce_payout_payment_batches(
    id uuid primary key,
    company_id uuid not null,
    debit_account_no_snapshot text not null,
    value_date date not null,
    status text not null default 'processing',
    updated_at timestamptz not null default clock_timestamp(),
    completed_at timestamptz
  );
  create table public.helper_payout_payment_batches(
    id uuid primary key,
    company_id uuid not null,
    debit_account_no_snapshot text not null,
    value_date date not null,
    status text not null default 'processing',
    updated_at timestamptz not null default clock_timestamp(),
    completed_at timestamptz
  );

  create table public.workforce_payout_payment_response_imports(
    id uuid primary key,
    company_id uuid not null,
    operation_id uuid not null,
    file_sha256 text not null,
    file_name text not null,
    normalized_rows jsonb not null,
    batch_ids uuid[] not null default '{}',
    result_snapshot jsonb not null default '{}',
    imported_by uuid not null,
    unique(company_id, operation_id),
    unique(company_id, file_sha256)
  );
  create table public.helper_payout_payment_response_imports(
    id uuid primary key,
    company_id uuid not null,
    operation_id uuid not null,
    file_sha256 text not null,
    file_name text not null,
    normalized_rows jsonb not null,
    batch_ids uuid[] not null default '{}',
    result_snapshot jsonb not null default '{}',
    imported_by uuid not null,
    unique(company_id, operation_id),
    unique(company_id, file_sha256)
  );

  create table public.workforce_payout_payment_items(
    id uuid primary key,
    company_id uuid not null,
    batch_id uuid not null,
    workforce_id uuid not null,
    period_start date not null,
    period_end date not null,
    instruction_amount numeric(14,2) not null,
    status text not null,
    bank_response_status text,
    utr_cin text,
    bank_processing_remarks text,
    response_import_id uuid,
    finalized_by uuid,
    finalized_at timestamptz,
    bank_account_no_snapshot text not null,
    ifsc_snapshot text not null,
    location_id_snapshot uuid,
    location_code_snapshot text,
    reference_no text not null,
    payment_version integer not null default 1,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    constraint workforce_payout_payment_items_state_check check (true)
  );
  create table public.helper_payout_payment_items(
    id uuid primary key,
    company_id uuid not null,
    batch_id uuid not null,
    helper_id uuid not null,
    period_start date not null,
    period_end date not null,
    instruction_amount numeric(14,2) not null,
    status text not null,
    bank_response_status text,
    utr_cin text,
    bank_processing_remarks text,
    response_import_id uuid,
    finalized_by uuid,
    finalized_at timestamptz,
    bank_account_no_snapshot text not null,
    ifsc_snapshot text not null,
    location_id_snapshot uuid,
    location_code_snapshot text,
    reference_no text not null,
    payment_version integer not null default 1,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    constraint helper_payout_payment_items_state_check check (true)
  );

  create table public.workforce_payout_payment_allocations(
    id uuid primary key,
    company_id uuid not null,
    payment_item_id uuid not null,
    publication_id uuid not null,
    station_id uuid not null,
    instruction_amount_snapshot numeric(14,2) not null,
    created_at timestamptz not null default clock_timestamp()
  );
  create table public.workforce_payout_payment_credit_transfers(
    company_id uuid not null,
    payment_allocation_id uuid not null,
    destination_workforce_id uuid not null,
    sequence_no integer not null
  );

  create table public.workforce_payout_payment_events(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    batch_id uuid,
    payment_item_id uuid,
    response_import_id uuid,
    operation_id uuid,
    event_type text not null,
    event_data jsonb not null default '{}',
    actor_user_id uuid,
    created_at timestamptz not null default clock_timestamp()
  );
  create table public.helper_payout_payment_events(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    batch_id uuid,
    payment_item_id uuid,
    response_import_id uuid,
    operation_id uuid,
    event_type text not null,
    event_data jsonb not null default '{}',
    actor_user_id uuid,
    created_at timestamptz not null default clock_timestamp()
  );

  create or replace function public.workforce_payout_bank_account_canonical(p_value text)
  returns text language sql immutable set search_path = '' as $$
    select regexp_replace(upper(btrim(coalesce(p_value, ''))), '[^A-Z0-9]', '', 'g')
  $$;
  create or replace function public.workforce_payout_bank_ifsc_canonical(p_value text)
  returns text language sql immutable set search_path = '' as $$
    select regexp_replace(upper(btrim(coalesce(p_value, ''))), '[^A-Z0-9]', '', 'g')
  $$;
  create or replace function public.workforce_payout_bank_reference_canonical(p_value text)
  returns text language sql immutable set search_path = '' as $$
    select regexp_replace(upper(btrim(coalesce(p_value, ''))), '[^A-Z0-9]', '', 'g')
  $$;
  create or replace function public.lock_workforce_payment_allocation_company(p_company_id uuid)
  returns void language plpgsql set search_path = '' as $$ begin return; end $$;

  create or replace function public.guard_workforce_payout_payment_item_ledger()
  returns trigger language plpgsql as $$ begin return case when tg_op = 'DELETE' then old else new end; end $$;
  create trigger workforce_payout_payment_items_00_ledger_guard
    before insert or update or delete on public.workforce_payout_payment_items
    for each row execute function public.guard_workforce_payout_payment_item_ledger();
  create or replace function public.guard_helper_payout_payment_item_ledger()
  returns trigger language plpgsql as $$ begin return case when tg_op = 'DELETE' then old else new end; end $$;
  create trigger helper_payout_payment_items_00_ledger_guard
    before insert or update or delete on public.helper_payout_payment_items
    for each row execute function public.guard_helper_payout_payment_item_ledger();

  insert into auth.users values ('${actor}');
  insert into public.companies values ('${company}');
  insert into public.workforce values ('${workforce}', '${company}');
  insert into public.helpers values ('${helper}', '${company}');
  insert into public.workforce_payout_payment_batches(
    id, company_id, debit_account_no_snapshot, value_date, status
  ) values ('${workforceBatch}', '${company}', 'LEGACYWFDEBIT', '2026-09-30', 'completed');
  insert into public.helper_payout_payment_batches(
    id, company_id, debit_account_no_snapshot, value_date, status
  ) values ('${helperBatch}', '${company}', 'LEGACYHPDEBIT', '2026-09-30', 'completed');
  insert into public.workforce_payout_payment_response_imports(
    id, company_id, operation_id, file_sha256, file_name, normalized_rows,
    batch_ids, result_snapshot, imported_by
  ) values (
    '${workforceImport}', '${company}', '${workforceOperation}', repeat('a', 64),
    'legacy-workforce.xlsx', '${JSON.stringify(workforceLegacyRows)}'::jsonb,
    array['${workforceBatch}'::uuid], '{"paid":1}'::jsonb, '${actor}'
  );
  insert into public.helper_payout_payment_response_imports(
    id, company_id, operation_id, file_sha256, file_name, normalized_rows,
    batch_ids, result_snapshot, imported_by
  ) values (
    '${helperImport}', '${company}', '${helperOperation}', repeat('b', 64),
    'legacy-helper.xlsx', '${JSON.stringify(helperLegacyRows)}'::jsonb,
    array['${helperBatch}'::uuid], '{"paid":1}'::jsonb, '${actor}'
  );
  insert into public.workforce_payout_payment_items(
    id, company_id, batch_id, workforce_id, period_start, period_end,
    instruction_amount, status, bank_response_status, utr_cin,
    bank_processing_remarks, response_import_id, finalized_by, finalized_at,
    bank_account_no_snapshot, ifsc_snapshot, location_id_snapshot,
    location_code_snapshot, reference_no
  ) values (
    '${workforceItem}', '${company}', '${workforceBatch}', '${workforce}',
    '2026-09-01', '2026-09-30', 100.00, 'paid', 'PAID', 'WFUTR1001',
    'Paid by bank', '${workforceImport}', '${actor}', clock_timestamp(),
    'LEGACYWFCREDIT', 'OLDW0000001', '${station}', 'WF01', 'WFDF1001092026V1'
  );
  insert into public.helper_payout_payment_items(
    id, company_id, batch_id, helper_id, period_start, period_end,
    instruction_amount, status, bank_response_status, utr_cin,
    bank_processing_remarks, response_import_id, finalized_by, finalized_at,
    bank_account_no_snapshot, ifsc_snapshot, location_id_snapshot,
    location_code_snapshot, reference_no
  ) values (
    '${helperItem}', '${company}', '${helperBatch}', '${helper}',
    '2026-09-01', '2026-09-30', 75.00, 'paid', 'PAID', 'HPUTR1001',
    'Helper paid', '${helperImport}', '${actor}', clock_timestamp(),
    'LEGACYHPCREDIT', 'OLDH0000001', '${station}', 'HP01', 'HPH1001092026V1'
  );
`);

const responseFinalizer = (ledger) => `
  create or replace function public.${ledger}_finalize_payout_payment_response(
    p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
    p_file_sha256 text, p_file_name text, p_rows jsonb
  ) returns jsonb language plpgsql security definer set search_path = '' as $function$
  declare
    v_existing public.${ledger}_payout_payment_response_imports%rowtype;
    v_item public.${ledger}_payout_payment_items%rowtype;
    v_account text := '';
    v_ifsc text := '';
  begin
    if false
      OR (v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot))
      OR (v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot))
    then raise exception 'unreachable'; end if;
    select imported.* into v_existing
    from public.${ledger}_payout_payment_response_imports imported
    where imported.company_id = p_company_id and imported.operation_id = p_operation_id;
    if found then
      if v_existing.normalized_rows is distinct from p_rows then raise exception 'different payload'; end if;
      return v_existing.result_snapshot || jsonb_build_object('replayed', true);
    end if;
    select imported.* into v_existing
    from public.${ledger}_payout_payment_response_imports imported
    where imported.company_id = p_company_id and imported.file_sha256 = p_file_sha256;
    if found then
      if v_existing.normalized_rows is distinct from p_rows then raise exception 'different payload'; end if;
      return v_existing.result_snapshot || jsonb_build_object('replayed', true);
    end if;
    select imported.* into v_existing
    from public.${ledger}_payout_payment_response_imports imported
    where imported.company_id = p_company_id and imported.operation_id = p_operation_id;
    if found then
      if v_existing.normalized_rows is distinct from p_rows then raise exception 'different payload'; end if;
      return v_existing.result_snapshot || jsonb_build_object('replayed', true);
    end if;
    select imported.* into v_existing
    from public.${ledger}_payout_payment_response_imports imported
    where imported.company_id = p_company_id and imported.file_sha256 = p_file_sha256;
    if found then
      if v_existing.normalized_rows is distinct from p_rows then raise exception 'different payload'; end if;
      return v_existing.result_snapshot || jsonb_build_object('replayed', true);
    end if;
    raise exception 'no matching response import';
  end
  $function$;
`;

await db.exec(responseFinalizer("workforce"));
await db.exec(responseFinalizer("helper"));

const patchTarget = (name, args) => `
  create or replace function public.${name}(${args})
  returns jsonb language plpgsql set search_path = '' as $function$
  declare v_paid numeric;
  begin
    select sum(item.instruction_amount) filter (where item.status = 'paid')
    into v_paid from public.workforce_payout_payment_items item;
    return jsonb_build_object('paid', coalesce(v_paid, 0));
  end
  $function$;
`;

await db.exec([
  patchTarget("workforce_payout_payment_candidates", "uuid,date,date,uuid[]"),
  patchTarget("workforce_payout_payment_row_candidates", "uuid,date,date,jsonb"),
  patchTarget("workforce_preview_payout_payment_rows", "uuid,date,date,jsonb"),
  patchTarget("workforce_mapping_paid_history_preview", "uuid,uuid,uuid,date"),
  patchTarget(
    "workforce_replace_joining_mapping_with_payment_decision",
    "uuid,uuid,uuid,uuid,text,jsonb,uuid[],text,text,text,uuid"
  ),
  `create or replace function public.helper_payout_payment_row_candidates(uuid,date,date,jsonb)
   returns jsonb language plpgsql set search_path = '' as $function$
   declare v_paid numeric;
   begin
     select sum(item.instruction_amount) filter (where item.status = 'paid')
     into v_paid from public.helper_payout_payment_items item;
     return jsonb_build_object('paid', coalesce(v_paid, 0));
   end
   $function$;`
].join("\n"));

await db.exec(migration);

const guardDefinition = await db.query(`
  select pg_get_functiondef(
    'public.guard_workforce_payout_payment_item_ledger()'::regprocedure
  ) definition
`);
assert.match(guardDefinition.rows[0].definition, /different Workforce bank batch is already processing/i);

const paidAllocationView = await db.query(`
  select pg_get_viewdef('public.workforce_payout_effective_paid_allocations'::regclass, true) definition
`);
assert.equal(
  (paidAllocationView.rows[0].definition.match(/settled_amount_snapshot > 0/g) ?? []).length,
  2
);

await db.query(
  `select public.workforce_finalize_payout_payment_response($1,$2,$3,$4,$5,$6::jsonb)`,
  [company, actor, workforceOperation, "a".repeat(64), "legacy-workforce.xlsx", JSON.stringify(workforceReplayRows)]
);
await db.query(
  `select public.helper_finalize_payout_payment_response($1,$2,$3,$4,$5,$6::jsonb)`,
  [company, actor, helperOperation, "b".repeat(64), "legacy-helper.xlsx", JSON.stringify(helperReplayRows)]
);

const workforceEvidence = await db.query(`
  select status, settled_amount, response_debit_account_no, response_value_date::text,
    response_credit_account_no, response_ifsc
  from public.workforce_payout_payment_items where id = '${workforceItem}'
`);
assert.deepEqual(workforceEvidence.rows[0], {
  status: "paid",
  settled_amount: "100.00",
  response_debit_account_no: "0000111122223333",
  response_value_date: "2026-10-12",
  response_credit_account_no: "112233445566",
  response_ifsc: "ABCD0123456"
});

const helperEvidence = await db.query(`
  select status, settled_amount, response_debit_account_no, response_value_date::text,
    response_credit_account_no, response_ifsc
  from public.helper_payout_payment_items where id = '${helperItem}'
`);
assert.deepEqual(helperEvidence.rows[0], {
  status: "paid",
  settled_amount: "75.00",
  response_debit_account_no: "4444555566667777",
  response_value_date: "2026-10-13",
  response_credit_account_no: "998877665544",
  response_ifsc: "WXYZ0123456"
});

const counts = await db.query(`
  select
    (select count(*)::integer from public.workforce_payout_payment_response_imports) workforce_imports,
    (select count(*)::integer from public.helper_payout_payment_response_imports) helper_imports,
    (select count(*)::integer from public.workforce_payout_payment_events) workforce_events,
    (select count(*)::integer from public.helper_payout_payment_events) helper_events
`);
assert.deepEqual(counts.rows[0], {
  workforce_imports: 1,
  helper_imports: 1,
  workforce_events: 0,
  helper_events: 0
});

await assert.rejects(
  db.query(
    `select public.enrich_workforce_payout_response_evidence_on_replay($1,$2,$3::jsonb)`,
    [
      company,
      workforceImport,
      JSON.stringify([{ ...workforceReplayRows[0], debit_amount_paise: "9999" }])
    ]
  ),
  /exact stored core-row match/i
);

await assert.rejects(
  db.exec(`
    update public.workforce_payout_payment_items
    set response_debit_account_no = 'UNAUTHORIZED'
    where id = '${workforceItem}'
  `),
  /only by the bank-processing RPCs/i
);
await assert.rejects(
  db.exec(`
    update public.helper_payout_payment_items
    set response_debit_account_no = 'UNAUTHORIZED'
    where id = '${helperItem}'
  `),
  /only by bank-processing RPCs/i
);

console.log("Payout settlement evidence migration verification passed.");
