import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../supabase/migrations/20261017183000_workforce_payout_publication_self_heal.sql", import.meta.url),
  "utf8"
);

assert.match(migration, /^begin;/i);
assert.match(migration, /commit;\s*$/i);
assert.match(migration, /security definer\s+set search_path = ''/i);
assert.match(migration, /publication\.workforce_id = v_workforce_id[\s\S]*publication\.station_id = v_station_id/i);
assert.match(migration, /job\.status in \('pending', 'processing'\)/i);
assert.match(migration, /job\.status = 'failed'/i);
assert.match(migration, /v_latest\.id::text[\s\S]*p_dependency_hash[\s\S]*v_target_cents::text/i);
assert.match(migration, /from public, anon, authenticated, service_role[\s\S]*to service_role/i);
assert.doesNotMatch(migration, /DF\d+|GDRD\d+|DH\d+/i);

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;

  create table public.workforce_payout_publications (
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid not null,
    period_start date not null,
    period_end date not null,
    revision integer not null,
    publication_kind text not null,
    snapshot jsonb not null,
    published_by uuid not null,
    published_at timestamptz not null default clock_timestamp()
  );

  create table public.workforce_payout_publication_refresh_jobs (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    input_batch_id uuid,
    refresh_source text not null,
    refresh_request_id uuid not null,
    workforce_id uuid not null,
    station_id uuid not null,
    period_start date not null,
    period_end date not null,
    base_publication_id uuid not null,
    base_revision integer not null,
    requested_by uuid,
    status text not null default 'pending',
    next_attempt_at timestamptz,
    created_at timestamptz not null default clock_timestamp(),
    unique (
      company_id, refresh_request_id, workforce_id, station_id,
      period_start, period_end
    )
  );

  create table public.verifier_mapping_revision_state (
    company_id uuid not null,
    workforce_id uuid not null,
    period_start date not null,
    period_end date not null,
    revision_pending boolean not null
  );

  create function public.workforce_payout_mapping_revision_state(
    p_company_id uuid,
    p_workforce_id uuid
  )
  returns table (
    period_start date,
    period_end date,
    revision_pending boolean,
    mapping_relock_id uuid,
    active_station_ids uuid[]
  )
  language sql
  stable
  as $$
    select state.period_start, state.period_end, state.revision_pending,
      null::uuid, null::uuid[]
    from public.verifier_mapping_revision_state state
    where state.company_id = p_company_id
      and state.workforce_id = p_workforce_id
  $$;
`);

// The migration is deliberately safe for the repository's one-file, twice-run
// deployment check.
await db.exec(migration);
await db.exec(migration);

const companyId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const workforceId = "00000000-0000-4000-8000-000000000003";
const stationA = "00000000-0000-4000-8000-00000000000a";
const stationB = "00000000-0000-4000-8000-00000000000b";
const stationMissing = "00000000-0000-4000-8000-00000000000c";
const stationUnlocked = "00000000-0000-4000-8000-00000000000d";
const stationFailed = "00000000-0000-4000-8000-00000000000e";
const periodStart = "2026-10-01";
const periodEnd = "2026-10-31";
const dependencyHash = "0123456789abcdef0123456789abcdef";

async function insertPublication({ id, stationId, revision, amount }) {
  await db.query(`
    insert into public.workforce_payout_publications (
      id, company_id, workforce_id, station_id, period_start, period_end,
      revision, publication_kind, snapshot, published_by, published_at
    ) values ($1, $2, $3, $4, $5, $6, $7::integer, 'worksheet', $8::jsonb, $9,
      clock_timestamp() + make_interval(secs => $7::integer))
  `, [
    id, companyId, workforceId, stationId, periodStart, periodEnd, revision,
    JSON.stringify({ item: { net_amount: String(amount) } }), actorId
  ]);
}

await insertPublication({
  id: "10000000-0000-4000-8000-00000000000a",
  stationId: stationA,
  revision: 1,
  amount: 100
});
await insertPublication({
  id: "10000000-0000-4000-8000-00000000000b",
  stationId: stationB,
  revision: 1,
  amount: 25
});
await insertPublication({
  id: "10000000-0000-4000-8000-00000000000d",
  stationId: stationUnlocked,
  revision: 1,
  amount: 10
});
await insertPublication({
  id: "10000000-0000-4000-8000-00000000000e",
  stationId: stationFailed,
  revision: 1,
  amount: 10
});

await db.query(`
  insert into public.verifier_mapping_revision_state values
    ($1, $2, $3, $4, true)
`, [companyId, workforceId, periodStart, periodEnd]);

// Keep the mapping flag limited to the unlocked test row by returning it only
// while a verifier session setting names that location.
await db.exec(`
  create or replace function public.workforce_payout_mapping_revision_state(
    p_company_id uuid,
    p_workforce_id uuid
  )
  returns table (
    period_start date,
    period_end date,
    revision_pending boolean,
    mapping_relock_id uuid,
    active_station_ids uuid[]
  )
  language sql
  stable
  as $$
    select state.period_start, state.period_end,
      state.revision_pending and current_setting('verifier.mapping_unlocked', true) = 'on',
      null::uuid, null::uuid[]
    from public.verifier_mapping_revision_state state
    where state.company_id = p_company_id
      and state.workforce_id = p_workforce_id
  $$;
`);

async function ensure(rows, hash = dependencyHash, start = periodStart, end = periodEnd) {
  const result = await db.query(`
    select public.workforce_ensure_payout_publication_refresh_jobs(
      $1, $2, $3, $4, $5, $6::jsonb
    ) as result
  `, [companyId, actorId, start, end, hash, JSON.stringify(rows)]);
  return result.rows[0].result;
}

const row = (stationId, amount) => ({
  workforce_id: workforceId,
  station_id: stationId,
  current_target_amount: amount
});

const first = await ensure([row(stationA, 125)]);
assert.deepEqual(first, {
  requested: 1,
  enqueued: 1,
  already_queued: 0,
  failed: 0,
  current: 0,
  missing_publication: 0,
  mapping_unlocked: 0
});

const queued = await ensure([row(stationA, 125)]);
assert.equal(queued.already_queued, 1);
assert.equal(queued.enqueued, 0);
assert.equal((await db.query(`select count(*)::integer as count from public.workforce_payout_publication_refresh_jobs`)).rows[0].count, 1);

await db.query(`
  insert into public.workforce_payout_publication_refresh_jobs (
    company_id, input_batch_id, refresh_source, refresh_request_id,
    workforce_id, station_id, period_start, period_end,
    base_publication_id, base_revision, requested_by, status
  ) values ($1, null, 'payout_dependency', $2, $3, $4, $5, $6, $7, 1, $8, 'failed')
`, [
  companyId, "20000000-0000-4000-8000-00000000000e", workforceId,
  stationFailed, periodStart, periodEnd,
  "10000000-0000-4000-8000-00000000000e", actorId
]);

const mixed = await ensure([
  row(stationA, 125),
  row(stationB, 25),
  row(stationMissing, 50),
  row(stationFailed, 50)
]);
assert.equal(mixed.requested, 4);
assert.equal(mixed.already_queued, 1);
assert.equal(mixed.current, 1);
assert.equal(mixed.missing_publication, 1);
assert.equal(mixed.failed, 1);

await db.exec(`select set_config('verifier.mapping_unlocked', 'on', false)`);
const unlocked = await ensure([row(stationUnlocked, 20)]);
assert.equal(unlocked.mapping_unlocked, 1);
assert.equal(unlocked.enqueued, 0);
await db.exec(`select set_config('verifier.mapping_unlocked', 'off', false)`);

// A completed repair plus its new immutable revision is recognized as current,
// and the sibling location remains independently current throughout.
await db.query(`update public.workforce_payout_publication_refresh_jobs set status='completed' where station_id=$1`, [stationA]);
await insertPublication({
  id: "30000000-0000-4000-8000-00000000000a",
  stationId: stationA,
  revision: 2,
  amount: 125
});
const repaired = await ensure([row(stationA, 125), row(stationB, 25)]);
assert.equal(repaired.current, 2);
assert.equal(repaired.enqueued, 0);

await assert.rejects(
  ensure([row(stationA, 125)], "not-a-dependency-hash"),
  /valid payout dependency hash/i
);
await assert.rejects(
  ensure([row(stationA, 125)], dependencyHash, "2026-10-02", periodEnd),
  /complete calendar month/i
);
await assert.rejects(
  ensure([row(stationA, 125), row(stationA, 125)]),
  /must be unique/i
);
await assert.rejects(
  ensure([{ ...row(stationA, 125), publication_id: "40000000-0000-4000-8000-000000000001" }]),
  /must contain only/i
);
await assert.rejects(
  ensure([row(stationA, 125.001)]),
  /paise-exact/i
);
await assert.rejects(
  ensure(["not-an-object"]),
  /must be a JSON object/i
);

const privileges = await db.query(`
  select
    has_function_privilege(
      'service_role',
      'public.workforce_ensure_payout_publication_refresh_jobs(uuid,uuid,date,date,text,jsonb)',
      'execute'
    ) as service_can_execute,
    has_function_privilege(
      'authenticated',
      'public.workforce_ensure_payout_publication_refresh_jobs(uuid,uuid,date,date,text,jsonb)',
      'execute'
    ) as authenticated_can_execute,
    has_function_privilege(
      'anon',
      'public.workforce_ensure_payout_publication_refresh_jobs(uuid,uuid,date,date,text,jsonb)',
      'execute'
    ) as anon_can_execute
`);
assert.equal(privileges.rows[0].service_can_execute, true);
assert.equal(privileges.rows[0].authenticated_can_execute, false);
assert.equal(privileges.rows[0].anon_can_execute, false);

console.log("Workforce payout publication self-heal migration verification passed.");
