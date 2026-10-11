import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL(
  "../supabase/migrations/20261011120000_atomic_mixed_payout_bank_response.sql",
  import.meta.url
), "utf8");
const executableMigration = migration.replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

assert.match(migration, /security definer[\s\S]*?set search_path = ''/i);
assert.match(migration, /from public\.workforce_payout_payment_items item[\s\S]*?item\.company_id = p_company_id/i);
assert.match(migration, /from public\.helper_payout_payment_items item[\s\S]*?item\.company_id = p_company_id/i);
assert.match(migration, /public\.workforce_finalize_payout_payment_response\(/i);
assert.match(migration, /public\.helper_finalize_payout_payment_response\(/i);
assert.ok(
  migration.indexOf("public.workforce_finalize_payout_payment_response(")
    < migration.indexOf("public.helper_finalize_payout_payment_response("),
  "mixed finalization must use one deterministic ledger order"
);
assert.doesNotMatch(migration, /exception\s+when/i, "a caught ledger error would break atomic rollback");
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
  create table public.workforce_payout_payment_items(
    company_id uuid not null,
    reference_no text not null,
    primary key(company_id, reference_no)
  );
  create table public.helper_payout_payment_items(
    company_id uuid not null,
    reference_no text not null,
    primary key(company_id, reference_no)
  );
  create table public.test_payout_finalization_calls(
    audience text not null,
    company_id uuid not null,
    operation_id uuid not null,
    reference_no text not null
  );

  create function public.workforce_payout_bank_reference_canonical(p_value text)
  returns text language sql immutable as $$
    select regexp_replace(upper(coalesce(p_value, '')), '[[:space:]]', '', 'g')
  $$;

  create function public.workforce_finalize_payout_payment_response(
    p_company_id uuid,
    p_actor_user_id uuid,
    p_operation_id uuid,
    p_file_sha256 text,
    p_file_name text,
    p_rows jsonb
  ) returns jsonb language plpgsql as $$
  begin
    if exists (
      select 1 from jsonb_array_elements(p_rows) row(value)
      where coalesce((row.value ->> 'force_error')::boolean, false)
    ) then
      raise exception 'forced Workforce finalizer failure';
    end if;
    insert into public.test_payout_finalization_calls(
      audience, company_id, operation_id, reference_no
    )
    select 'workforce', p_company_id, p_operation_id, row.value ->> 'reference_no'
    from jsonb_array_elements(p_rows) row(value);
    return jsonb_build_object(
      'response_import_id', '10000000-0000-4000-8000-000000000011',
      'replayed', false,
      'paid', jsonb_array_length(p_rows),
      'cancelled', 0,
      'replayed_items', 0,
      'rejected', 0,
      'unknown', 0,
      'batch_ids', jsonb_build_array('workforce-batch'),
      'rows', p_rows
    );
  end $$;

  create function public.helper_finalize_payout_payment_response(
    p_company_id uuid,
    p_actor_user_id uuid,
    p_operation_id uuid,
    p_file_sha256 text,
    p_file_name text,
    p_rows jsonb
  ) returns jsonb language plpgsql as $$
  begin
    if exists (
      select 1 from jsonb_array_elements(p_rows) row(value)
      where coalesce((row.value ->> 'force_error')::boolean, false)
    ) then
      raise exception 'forced Helper finalizer failure';
    end if;
    insert into public.test_payout_finalization_calls(
      audience, company_id, operation_id, reference_no
    )
    select 'helpers', p_company_id, p_operation_id, row.value ->> 'reference_no'
    from jsonb_array_elements(p_rows) row(value);
    return jsonb_build_object(
      'response_import_id', '10000000-0000-4000-8000-000000000012',
      'replayed', false,
      'paid', jsonb_array_length(p_rows),
      'cancelled', 0,
      'replayed_items', 0,
      'rejected', 0,
      'unknown', 0,
      'batch_ids', jsonb_build_array('helper-batch'),
      'rows', p_rows
    );
  end $$;

  insert into public.companies(id)
  values ('10000000-0000-4000-8000-000000000001');
  insert into auth.users(id)
  values ('10000000-0000-4000-8000-000000000002');
  insert into public.workforce_payout_payment_items(company_id, reference_no)
  values (
    '10000000-0000-4000-8000-000000000001',
    'WPD1001092026V1'
  );
  insert into public.helper_payout_payment_items(company_id, reference_no)
  values (
    '10000000-0000-4000-8000-000000000001',
    'HPD2001092026V1'
  );
`);

await db.exec(executableMigration);

const call = ({ operationId, workforceRows, helperRows }) => db.query(`
  select public.finalize_owned_payout_payment_response(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '${operationId}',
    repeat('a', 64),
    'federal-response.xlsx',
    '${JSON.stringify(workforceRows)}'::jsonb,
    '${JSON.stringify(helperRows)}'::jsonb
  ) as result
`);

const mixed = await call({
  operationId: "10000000-0000-4000-8000-000000000021",
  workforceRows: [{ row_number: 8, reference_no: "WPD1001092026V1" }],
  helperRows: [{ row_number: 3, reference_no: "HPD2001092026V1" }]
});
const mixedResult = mixed.rows[0]?.result;
assert.equal(mixedResult.paid, 2);
assert.deepEqual(mixedResult.batch_ids, ["helper-batch", "workforce-batch"]);
assert.deepEqual(mixedResult.rows.map((row) => row.row_number), [3, 8]);
assert.ok(mixedResult.ledgers.workforce);
assert.ok(mixedResult.ledgers.helpers);
assert.equal(mixedResult.replayed, false);

await db.exec("truncate public.test_payout_finalization_calls");
const workforceOnly = await call({
  operationId: "10000000-0000-4000-8000-000000000022",
  workforceRows: [{ row_number: 1, reference_no: "WPD1001092026V1" }],
  helperRows: []
});
assert.equal(workforceOnly.rows[0]?.result.paid, 1);
assert.deepEqual(Object.keys(workforceOnly.rows[0]?.result.ledgers), ["workforce"]);

await db.exec("truncate public.test_payout_finalization_calls");
const helperOnly = await call({
  operationId: "10000000-0000-4000-8000-000000000023",
  workforceRows: [],
  helperRows: [{ row_number: 1, reference_no: "HPD2001092026V1" }]
});
assert.equal(helperOnly.rows[0]?.result.paid, 1);
assert.deepEqual(Object.keys(helperOnly.rows[0]?.result.ledgers), ["helpers"]);

await db.exec("truncate public.test_payout_finalization_calls");
await assert.rejects(
  call({
    operationId: "10000000-0000-4000-8000-000000000024",
    workforceRows: [{ row_number: 1, reference_no: "WPFOREIGN092026V1" }],
    helperRows: []
  }),
  /Every Workforce response row must reference a payment owned by this company/
);
let calls = await db.query("select count(*)::integer as count from public.test_payout_finalization_calls");
assert.equal(calls.rows[0]?.count, 0, "unowned rows must not reach a ledger finalizer");

await assert.rejects(
  call({
    operationId: "10000000-0000-4000-8000-000000000025",
    workforceRows: [{ row_number: 1, reference_no: "WPD1001092026V1" }],
    helperRows: [{ row_number: 2, reference_no: "HPD2001092026V1", force_error: true }]
  }),
  /forced Helper finalizer failure/
);
calls = await db.query("select count(*)::integer as count from public.test_payout_finalization_calls");
assert.equal(calls.rows[0]?.count, 0, "a Helper failure must roll back the earlier Workforce mutation");

const access = await db.query(`
  select
    has_function_privilege(
      'service_role',
      'public.finalize_owned_payout_payment_response(uuid,uuid,uuid,text,text,jsonb,jsonb)',
      'EXECUTE'
    ) as service_execute,
    has_function_privilege(
      'authenticated',
      'public.finalize_owned_payout_payment_response(uuid,uuid,uuid,text,text,jsonb,jsonb)',
      'EXECUTE'
    ) as authenticated_execute
`);
assert.equal(access.rows[0]?.service_execute, true);
assert.equal(access.rows[0]?.authenticated_execute, false);

console.log("Atomic mixed payout bank response verification passed.");
