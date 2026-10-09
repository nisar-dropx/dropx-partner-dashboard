import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("../../supabase/migrations/20261009015557_allow_shared_mobile_numbers_across_people.sql", import.meta.url);
const registers = ["employees", "contractors", "vendors", "workforce_helpers"];

test("the People trigger allows shared mobiles without changing other identity fields", async () => {
  const db = new PGlite();
  try {
    for (const register of registers) {
      await db.exec(`
        create table public.${register} (
          id bigserial primary key,
          mobile text not null check (mobile ~ '^\\d{10}$'),
          email text not null unique,
          dropx_id text not null unique,
          biometric_id text not null unique
        );
      `);
    }
    await db.exec(`
      create table public.workforce (
        id bigserial primary key,
        mobile text not null check (mobile ~ '^\\d{10}$'),
        email text not null unique,
        dropx_id text not null unique,
        biometric_id text not null unique,
        identity_exception_required boolean not null default false,
        identity_exception_context jsonb not null default '{}'::jsonb,
        identity_exception_approved_at timestamptz,
        identity_exception_approved_by text
      );
    `);

    await db.exec(await readFile(migrationUrl, "utf8"));
    for (const register of [...registers, "workforce"]) {
      await db.exec(`
        create trigger ${register}_mobile_identity
        before insert or update on public.${register}
        for each row execute function public.enforce_onboarding_mobile_identity();
      `);
    }

    const sharedMobile = "7724078559";
    for (const [index, register] of registers.entries()) {
      await db.query(
        `insert into public.${register} (mobile, email, dropx_id, biometric_id) values ($1, $2, $3, $4)`,
        [sharedMobile, `${register}@example.test`, `DX-${index}`, `BIO-${index}`]
      );
    }
    const approvedAt = "2026-10-01T08:30:00.000Z";
    const approvedBy = "reviewer-1";
    await db.query(`
      insert into public.workforce (
        mobile, email, dropx_id, biometric_id,
        identity_exception_required, identity_exception_context,
        identity_exception_approved_at, identity_exception_approved_by
      ) values ($1, $2, $3, $4, true, $5::jsonb, $6, $7)
    `, [sharedMobile, "workforce@example.test", "DX-W", "BIO-W", '{"reason":"historical-review"}', approvedAt, approvedBy]);

    const state = await db.query(`
      select identity_exception_required, identity_exception_context,
             identity_exception_approved_at, identity_exception_approved_by
      from public.workforce
    `);
    assert.equal(state.rows[0].identity_exception_required, true);
    assert.deepEqual(state.rows[0].identity_exception_context, { reason: "historical-review" });
    assert.equal(new Date(state.rows[0].identity_exception_approved_at).toISOString(), approvedAt);
    assert.equal(state.rows[0].identity_exception_approved_by, approvedBy);

    await assert.rejects(
      db.query(
        "insert into public.employees (mobile, email, dropx_id, biometric_id) values ($1, $2, $3, $4)",
        ["9000000000", "other@example.test", "DX-0", "BIO-OTHER"]
      ),
      /duplicate key/i
    );
    await assert.rejects(
      db.query(
        "insert into public.employees (mobile, email, dropx_id, biometric_id) values ($1, $2, $3, $4)",
        ["9000000001", "employees@example.test", "DX-OTHER", "BIO-OTHER"]
      ),
      /duplicate key/i
    );
    await assert.rejects(
      db.query(
        "insert into public.employees (mobile, email, dropx_id, biometric_id) values ($1, $2, $3, $4)",
        ["9000000002", "other-2@example.test", "DX-OTHER-2", "BIO-0"]
      ),
      /duplicate key/i
    );
    await assert.rejects(
      db.query(
        "insert into public.employees (mobile, email, dropx_id, biometric_id) values ($1, $2, $3, $4)",
        ["invalid", "other-3@example.test", "DX-OTHER-3", "BIO-OTHER-3"]
      ),
      /check constraint/i
    );
  } finally {
    await db.close();
  }
});
