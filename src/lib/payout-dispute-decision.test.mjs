import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const decideMigration = readFileSync(
  new URL("../../supabase/migrations/20261008030604_simplify_workforce_payout_disputes.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const processingMigration = readFileSync(
  new URL("../../supabase/migrations/20261020100000_payout_dispute_processing_workflow.sql", import.meta.url),
  "utf8"
);
const adapterCleanup = readFileSync(
  new URL("../../supabase/migrations/20261020110000_payout_dispute_legacy_adapter_cleanup.sql", import.meta.url),
  "utf8"
);
const reviewActions = readFileSync(new URL("./payout-review-actions.ts", import.meta.url), "utf8");

test("portal payout review uses v2 and never calls the one-step decide RPC", () => {
  assert.match(reviewActions, /workforce_dispute_transition_v2/);
  assert.doesNotMatch(reviewActions, /workforce_decide_payout_dispute/);
  assert.doesNotMatch(reviewActions, /workforce_dispute_step/);
});

test("processing + adapter cleanup revoke execute on the legacy decide RPC", async () => {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    do $$ begin create role anon; create role authenticated; create role service_role; end $$;
    create table auth.users(id uuid primary key);
    create table public.companies(id uuid primary key);
    create table public.stations(id uuid primary key, company_id uuid not null);
    create table public.workforce_payroll_runs(id uuid primary key, company_id uuid not null);
    create table public.workforce_payout_publications(id uuid primary key, company_id uuid not null);
    create table public.workforce_payout_disputes(
      id uuid primary key,
      company_id uuid not null,
      publication_id uuid not null,
      payroll_run_id uuid,
      workforce_id uuid not null,
      station_id uuid not null,
      category text not null,
      reason text not null,
      status text not null,
      resolution text,
      resolved_by uuid,
      resolved_at timestamptz,
      correction_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table public.workforce_payout_dispute_events(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      dispute_id uuid not null,
      actor_id uuid,
      actor_name text not null,
      portal text not null,
      message text not null,
      created_at timestamptz not null default now()
    );
    create function public.workforce_reply_payout_dispute(uuid,uuid,uuid,text) returns void language sql as 'select';
    create function public.workforce_update_payout_dispute(uuid,uuid,uuid,text,text,text,text,uuid,uuid[]) returns void language sql as 'select';
    create function public.workforce_propose_payout_correction(uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text,uuid,uuid[]) returns void language sql as 'select';
    create function public.workforce_review_payout_correction(uuid,uuid,uuid,text,text,uuid[]) returns void language sql as 'select';
    ${decideMigration}
  `);

  const before = await db.query(`
    select has_function_privilege(
      'service_role',
      'public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])',
      'EXECUTE'
    ) as service_role
  `);
  assert.equal(before.rows[0].service_role, true);

  assert.match(
    processingMigration,
    /revoke all on function public\.workforce_decide_payout_dispute\(uuid,uuid,uuid,text,text,uuid\[\]\) from service_role/
  );
  assert.match(
    adapterCleanup,
    /revoke all on function public\.workforce_decide_payout_dispute\(uuid,uuid,uuid,text,text,uuid\[\]\) from public, anon, authenticated, service_role/
  );

  await db.exec(`
    revoke all on function public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])
      from public, anon, authenticated, service_role;
  `);
  const after = await db.query(`
    select
      has_function_privilege('authenticated', 'public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])', 'EXECUTE') as authenticated,
      has_function_privilege('service_role', 'public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])', 'EXECUTE') as service_role
  `);
  assert.equal(after.rows[0].authenticated, false);
  assert.equal(after.rows[0].service_role, false);
});
