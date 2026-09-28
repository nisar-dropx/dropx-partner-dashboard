import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const company = "00000000-0000-0000-0000-000000000001";
const worker = "00000000-0000-0000-0000-000000000002";
const secondWorker = "00000000-0000-0000-0000-000000000003";
const allocation = "00000000-0000-0000-0000-000000000004";
const method = "00000000-0000-0000-0000-000000000005";
const run = "00000000-0000-0000-0000-000000000006";
const adjustment = "00000000-0000-0000-0000-000000000007";
const legacyFinalizedRun = "00000000-0000-0000-0000-000000000008";
const lateAllocation = "00000000-0000-0000-0000-000000000009";
const legacyMutableRun = "00000000-0000-0000-0000-00000000000a";

await db.exec(`
  create role anon;
  create role authenticated;
  create table workforce (
    id uuid not null,
    company_id uuid not null,
    primary key (id),
    unique (company_id, id)
  );
  create table workforce_payroll_runs (
    id uuid primary key,
    company_id uuid not null,
    status text not null,
    period_start date not null,
    period_end date not null,
    calculated_at timestamptz
  );
  create table workforce_payroll_items (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    payroll_run_id uuid not null,
    workforce_id uuid not null,
    status text not null
  );
  create table workforce_payment_allocations (
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid,
    station_code_snapshot text,
    designation_id uuid,
    designation_code_snapshot text,
    designation_name_snapshot text,
    payment_method_id uuid not null,
    payment_values jsonb not null,
    payment_components jsonb not null,
    effective_from date not null,
    effective_to date,
    status text not null,
    change_reason text,
    created_by uuid,
    updated_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table workforce_adjustments (
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    external_reference text,
    status text not null,
    payroll_run_id uuid,
    effective_date date not null
  );
  insert into workforce (id, company_id)
  values
    ('${worker}', '${company}'),
    ('${secondWorker}', '${company}');
  insert into workforce_payment_allocations (
    id, company_id, workforce_id, payment_method_id, payment_values,
    payment_components, effective_from, status, created_at, updated_at
  ) values (
    '${allocation}', '${company}', '${worker}', '${method}', '{"BASE":1000}',
    '[{"component_code":"BASE","component_type":"amount","pay_schedule":"per_month"}]',
    '2026-08-01', 'active', '1999-01-01T00:00:00Z', '1999-01-01T00:00:00Z'
  );
  insert into workforce_payroll_runs
    (id, company_id, status, period_start, period_end, calculated_at)
  values
    ('${run}', '${company}', 'draft', '2026-09-01', '2026-09-30', null),
    ('${legacyFinalizedRun}', '${company}', 'approved', '2025-09-01', '2025-09-30', '2025-10-01T00:00:00Z'),
    ('${legacyMutableRun}', '${company}', 'review', '2025-10-01', '2025-10-31', '2025-11-01T00:00:00Z');
  insert into workforce_payroll_items
    (company_id, payroll_run_id, workforce_id, status)
  values
    ('${company}', '${run}', '${worker}', 'ready');

  -- Reproduce the function signature installed by
  -- 20260923143000_adhoc_da_payment_tracking.sql. Migration 120000 replaces it
  -- with the direct-allocation-aware superset under test.
  create function workforce_adhoc_payroll_gate()
  returns trigger
  language plpgsql
  as $$
  begin
    if new.status in ('review', 'approved', 'paid') and new.status <> old.status then
      perform 1
      from workforce w
      join workforce_payroll_items i
        on i.workforce_id = w.id
       and i.company_id = w.company_id
      where i.payroll_run_id = new.id
        and i.status <> 'excluded'
      order by w.id
      for update of w;
      if exists (
        select 1
        from workforce_adjustments a
        join workforce_payroll_items i
          on i.workforce_id = a.workforce_id
         and i.company_id = a.company_id
        where i.payroll_run_id = new.id
          and i.status <> 'excluded'
          and a.external_reference like 'OPS-ADHOC-DA:%'
          and a.status = 'approved'
          and a.payroll_run_id is null
          and a.effective_date between new.period_start and new.period_end
      ) then
        raise exception 'A paid Adhoc DA deduction is missing from this payroll. Return to draft and recalculate before confirmation';
      end if;
    end if;
    return new;
  end;
  $$;
  create trigger workforce_adhoc_payroll_gate
  before update of status on workforce_payroll_runs
  for each row execute function workforce_adhoc_payroll_gate();
`);

await db.exec(readFileSync(
  new URL("../supabase/migrations/20260928120000_workforce_payment_allocation_finalized_guard.sql", import.meta.url),
  "utf8"
));

const companyLockDefinition = await db.query(`
  select pg_get_functiondef(
    'public.lock_workforce_payment_allocation_company(uuid)'::regprocedure
  ) as definition
`);
assert.match(
  companyLockDefinition.rows[0].definition,
  /pg_advisory_xact_lock\s*\(hashtextextended\s*\(\s*'workforce-payment-allocation-company:'\s*\|\|\s*p_company_id::text/i,
  "allocation writes and payroll confirmation must share one transaction-scoped company lock key"
);

const guardDefinition = await db.query(`
  select pg_get_functiondef(
    'public.guard_finalized_workforce_payment_allocation()'::regprocedure
  ) as definition
`);
assert.match(
  guardDefinition.rows[0].definition,
  /from public\.workforce workforce[\s\S]*for update/i,
  "allocation DML must lock the canonical workforce row used by payroll confirmation"
);
assert.match(
  guardDefinition.rows[0].definition,
  /order by workforce\.company_id, workforce\.id[\s\S]*for update/i,
  "cross-worker allocation edits must acquire workforce locks deterministically"
);
assert.match(
  guardDefinition.rows[0].definition,
  /lock_workforce_payment_allocation_company[\s\S]*new\.updated_at := clock_timestamp\(\)/i,
  "every allocation write must record wall-clock time after acquiring the company mutex"
);
assert.match(
  guardDefinition.rows[0].definition,
  /if tg_op = 'DELETE'[\s\S]*cannot be deleted/i,
  "allocation history deletes must be rejected unconditionally"
);

const snapshotHashDefinition = await db.query(`
  select pg_get_functiondef(
    'public.workforce_payment_allocation_snapshot_hash(uuid,date,date)'::regprocedure
  ) as definition
`);
for (const materialField of [
  "allocation.id",
  "allocation.effective_from",
  "allocation.effective_to",
  "allocation.status",
  "allocation.payment_values",
  "allocation.payment_components",
  "allocation.updated_at"
]) {
  assert.ok(
    snapshotHashDefinition.rows[0].definition.includes(materialField),
    `material allocation digest must include ${materialField}`
  );
}
assert.match(
  snapshotHashDefinition.rows[0].definition,
  /daterange\(p_period_start, p_period_end, '\[\]'(?:::text)?\)/i,
  "material allocation digest must be scoped to the payroll period"
);

const captureDefinition = await db.query(`
  select pg_get_functiondef(
    'public.capture_workforce_direct_allocation_snapshot()'::regprocedure
  ) as definition
`);
assert.match(
  captureDefinition.rows[0].definition,
  /order by workforce\.id[\s\S]*for update[\s\S]*lock_workforce_payment_allocation_company\(new\.company_id\)[\s\S]*lock table public\.workforce_payment_allocations in share mode[\s\S]*workforce_payment_allocation_snapshot_hash/i,
  "calculation snapshot capture must use the same stable lock order as confirmation"
);

const confirmationGateDefinition = await db.query(`
  select pg_get_functiondef(
    'public.workforce_adhoc_payroll_gate()'::regprocedure
  ) as definition
`);
assert.match(
  confirmationGateDefinition.rows[0].definition,
  /where workforce\.company_id = new\.company_id[\s\S]*order by workforce\.id[\s\S]*for update/i,
  "payroll confirmation must lock every company workforce row deterministically"
);
assert.match(
  confirmationGateDefinition.rows[0].definition,
  /lock_workforce_payment_allocation_company\(new\.company_id\)[\s\S]*lock table public\.workforce_payment_allocations in share mode/i,
  "payroll confirmation must acquire the shared company mutex before its allocation-table SHARE lock"
);
assert.match(
  confirmationGateDefinition.rows[0].definition,
  /new\.direct_allocation_snapshot_hash is null[\s\S]*v_direct_allocation_snapshot_hash := public\.workforce_payment_allocation_snapshot_hash[\s\S]*is distinct from new\.direct_allocation_snapshot_hash/i,
  "payroll confirmation must recompute and compare the period's material allocation digest"
);
assert.match(
  confirmationGateDefinition.rows[0].definition,
  /OPS-ADHOC-DA:%/i,
  "the existing Adhoc DA completeness check must remain in the confirmation gate"
);

// PGlite is deliberately single-connection, so it cannot run a second session
// that demonstrates lock waiting. Verify that the shared helper holds a granted
// transaction-level advisory lock; the function-definition assertions above
// prove both competing paths call this exact helper before their table access.
await db.transaction(async (tx) => {
  await tx.query(
    "select public.lock_workforce_payment_allocation_company($1)",
    [company]
  );
  const advisoryLocks = await tx.query(`
    select count(*)::int as count
    from pg_locks
    where locktype = 'advisory'
      and granted = true
  `);
  assert.ok(advisoryLocks.rows[0].count >= 1);
});

const legacyBackfill = await db.query(
  "select direct_allocation_snapshot_hash from workforce_payroll_runs where id = $1",
  [legacyFinalizedRun]
);
assert.match(legacyBackfill.rows[0].direct_allocation_snapshot_hash, /^[a-f0-9]{32}$/);
const mutableBackfill = await db.query(
  "select direct_allocation_snapshot_hash from workforce_payroll_runs where id = $1",
  [legacyMutableRun]
);
assert.equal(mutableBackfill.rows[0].direct_allocation_snapshot_hash, null);
await assert.rejects(
  () => db.query(
    "update workforce_payroll_runs set status = 'approved' where id = $1",
    [legacyMutableRun]
  ),
  /were not captured/
);

// PGlite exposes one database session, so it cannot overlap two transactions.
// Exercise each side of the shared row-lock protocol in serial order and assert
// the allocation guard definition above contains the matching FOR UPDATE lock.
await assert.rejects(
  () => db.query(
    "update workforce_payroll_runs set status = 'review' where id = $1",
    [run]
  ),
  /must be calculated/
);

await db.query(
  "update workforce_payroll_runs set calculated_at = clock_timestamp() where id = $1",
  [run]
);
const capturedBeforeEdit = await db.query(
  "select direct_allocation_snapshot_hash from workforce_payroll_runs where id = $1",
  [run]
);
assert.match(capturedBeforeEdit.rows[0].direct_allocation_snapshot_hash, /^[a-f0-9]{32}$/);
// This row was absent from the material calculation snapshot, matching the
// observable result of an allocation transaction that commits afterward.
await db.query(`
  insert into workforce_payment_allocations (
    id, company_id, workforce_id, payment_method_id, payment_values,
    payment_components, effective_from, effective_to, status
  ) values (
    $1, $2, $3, $4, '{"BASE":700}', '[]',
    '2026-09-10', '2026-09-20', 'closed'
  )
`, [lateAllocation, company, secondWorker, method]);
await db.query(
  "update workforce_payment_allocations set payment_values = '{\"BASE\":1100}' where id = $1",
  [allocation]
);
const timestampedAllocation = await db.query(
  "select updated_at > '1999-01-01T00:00:00Z'::timestamptz as advanced from workforce_payment_allocations where id = $1",
  [allocation]
);
assert.equal(timestampedAllocation.rows[0].advanced, true);
const digestMismatch = await db.query(`
  select
    payroll_run.direct_allocation_snapshot_hash as captured,
    public.workforce_payment_allocation_snapshot_hash(
      payroll_run.company_id,
      payroll_run.period_start,
      payroll_run.period_end
    ) as current
  from workforce_payroll_runs payroll_run
  where payroll_run.id = $1
`, [run]);
assert.notEqual(digestMismatch.rows[0].captured, digestMismatch.rows[0].current);
await assert.rejects(
  () => db.query(
    "update workforce_payroll_runs set status = 'review' where id = $1",
    [run]
  ),
  /allocations changed after this payroll was calculated/
);

await db.query(
  "update workforce_payroll_runs set calculated_at = clock_timestamp() where id = $1",
  [run]
);
await db.query(`
  insert into workforce_adjustments (
    id, company_id, workforce_id, external_reference, status, payroll_run_id, effective_date
  ) values (
    $1, $2, $3, 'OPS-ADHOC-DA:test', 'approved', null, '2026-09-15'
  )
`, [adjustment, company, worker]);
await assert.rejects(
  () => db.query(
    "update workforce_payroll_runs set status = 'review' where id = $1",
    [run]
  ),
  /paid Adhoc DA deduction is missing/
);
await db.query(
  "update workforce_adjustments set payroll_run_id = $1 where id = $2",
  [run, adjustment]
);
await db.query(
  "update workforce_payroll_runs set status = 'review' where id = $1",
  [run]
);

// Regression for the transaction-start race: capture the material digest and
// then change an allocation later in the same transaction. The mismatch is
// independent of transaction-start or wall-clock timestamp ordering.
await db.transaction(async (tx) => {
  await tx.query(
    "update workforce_payroll_runs set calculated_at = clock_timestamp() where id = $1",
    [run]
  );
  await tx.query("select pg_sleep(0.01)");
  await tx.query(
    "update workforce_payment_allocations set payment_values = '{\"BASE\":1150}' where id = $1",
    [allocation]
  );
});
await assert.rejects(
  () => db.query(
    "update workforce_payroll_runs set status = 'approved' where id = $1",
    [run]
  ),
  /allocations changed after this payroll was calculated/
);
await db.query(
  "update workforce_payroll_runs set calculated_at = clock_timestamp() where id = $1",
  [run]
);
await db.query(
  "update workforce_payroll_runs set status = 'approved' where id = $1",
  [run]
);

const future = await db.query(`
  insert into workforce_payment_allocations (
    id, company_id, workforce_id, payment_method_id, payment_values,
    payment_components, effective_from, status
  ) values (
    gen_random_uuid(), $1, $2, $3, '{"BASE":1000}', '[]', '2026-10-01', 'active'
  ) returning id
`, [company, secondWorker, method]);
await db.query(
  "update workforce_payment_allocations set payment_values = '{\"BASE\":1500}' where id = $1",
  [future.rows[0].id]
);
// A post-calculation October allocation must not block paying the September run.
await db.query(
  "update workforce_payroll_runs set status = 'paid' where id = $1",
  [run]
);

await assert.rejects(
  () => db.query(
    "update workforce_payment_allocations set payment_values = '{\"BASE\":1500}' where id = $1",
    [allocation]
  ),
  /Create a later effective-dated version/
);
await assert.rejects(
  () => db.query(
    "update workforce_payment_allocations set effective_to = '2026-09-15', status = 'closed' where id = $1",
    [allocation]
  ),
  /End or cancel it only after/
);
await assert.rejects(
  () => db.query(
    "update workforce_payment_allocations set status = 'cancelled' where id = $1",
    [allocation]
  ),
  /End or cancel it only after/
);
await assert.rejects(
  () => db.query("delete from workforce_payment_allocations where id = $1", [allocation]),
  /history cannot be deleted/
);
await assert.rejects(
  () => db.query(`
    insert into workforce_payment_allocations (
      id, company_id, workforce_id, payment_method_id, payment_values,
      payment_components, effective_from, effective_to, status
    ) values (
      gen_random_uuid(), $1, $2, $3, '{"BASE":1000}', '[]',
      '2026-09-01', '2026-09-30', 'closed'
    )
  `, [company, secondWorker, method]),
  /Start the direct payment allocation after/
);

await db.query(
  "update workforce_payment_allocations set effective_to = '2026-10-31', status = 'closed' where id = $1",
  [allocation]
);
await db.query(
  "update workforce_payment_allocations set change_reason = 'Documented after review' where id = $1",
  [allocation]
);
await db.close();
console.log("PASS direct allocation payroll guard: shared locking, material snapshot integrity, period scoping and finalized history checks hold.");
