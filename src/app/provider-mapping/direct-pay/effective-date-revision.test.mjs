import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../../../../supabase/migrations/20261016090000_workforce_payment_allocation_effective_date_revision.sql",
  import.meta.url
);
const deployUrl = new URL(
  "../../../../scripts/workforce_payment_allocation_effective_date_revision_v1.sql",
  import.meta.url
);
const actionsUrl = new URL("./actions.ts", import.meta.url);
const worksheetUrl = new URL("../../../components/direct-payment-allocation-worksheet.tsx", import.meta.url);

const [migration, deployScript, actions, worksheet] = await Promise.all([
  readFile(migrationUrl, "utf8"),
  readFile(deployUrl, "utf8"),
  readFile(actionsUrl, "utf8"),
  readFile(worksheetUrl, "utf8")
]);

const id = (value) => `41000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const company = id(1);
const method = id(2);
const actor = id(3);

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;

    create table public.workforce (
      id uuid primary key,
      company_id uuid not null
    );

    create table public.workforce_payment_allocations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      workforce_id uuid not null,
      payment_method_id uuid not null,
      payment_values jsonb not null default '{}'::jsonb,
      effective_from date not null,
      effective_to date,
      status text not null default 'active',
      change_reason text,
      transition_restore_state jsonb,
      updated_by uuid,
      updated_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    );

    create unique index workforce_payment_allocations_one_current_idx
      on public.workforce_payment_allocations(company_id, workforce_id)
      where status = 'active' and effective_to is null;

    -- Production has BEFORE UPDATE payout-lock guards with a much larger
    -- dependency graph. This small trigger reproduces their transactional
    -- contract: either the target boundary change or the predecessor-period
    -- shortening can be rejected before the row is written.
    create table public.test_allocation_update_locks (
      allocation_id uuid primary key,
      blocked_change text not null check (blocked_change in ('effective_from', 'period_end'))
    );

    create function public.test_allocation_before_update_guard()
    returns trigger language plpgsql as $$
    declare
      v_blocked_change text;
    begin
      select blocked_change into v_blocked_change
      from public.test_allocation_update_locks
      where allocation_id = old.id;

      if v_blocked_change = 'effective_from'
        and new.effective_from is distinct from old.effective_from then
        raise exception 'test guard: target effective-from is payout locked';
      end if;
      if v_blocked_change = 'period_end'
        and (
          new.effective_to is distinct from old.effective_to
          or new.status is distinct from old.status
        ) then
        raise exception 'test guard: predecessor period is payout locked';
      end if;
      return new;
    end $$;

    create trigger test_allocation_before_update_guard
      before update on public.workforce_payment_allocations
      for each row execute function public.test_allocation_before_update_guard();

    -- Minimal copy of the legacy date-based behavior. If a submitted date is
    -- earlier than the current row, this cannot find that row and its INSERT
    -- reproduces the production duplicate-current failure.
    create function public.save_workforce_payment_allocation_v2(
      p_company_id uuid,
      p_workforce_id uuid,
      p_payment_method_id uuid,
      p_payment_values jsonb,
      p_effective_from date,
      p_effective_to date default null,
      p_change_reason text default null,
      p_actor_user_id uuid default null
    ) returns uuid language plpgsql as $$
    declare
      v_current public.workforce_payment_allocations%rowtype;
      v_id uuid;
    begin
      select allocation.* into v_current
      from public.workforce_payment_allocations allocation
      where allocation.company_id = p_company_id
        and allocation.workforce_id = p_workforce_id
        and allocation.status <> 'cancelled'
        and allocation.effective_from <= p_effective_from
        and (allocation.effective_to is null or allocation.effective_to >= p_effective_from)
      order by allocation.effective_from desc, allocation.created_at desc
      limit 1
      for update;

      if found and p_effective_from = v_current.effective_from then
        update public.workforce_payment_allocations
        set payment_method_id = p_payment_method_id,
            payment_values = p_payment_values,
            effective_to = p_effective_to,
            status = case when p_effective_to is null then 'active' else 'closed' end,
            change_reason = p_change_reason,
            updated_by = p_actor_user_id,
            updated_at = now()
        where id = v_current.id
        returning id into v_id;
        return v_id;
      end if;

      if found then
        update public.workforce_payment_allocations
        set effective_to = p_effective_from - 1,
            status = 'closed'
        where id = v_current.id;
      end if;

      insert into public.workforce_payment_allocations(
        company_id, workforce_id, payment_method_id, payment_values,
        effective_from, effective_to, status, change_reason, updated_by
      ) values (
        p_company_id, p_workforce_id, p_payment_method_id, p_payment_values,
        p_effective_from, p_effective_to,
        case when p_effective_to is null then 'active' else 'closed' end,
        p_change_reason, p_actor_user_id
      ) returning id into v_id;
      return v_id;
    end $$;
  `);
  await db.exec(migration);
  return db;
}

async function allocationRows(db, worker) {
  return (await db.query(`
    select id::text, effective_from::text, effective_to::text, status,
      payment_values, change_reason
    from public.workforce_payment_allocations
    where company_id = $1 and workforce_id = $2
    order by effective_from, id
  `, [company, worker])).rows;
}

async function allocationUpdatedAt(db, allocation) {
  return (await db.query(
    "select updated_at::text from public.workforce_payment_allocations where id = $1",
    [allocation]
  )).rows[0].updated_at;
}

async function revise(db, worker, allocation, from, values = { MONTHLY: 9000 }, expectedUpdatedAt) {
  const version = expectedUpdatedAt ?? await allocationUpdatedAt(db, allocation);
  return db.query(`select public.save_workforce_payment_allocation_v3(
    $1, $2, $3, $4::jsonb, $5::date, null, 'Corrected actual start date', $6, $7, $8::timestamptz
  ) id`, [company, worker, method, JSON.stringify(values), from, actor, allocation, version]);
}

test("direct-pay form sends stable allocation identity to the revision RPC", () => {
  assert.equal(migration, deployScript, "the deploy SQL must exactly match the migration");
  assert.match(worksheet, /name="allocation_id"[^>]*value=\{row\.allocationId\}/);
  assert.match(worksheet, /name="allocation_updated_at"[^>]*value=\{row\.allocationUpdatedAt\}/);
  assert.match(actions, /rpc\("save_workforce_payment_allocation_v3"/);
  assert.match(actions, /p_allocation_id:\s*allocationId/);
  assert.match(actions, /p_expected_updated_at:\s*allocationUpdatedAt/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test("moving an existing current allocation earlier updates the same row without creating a second current row", async () => {
  const db = await database();
  const worker = id(10);
  const allocation = id(11);
  try {
    await db.query("insert into public.workforce values ($1,$2)", [worker, company]);
    await db.query(`insert into public.workforce_payment_allocations(
      id, company_id, workforce_id, payment_method_id, payment_values,
      effective_from, effective_to, status
    ) values ($1,$2,$3,$4,'{"MONTHLY":9000}','2026-10-19',null,'active')`,
    [allocation, company, worker, method]);

    await assert.rejects(
      db.query(`select public.save_workforce_payment_allocation_v2(
        $1,$2,$3,'{"MONTHLY":9500}','2026-09-19',null,'legacy attempt',$4
      )`, [company, worker, method, actor]),
      /workforce_payment_allocations_one_current_idx|duplicate key/i
    );

    const result = await revise(db, worker, allocation, "2026-09-19", { MONTHLY: 9500 });
    assert.equal(result.rows[0].id, allocation);
    assert.deepEqual(await allocationRows(db, worker), [{
      id: allocation,
      effective_from: "2026-09-19",
      effective_to: null,
      status: "active",
      payment_values: { MONTHLY: 9500 },
      change_reason: "Corrected actual start date"
    }]);
  } finally {
    await db.close();
  }
});

test("an earlier correction shortens only the immediately preceding period and preserves its row", async () => {
  const db = await database();
  const worker = id(20);
  const previous = id(21);
  const current = id(22);
  try {
    await db.query("insert into public.workforce values ($1,$2)", [worker, company]);
    await db.query(`insert into public.workforce_payment_allocations(
      id, company_id, workforce_id, payment_method_id, payment_values,
      effective_from, effective_to, status, change_reason
    ) values
      ($1,$3,$4,$5,'{"MONTHLY":8000}','2026-09-01','2026-10-18','closed','Original September terms'),
      ($2,$3,$4,$5,'{"MONTHLY":9000}','2026-10-19',null,'active','October terms')`,
    [previous, current, company, worker, method]);

    await revise(db, worker, current, "2026-09-19");
    assert.deepEqual(await allocationRows(db, worker), [
      {
        id: previous,
        effective_from: "2026-09-01",
        effective_to: "2026-09-18",
        status: "closed",
        payment_values: { MONTHLY: 8000 },
        change_reason: "Original September terms | Automatically shortened after correcting the following direct payment allocation start date."
      },
      {
        id: current,
        effective_from: "2026-09-19",
        effective_to: null,
        status: "active",
        payment_values: { MONTHLY: 9000 },
        change_reason: "Corrected actual start date"
      }
    ]);
  } finally {
    await db.close();
  }
});

test("a target allocation BEFORE UPDATE guard aborts the revision and rolls back predecessor shortening", async () => {
  const db = await database();
  const worker = id(50);
  const previous = id(51);
  const current = id(52);
  try {
    await db.query("insert into public.workforce values ($1,$2)", [worker, company]);
    await db.query(`insert into public.workforce_payment_allocations(
      id, company_id, workforce_id, payment_method_id, payment_values,
      effective_from, effective_to, status, change_reason
    ) values
      ($1,$3,$4,$5,'{"MONTHLY":8000}','2026-09-01','2026-10-18','closed','Original September terms'),
      ($2,$3,$4,$5,'{"MONTHLY":9000}','2026-10-19',null,'active','October terms')`,
    [previous, current, company, worker, method]);
    await db.query(
      "insert into public.test_allocation_update_locks values ($1, 'effective_from')",
      [current]
    );
    const before = await allocationRows(db, worker);

    await assert.rejects(
      revise(db, worker, current, "2026-09-19"),
      /target effective-from is payout locked/i
    );
    assert.deepEqual(
      await allocationRows(db, worker),
      before,
      "the target guard must roll back the predecessor update that ran first"
    );
  } finally {
    await db.close();
  }
});

test("a predecessor BEFORE UPDATE guard aborts period shortening before the target revision", async () => {
  const db = await database();
  const worker = id(60);
  const previous = id(61);
  const current = id(62);
  try {
    await db.query("insert into public.workforce values ($1,$2)", [worker, company]);
    await db.query(`insert into public.workforce_payment_allocations(
      id, company_id, workforce_id, payment_method_id, payment_values,
      effective_from, effective_to, status, change_reason
    ) values
      ($1,$3,$4,$5,'{"MONTHLY":8000}','2026-09-01','2026-10-18','closed','Original September terms'),
      ($2,$3,$4,$5,'{"MONTHLY":9000}','2026-10-19',null,'active','October terms')`,
    [previous, current, company, worker, method]);
    await db.query(
      "insert into public.test_allocation_update_locks values ($1, 'period_end')",
      [previous]
    );
    const before = await allocationRows(db, worker);

    await assert.rejects(
      revise(db, worker, current, "2026-09-19"),
      /predecessor period is payout locked/i
    );
    assert.deepEqual(
      await allocationRows(db, worker),
      before,
      "the predecessor guard must leave both payment periods unchanged"
    );
  } finally {
    await db.close();
  }
});

test("a correction cannot silently consume a complete earlier payment period", async () => {
  const db = await database();
  const worker = id(30);
  const previous = id(31);
  const current = id(32);
  try {
    await db.query("insert into public.workforce values ($1,$2)", [worker, company]);
    await db.query(`insert into public.workforce_payment_allocations(
      id, company_id, workforce_id, payment_method_id, payment_values,
      effective_from, effective_to, status
    ) values
      ($1,$3,$4,$5,'{"MONTHLY":8000}','2026-09-20','2026-10-18','closed'),
      ($2,$3,$4,$5,'{"MONTHLY":9000}','2026-10-19',null,'active')`,
    [previous, current, company, worker, method]);
    const before = await allocationRows(db, worker);

    await assert.rejects(
      revise(db, worker, current, "2026-09-19"),
      /crosses an earlier payment period/i
    );
    assert.deepEqual(await allocationRows(db, worker), before, "the rejected revision must roll back every row");
  } finally {
    await db.close();
  }
});

test("a stale form cannot overwrite a newer allocation revision", async () => {
  const db = await database();
  const worker = id(40);
  const allocation = id(41);
  try {
    await db.query("insert into public.workforce values ($1,$2)", [worker, company]);
    await db.query(`insert into public.workforce_payment_allocations(
      id, company_id, workforce_id, payment_method_id, payment_values,
      effective_from, effective_to, status
    ) values ($1,$2,$3,$4,'{"MONTHLY":9000}','2026-10-19',null,'active')`,
    [allocation, company, worker, method]);
    const staleVersion = await allocationUpdatedAt(db, allocation);

    await db.query(
      "update public.workforce_payment_allocations set payment_values = '{\"MONTHLY\":9100}', updated_at = updated_at + interval '1 second' where id = $1",
      [allocation]
    );
    const before = await allocationRows(db, worker);

    await assert.rejects(
      revise(db, worker, allocation, "2026-09-19", { MONTHLY: 9500 }, staleVersion),
      /changed\. Refresh the page/i
    );
    assert.deepEqual(await allocationRows(db, worker), before);
  } finally {
    await db.close();
  }
});
