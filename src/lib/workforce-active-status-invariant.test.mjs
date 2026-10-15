import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../../supabase/migrations/20261015170000_workforce_active_status_invariant.sql",
  import.meta.url
);

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create table public.workforce (
      id text primary key,
      onboarding_status text,
      lifecycle_status text,
      is_active boolean not null default false,
      deleted_at timestamptz,
      deactivated_at timestamptz,
      updated_at timestamptz not null default now()
    );

    insert into public.workforce (
      id, onboarding_status, lifecycle_status, is_active, deleted_at, deactivated_at
    ) values
      ('pending-empty', 'pending', '', true, null, null),
      ('pending-onboarding', 'pending', 'onboarding', true, null, null),
      ('pending-active', 'pending', 'active', true, null, null),
      ('pending-terminal', 'pending', 'exited', true, null, null),
      ('returned', 'returned', 'onboarding', true, null, null),
      ('approved', 'approved', 'onboarding', true, null, null),
      ('rejected', 'rejected', 'onboarding', true, null, null),
      ('cancelled', 'cancelled', 'active', true, null, null),
      ('under-review', 'under_review', 'onboarding', true, null, null),
      ('deleted', 'active', 'active', true, now(), null),
      ('deactivated', 'active', 'active', true, null, now()),
      ('terminal', 'active', 'settled', true, null, null),
      ('exit-in-progress', 'active', 'settlement_pending', true, null, null),
      ('ordinary-active', 'active', 'active', true, null, null),
      ('ordinary-pending', 'pending', 'onboarding', false, null, null);
  `);
  await db.exec(await readFile(migrationUrl, "utf8"));
  return db;
}

test("migration repairs only unambiguous active/pending drift and deactivates impossible tuples", async (t) => {
  const db = await fixture();
  t.after(() => db.close());

  const { rows } = await db.query(`
    select id, onboarding_status, lifecycle_status, is_active
    from public.workforce
    order by id
  `);
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const id of ["pending-empty", "pending-onboarding", "pending-active"]) {
    assert.deepEqual(byId.get(id), {
      id,
      onboarding_status: "active",
      lifecycle_status: "active",
      is_active: true
    });
  }

  for (const id of [
    "pending-terminal",
    "returned",
    "approved",
    "rejected",
    "cancelled",
    "under-review",
    "deleted",
    "deactivated",
    "terminal"
  ]) {
    assert.equal(byId.get(id)?.is_active, false, `${id} must not remain active`);
  }

  assert.equal(byId.get("ordinary-pending")?.is_active, false);
  assert.equal(byId.get("ordinary-pending")?.onboarding_status, "pending");
  assert.equal(byId.get("exit-in-progress")?.is_active, true);
  assert.equal(byId.get("exit-in-progress")?.lifecycle_status, "settlement_pending");
  assert.equal(byId.get("ordinary-active")?.is_active, true);
});

test("database boundary canonicalizes legacy active imports, rejects review drift, and preserves exit transitions", async (t) => {
  const db = await fixture();
  t.after(() => db.close());

  await db.exec(`insert into public.workforce (id, onboarding_status, lifecycle_status, is_active)
    values ('legacy-active-import', 'pending', 'onboarding', true)`);
  const imported = await db.query(`select onboarding_status, lifecycle_status, is_active
    from public.workforce where id = 'legacy-active-import'`);
  assert.deepEqual(imported.rows[0], {
    onboarding_status: "active",
    lifecycle_status: "active",
    is_active: true
  });
  await assert.rejects(
    db.exec(`insert into public.workforce (id, onboarding_status, lifecycle_status, is_active)
      values ('invalid-review', 'under_review', 'onboarding', true)`),
    /Active Workforce profiles require active onboarding/
  );
  await assert.rejects(
    db.exec(`insert into public.workforce (id, onboarding_status, lifecycle_status, is_active)
      values ('invalid-terminal', 'active', 'exited', true)`),
    /Active Workforce profiles require active onboarding/
  );

  await db.exec(`insert into public.workforce (id, onboarding_status, lifecycle_status, is_active)
    values ('valid-active', 'active', 'active', true)`);
  await db.exec(`update public.workforce set lifecycle_status = 'resignation_pending'
    where id = 'valid-active'`);
  await db.exec(`update public.workforce set lifecycle_status = 'settlement_pending'
    where id = 'valid-active'`);

  await assert.rejects(
    db.exec(`update public.workforce set onboarding_status = 'returned'
      where id = 'valid-active'`),
    /Active Workforce profiles require active onboarding/
  );
  await assert.rejects(
    db.exec(`update public.workforce set deactivated_at = now()
      where id = 'valid-active'`),
    /Active Workforce profiles require active onboarding/
  );

  await db.exec(`update public.workforce
    set onboarding_status = 'cancelled', lifecycle_status = 'exited',
        deactivated_at = now(), is_active = false
    where id = 'valid-active'`);
  const result = await db.query(`
    select onboarding_status, lifecycle_status, is_active, deactivated_at is not null as deactivated
    from public.workforce where id = 'valid-active'
  `);
  assert.deepEqual(result.rows[0], {
    onboarding_status: "cancelled",
    lifecycle_status: "exited",
    is_active: false,
    deactivated: true
  });
});
