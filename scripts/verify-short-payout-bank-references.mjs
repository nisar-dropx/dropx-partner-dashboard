import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL(
  "../supabase/migrations/20261011180000_short_payout_bank_references.sql",
  import.meta.url
), "utf8");
const executableMigration = migration.replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

assert.match(migration, /v_reference := 'WF' \|\| v_normalized_id[\s\S]*?'MMYYYY'[\s\S]*?'V' \|\| p_version::text/i);
assert.match(migration, /v_reference := 'HP' \|\| v_normalized_id[\s\S]*?'MMYYYY'[\s\S]*?'V' \|\| p_version::text/i);
assert.doesNotMatch(migration, /v_reference := 'HP'[\s\S]{0,200}v_helper_key/i);
assert.match(migration, /reference_no ~ '\^\(WP\|WF\)/i);
assert.match(migration, /workforce_finalize_payout_payment_response[\s\S]*?\^\(WP\|WF\)/i);
assert.match(migration, /payout_bank_reference_dropx_canonical\(item\.dropx_id_snapshot\)/i);
assert.match(migration, /create index if not exists workforce_payout_payment_items_reference_version_lookup_idx/i);
assert.match(migration, /create index if not exists helper_payout_payment_items_reference_version_lookup_idx/i);

const db = new PGlite();
await db.exec(`
  create table public.workforce(
    id uuid primary key,
    company_id uuid not null,
    dropx_id text not null
  );
  create table public.helpers(
    id uuid primary key,
    company_id uuid not null,
    dropx_id text not null
  );

  create function public.workforce_payout_bank_reference_canonical(p_value text)
  returns text language sql immutable set search_path = '' as $$
    select regexp_replace(upper(coalesce(p_value, '')), '[[:space:]]', '', 'g')
  $$;

  create table public.workforce_payout_payment_items(
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    period_start date not null,
    period_end date not null,
    payment_version integer not null,
    reference_no text not null,
    dropx_id_snapshot text not null,
    constraint workforce_payout_payment_items_reference_unique unique(company_id, reference_no),
    constraint workforce_payout_payment_items_version_unique
      unique(company_id, workforce_id, period_start, period_end, payment_version),
    constraint workforce_payout_payment_items_reference_check check (
      reference_no = public.workforce_payout_bank_reference_canonical(reference_no)
      and reference_no ~ '^WP[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$'
      and length(reference_no) <= 64
    )
  );
  create table public.helper_payout_payment_items(
    id uuid primary key,
    company_id uuid not null,
    helper_id uuid not null,
    period_start date not null,
    period_end date not null,
    payment_version integer not null,
    reference_no text not null,
    dropx_id_snapshot text not null,
    constraint helper_payout_payment_items_reference_unique unique(company_id, reference_no),
    constraint helper_payout_payment_items_version_unique
      unique(company_id, helper_id, period_start, period_end, payment_version),
    constraint helper_payout_payment_items_reference_check check (
      reference_no = public.workforce_payout_bank_reference_canonical(reference_no)
      and reference_no ~ '^HP[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$'
      and length(reference_no) <= 64
    )
  );

  create function public.workforce_payout_payment_reference(
    p_dropx_id text, p_period_start date, p_version integer
  ) returns text language plpgsql immutable set search_path = '' as $$
  declare
    v_normalized_id text := regexp_replace(upper(btrim(coalesce(p_dropx_id, ''))), '[^A-Z0-9]', '', 'g');
  begin
    return 'WP' || v_normalized_id || to_char(p_period_start, 'MMYYYY') || 'V' || p_version::text;
  end $$;

  create function public.helper_payout_payment_reference(
    p_helper_id uuid, p_dropx_id text, p_period_start date, p_version integer
  ) returns text language plpgsql immutable set search_path = '' as $$
  declare
    v_dropx text := regexp_replace(upper(btrim(coalesce(p_dropx_id, ''))), '[^A-Z0-9]', '', 'g');
    v_helper_key text := replace(coalesce(p_helper_id::text, ''), '-', '');
  begin
    return 'HP' || v_dropx || upper(v_helper_key) || to_char(p_period_start, 'MMYYYY') || 'V' || p_version::text;
  end $$;

  create function public.workforce_finalize_payout_payment_response(
    p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
    p_file_sha256 text, p_file_name text, p_rows jsonb
  ) returns jsonb language plpgsql security definer set search_path = '' as $$
  declare
    v_reference text := public.workforce_payout_bank_reference_canonical(p_rows -> 0 ->> 'reference_no');
  begin
    if length(v_reference) > 64
      or v_reference !~ '^WP[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$'
    then
      return jsonb_build_object('valid', false, 'reference_no', v_reference);
    end if;
    return jsonb_build_object('valid', true, 'reference_no', v_reference);
  end $$;

  create function public.workforce_create_payout_payment_row_batch(
    p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
    p_request_fingerprint text, p_bank_id uuid, p_period_start date,
    p_period_end date, p_value_date date, p_rows jsonb
  ) returns text language plpgsql security definer set search_path = '' as $$
  declare
    v_workforce_id uuid := (p_rows -> 0 ->> 'workforce_id')::uuid;
    v_worker public.workforce%rowtype;
    v_version integer;
  begin
    select worker.* into v_worker from public.workforce worker
    where worker.company_id = p_company_id and worker.id = v_workforce_id;
    select coalesce(max(item.payment_version), 0) + 1
    into v_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;
    return public.workforce_payout_payment_reference(v_worker.dropx_id, p_period_start, v_version);
  end $$;

  create function public.workforce_create_payout_payment_batch(
    p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
    p_request_fingerprint text, p_bank_id uuid, p_period_start date,
    p_period_end date, p_value_date date, p_workforce_ids uuid[]
  ) returns text language plpgsql security definer set search_path = '' as $$
  declare
    v_workforce_id uuid := p_workforce_ids[1];
    v_worker public.workforce%rowtype;
    v_next_version integer;
  begin
    select worker.* into v_worker from public.workforce worker
    where worker.company_id = p_company_id and worker.id = v_workforce_id;
    select coalesce(max(item.payment_version), 0)
    into v_next_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;
    return public.workforce_payout_payment_reference(v_worker.dropx_id, p_period_start, v_next_version + 1);
  end $$;

  create function public.helper_create_payout_payment_row_batch(
    p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
    p_request_fingerprint text, p_bank_id uuid, p_period_start date,
    p_period_end date, p_value_date date, p_rows jsonb
  ) returns text language plpgsql security definer set search_path = '' as $$
  declare
    v_candidate record;
    v_helper public.helpers%rowtype;
    v_version integer;
  begin
    select (p_rows -> 0 ->> 'workforce_id')::uuid workforce_id into v_candidate;
    select helper.* into v_helper from public.helpers helper
    where helper.company_id = p_company_id and helper.id = v_candidate.workforce_id;
    select coalesce(max(item.payment_version), 0) + 1 into v_version
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id and item.helper_id = v_candidate.workforce_id
      and item.period_start = p_period_start and item.period_end = p_period_end;
    return public.helper_payout_payment_reference(
      v_candidate.workforce_id, v_helper.dropx_id, p_period_start, v_version
    );
  end $$;
`);

await db.exec(executableMigration);

const patchedDefinitionSnapshot = async () => db.query(`
  select
    pg_get_functiondef(
      'public.workforce_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)'::regprocedure
    ) workforce_finalizer,
    pg_get_functiondef(
      'public.workforce_create_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date,jsonb)'::regprocedure
    ) workforce_row_creator,
    pg_get_functiondef(
      'public.workforce_create_payout_payment_batch(uuid,uuid,uuid,text,uuid,date,date,date,uuid[])'::regprocedure
    ) workforce_profile_creator,
    pg_get_functiondef(
      'public.helper_create_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date,jsonb)'::regprocedure
    ) helper_row_creator,
    pg_get_constraintdef(oid) workforce_reference_constraint
  from pg_constraint
  where conname = 'workforce_payout_payment_items_reference_check'
`);
const afterFirstMigration = await patchedDefinitionSnapshot();
await db.exec(executableMigration);
const afterSecondMigration = await patchedDefinitionSnapshot();
assert.deepEqual(
  afterSecondMigration.rows,
  afterFirstMigration.rows,
  "running the migration twice must preserve every patched function and constraint"
);

const lookupIndexes = await db.query(`
  select indexname, indexdef
  from pg_indexes
  where schemaname = 'public'
    and indexname in (
      'workforce_payout_payment_items_reference_version_lookup_idx',
      'helper_payout_payment_items_reference_version_lookup_idx'
    )
  order by indexname
`);
assert.equal(lookupIndexes.rows.length, 2, "both normalized-reference lookup indexes must exist");
for (const index of lookupIndexes.rows) {
  assert.match(index.indexdef, /payout_bank_reference_dropx_canonical\(dropx_id_snapshot\)/i);
  assert.match(index.indexdef, /company_id/i);
  assert.match(index.indexdef, /period_start/i);
  assert.match(index.indexdef, /period_end/i);
  assert.match(index.indexdef, /payment_version desc/i);
}

const generated = await db.query(`
  select
    public.helper_payout_payment_reference(
      '10000000-0000-4000-8000-000000000001', 'D0826', '2026-09-01', 1
    ) helper_reference,
    public.workforce_payout_payment_reference('D222', '2026-09-01', 1) workforce_reference
`);
assert.deepEqual(generated.rows[0], {
  helper_reference: "HPD0826092026V1",
  workforce_reference: "WFD222092026V1"
});

const company = "10000000-0000-4000-8000-000000000010";
const workerOne = "10000000-0000-4000-8000-000000000011";
const workerTwo = "10000000-0000-4000-8000-000000000012";
const helperOne = "10000000-0000-4000-8000-000000000013";
const helperTwo = "10000000-0000-4000-8000-000000000014";
await db.exec(`
  insert into public.workforce(id,company_id,dropx_id) values
    ('${workerOne}','${company}','D-222'),('${workerTwo}','${company}','D222');
  insert into public.helpers(id,company_id,dropx_id) values
    ('${helperOne}','${company}','H-100'),('${helperTwo}','${company}','H100');
  insert into public.workforce_payout_payment_items(
    id,company_id,workforce_id,period_start,period_end,payment_version,
    reference_no,dropx_id_snapshot
  ) values (
    '10000000-0000-4000-8000-000000000021','${company}','${workerOne}','2026-09-01','2026-09-30',1,
    'WPD222092026V1','D-222'
  );
  insert into public.helper_payout_payment_items(
    id,company_id,helper_id,period_start,period_end,payment_version,
    reference_no,dropx_id_snapshot
  ) values (
    '10000000-0000-4000-8000-000000000022','${company}','${helperOne}','2026-09-01','2026-09-30',1,
    'HPH100100000000000040008000000000000013092026V1','H-100'
  );
`);

const collisionSafe = await db.query(`
  select
    public.workforce_create_payout_payment_row_batch(
      $1::uuid,null,null,null,null,'2026-09-01','2026-09-30','2026-09-15',
      jsonb_build_array(jsonb_build_object('workforce_id',$2::uuid))
    ) workforce_row_reference,
    public.workforce_create_payout_payment_batch(
      $1::uuid,null,null,null,null,'2026-09-01','2026-09-30','2026-09-15',array[$2::uuid]::uuid[]
    ) workforce_legacy_reference,
    public.helper_create_payout_payment_row_batch(
      $1::uuid,null,null,null,null,'2026-09-01','2026-09-30','2026-09-15',
      jsonb_build_array(jsonb_build_object('workforce_id',$3::uuid))
    ) helper_reference
`, [company, workerTwo, helperTwo]);
assert.deepEqual(collisionSafe.rows[0], {
  workforce_row_reference: "WFD222092026V2",
  workforce_legacy_reference: "WFD222092026V2",
  helper_reference: "HPH100092026V2"
});

await db.query(`
  insert into public.workforce_payout_payment_items(
    id,company_id,workforce_id,period_start,period_end,payment_version,
    reference_no,dropx_id_snapshot
  ) values (
    '10000000-0000-4000-8000-000000000023',$1,$2,'2026-09-01','2026-09-30',2,
    'WFD222092026V2','D222'
  )
`, [company, workerTwo]);

await assert.rejects(
  db.query(`
    insert into public.workforce_payout_payment_items(
      id,company_id,workforce_id,period_start,period_end,payment_version,
      reference_no,dropx_id_snapshot
    ) values (
      '10000000-0000-4000-8000-000000000024',$1,$2,'2026-09-01','2026-09-30',3,
      'XXD222092026V3','D222'
    )
  `, [company, workerTwo]),
  /workforce_payout_payment_items_reference_check/i
);

for (const referenceNo of ["WPD222092026V1", "WFD222092026V2"]) {
  const finalized = await db.query(`
    select public.workforce_finalize_payout_payment_response(
      $1::uuid,null,null,null,null,jsonb_build_array(jsonb_build_object('reference_no',$2::text))
    ) result
  `, [company, referenceNo]);
  assert.equal(finalized.rows[0]?.result?.valid, true, `${referenceNo} must remain finalizable`);
}

const helperDefinition = await db.query(`
  select pg_get_functiondef(
    'public.helper_payout_payment_reference(uuid,text,date,integer)'::regprocedure
  ) definition
`);
assert.doesNotMatch(String(helperDefinition.rows[0]?.definition ?? ""), /helper_key/i);

console.log("short payout bank reference verification passed");
