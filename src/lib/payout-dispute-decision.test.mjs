import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const source = readFileSync(
  new URL("../../supabase/migrations/20261008030604_simplify_workforce_payout_disputes.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

test("Dashboard decisions are terminal, scoped and audit logged", async () => {
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
    grant execute on function public.workforce_reply_payout_dispute(uuid,uuid,uuid,text) to service_role;
    grant execute on function public.workforce_update_payout_dispute(uuid,uuid,uuid,text,text,text,text,uuid,uuid[]) to service_role;
    grant execute on function public.workforce_propose_payout_correction(uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text,uuid,uuid[]) to service_role;
    grant execute on function public.workforce_review_payout_correction(uuid,uuid,uuid,text,text,uuid[]) to service_role;
    ${source}
  `);

  const company = "00000000-0000-4000-8000-000000000001";
  const actor = "00000000-0000-4000-8000-000000000002";
  const station = "00000000-0000-4000-8000-000000000003";
  const otherStation = "00000000-0000-4000-8000-000000000004";
  const workforce = "00000000-0000-4000-8000-000000000005";
  const publication = "00000000-0000-4000-8000-000000000006";
  const dispute = "00000000-0000-4000-8000-000000000007";
  const rejectedDispute = "00000000-0000-4000-8000-000000000008";

  await db.query("insert into auth.users(id) values ($1)", [actor]);
  await db.query("insert into public.companies(id) values ($1)", [company]);
  await db.query("insert into public.stations(id,company_id) values ($1,$2),($3,$2)", [station, company, otherStation]);
  await db.query("insert into public.workforce_payout_publications(id,company_id) values ($1,$2)", [publication, company]);
  await db.query(
    `insert into public.workforce_payout_disputes(
      id,company_id,publication_id,workforce_id,station_id,category,reason,status
    ) values ($1,$2,$3,$4,$5,'other','Please review this payout','open'),
      ($6,$2,$3,$4,$5,'other','Please review this payout','in_review')`,
    [dispute, company, publication, workforce, station, rejectedDispute]
  );

  await assert.rejects(
    db.query("select public.workforce_decide_payout_dispute($1,$2,$3,'Reviewer','resolved',array[$4]::uuid[])", [company, dispute, actor, otherStation]),
    /outside your scope/i
  );
  await assert.rejects(
    db.query("select public.workforce_decide_payout_dispute($1,$2,$3,'Reviewer','resolved',array[$4,null]::uuid[])", [company, dispute, actor, otherStation]),
    /outside your scope/i
  );
  await assert.rejects(
    db.query("select public.workforce_decide_payout_dispute($1,$2,$3,'Reviewer','in_review',null)", [company, dispute, actor]),
    /Resolve or Reject/i
  );

  await db.query(
    "select public.workforce_decide_payout_dispute($1,$2,$3,'Reviewer','resolved',array[$4]::uuid[])",
    [company, dispute, actor, station]
  );
  await db.query(
    "select public.workforce_decide_payout_dispute($1,$2,$3,'Reviewer','rejected',null)",
    [company, rejectedDispute, actor]
  );

  const rows = await db.query(
    "select id,status,resolution,resolved_by,resolved_at from public.workforce_payout_disputes order by id"
  );
  assert.deepEqual(rows.rows.map((row) => row.status), ["resolved", "rejected"]);
  assert.equal(rows.rows[0].resolution, "Dispute resolved in Dashboard.");
  assert.equal(rows.rows[0].resolved_by, actor);
  assert.ok(rows.rows[0].resolved_at);
  assert.equal(rows.rows[1].resolution, "Dispute rejected in Dashboard.");

  const events = await db.query(
    "select actor_name,portal,message from public.workforce_payout_dispute_events order by created_at,id"
  );
  assert.deepEqual(events.rows.map((row) => row.portal), ["workforce", "workforce"]);
  assert.deepEqual(events.rows.map((row) => row.message), [
    "Dispute resolved in Dashboard.",
    "Dispute rejected in Dashboard."
  ]);

  await assert.rejects(
    db.query("select public.workforce_decide_payout_dispute($1,$2,$3,'Reviewer','resolved',null)", [company, dispute, actor]),
    /already closed/i
  );
  const privileges = await db.query(`
    select
      has_function_privilege('authenticated', 'public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])', 'EXECUTE') as authenticated,
      has_function_privilege('service_role', 'public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])', 'EXECUTE') as service_role,
      has_function_privilege('service_role', 'public.workforce_reply_payout_dispute(uuid,uuid,uuid,text)', 'EXECUTE') as legacy_reply,
      has_function_privilege('service_role', 'public.workforce_update_payout_dispute(uuid,uuid,uuid,text,text,text,text,uuid,uuid[])', 'EXECUTE') as legacy_update,
      has_function_privilege('service_role', 'public.workforce_propose_payout_correction(uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text,uuid,uuid[])', 'EXECUTE') as legacy_propose,
      has_function_privilege('service_role', 'public.workforce_review_payout_correction(uuid,uuid,uuid,text,text,uuid[])', 'EXECUTE') as legacy_review
  `);
  assert.equal(privileges.rows[0].authenticated, false);
  assert.equal(privileges.rows[0].service_role, true);
  assert.equal(privileges.rows[0].legacy_reply, false);
  assert.equal(privileges.rows[0].legacy_update, false);
  assert.equal(privileges.rows[0].legacy_propose, false);
  assert.equal(privileges.rows[0].legacy_review, false);
});
