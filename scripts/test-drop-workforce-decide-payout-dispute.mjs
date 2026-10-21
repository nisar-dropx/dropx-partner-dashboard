import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const decideMigration = readFileSync(
  new URL("../supabase/migrations/20261008030604_simplify_workforce_payout_disputes.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const dropMigration = readFileSync(
  new URL("../supabase/migrations/20261021140000_drop_workforce_decide_payout_dispute.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

async function seedDecide(db) {
  await db.exec(`
    create schema auth;
    do $$ begin create role anon; create role authenticated; create role service_role; end $$;
    create table auth.users(id uuid primary key);
    create table public.companies(id uuid primary key);
    create table public.stations(id uuid primary key, company_id uuid not null);
    create table public.workforce_payroll_runs(id uuid primary key, company_id uuid not null);
    create table public.workforce_payout_publications(id uuid primary key, company_id uuid not null);
    create table public.workforce_payout_disputes(
      id uuid primary key, company_id uuid not null, publication_id uuid not null, payroll_run_id uuid,
      workforce_id uuid not null, station_id uuid not null, category text not null, reason text not null,
      status text not null, resolution text, resolved_by uuid, resolved_at timestamptz, correction_id uuid,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table public.workforce_payout_dispute_events(
      id uuid primary key default gen_random_uuid(), company_id uuid not null, dispute_id uuid not null,
      actor_id uuid, actor_name text not null, portal text not null, message text not null,
      created_at timestamptz not null default now()
    );
    create function public.workforce_reply_payout_dispute(uuid,uuid,uuid,text) returns void language sql as 'select';
    create function public.workforce_update_payout_dispute(uuid,uuid,uuid,text,text,text,text,uuid,uuid[]) returns void language sql as 'select';
    create function public.workforce_propose_payout_correction(uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text,uuid,uuid[]) returns void language sql as 'select';
    create function public.workforce_review_payout_correction(uuid,uuid,uuid,text,text,uuid[]) returns void language sql as 'select';
    ${decideMigration}
  `);
}

const blocked = new PGlite();
await seedDecide(blocked);
await assert.rejects(blocked.exec(dropMigration), /service_role still has EXECUTE/i);

const allowed = new PGlite();
await seedDecide(allowed);
await allowed.exec(`
  revoke all on function public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])
    from public, anon, authenticated, service_role;
`);
await allowed.exec(dropMigration);
await allowed.exec(dropMigration);

const gone = await allowed.query(`
  select to_regprocedure('public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])') is null as dropped
`);
assert.equal(gone.rows[0].dropped, true);
console.log("drop workforce_decide_payout_dispute migration ok");
