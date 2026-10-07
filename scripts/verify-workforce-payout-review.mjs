import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../supabase/migrations/20261005220500_workforce_payout_review_submissions.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const pgliteMigration = migration.replace(/create extension if not exists pgcrypto\s*;/gi, "");
const tableSource = readFileSync(new URL("../src/components/workforce-payout-table.tsx", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/app/api/payments/workforce-payouts/send-review/route.ts", import.meta.url), "utf8");

assert.match(tableSource, /Send for review/);
assert.match(tableSource, /type="checkbox"/);
assert.match(tableSource, /MAX_REVIEW_SELECTION = 1000/);
assert.match(tableSource, /selectable\.slice\(0, MAX_REVIEW_SELECTION\)/);
assert.match(tableSource, /Up to \{MAX_REVIEW_SELECTION\.toLocaleString\("en-IN"\)\} payouts per action/);
assert.match(routeSource, /ops_workforce_payouts/);
assert.match(routeSource, /hasPermission\(authorization, pageCode, "edit"\)/);
assert.match(routeSource, /if \(!sameOrigin\(request\)\)/);
assert.doesNotMatch(tableSource, /snapshot:\s*\{\s*dropxId/);
assert.doesNotMatch(routeSource, /item\?\.snapshot/);
assert.match(routeSource, /selected more than once/);
assert.match(routeSource, /workforcePayoutReviewTokenStatus/);
assert.match(routeSource, /expected_status/);

const db = new PGlite();
await db.exec(`
  create schema if not exists auth;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  create table auth.users(id uuid primary key);
  create table public.companies(id uuid primary key);
  create table public.stations(id uuid primary key, company_id uuid not null, station_code text, unique(company_id,id));
  create table public.workforce(
    id uuid primary key, company_id uuid not null, location_id uuid, deleted_at timestamptz,
    migration_state text not null default 'canonical', source_profile_type text, source_profile_id uuid
  );
  create table public.field_executive_provider_mappings(
    id uuid primary key, company_id uuid not null, workforce_id uuid, station_id uuid,
    employee_id uuid, contractor_id uuid, field_executive_id uuid,
    status text not null, effective_from date not null, effective_to date
  );
  create table public.workforce_payment_allocations(
    id uuid primary key, company_id uuid not null, workforce_id uuid, station_id uuid,
    status text not null, effective_from date not null, effective_to date
  );
  create table public.workforce_additional_payment_values(
    id uuid primary key, company_id uuid not null, workforce_id uuid not null,
    station_id uuid, effective_from date not null, effective_to date not null
  );
  create table public.helpers(id uuid primary key, company_id uuid not null, location_id uuid);
  create table public.helper_payment_allocations(
    id uuid primary key, company_id uuid not null, helper_id uuid, station_id uuid,
    status text not null, effective_from date not null, effective_to date
  );
  ${pgliteMigration}
`);

const company = "00000000-0000-4000-8000-000000000001";
const actor = "00000000-0000-4000-8000-000000000002";
const station = "00000000-0000-4000-8000-000000000003";
const otherStation = "00000000-0000-4000-8000-000000000004";
const workforce = "00000000-0000-4000-8000-000000000005";
const helper = "00000000-0000-4000-8000-000000000006";
await db.query(`insert into auth.users(id) values ($1)`, [actor]);
await db.query(`insert into public.companies(id) values ($1)`, [company]);
await db.query(`insert into public.stations(id,company_id,station_code) values ($1,$2,'TEST'),($3,$2,'OTHER')`, [station, company, otherStation]);
await db.query(`insert into public.workforce(id,company_id,location_id) values ($1,$2,$3)`, [workforce, company, station]);
await db.query(`insert into public.helpers(id,company_id,location_id) values ($1,$2,$3)`, [helper, company, station]);
await db.query(`insert into public.field_executive_provider_mappings(id,company_id,workforce_id,station_id,status,effective_from)
  values ($1,$2,$3,$4,'active','2026-01-01')`, ["00000000-0000-4000-8000-000000000008", company, workforce, station]);
await db.query(`insert into public.helper_payment_allocations(id,company_id,helper_id,station_id,status,effective_from)
  values ($1,$2,$3,$4,'active','2026-01-01')`, ["00000000-0000-4000-8000-000000000009", company, helper, station]);

const items = JSON.stringify([
  { subject_type: "workforce", subject_id: workforce, location_id: station, expected_status: "ready", snapshot: { netAmount: 999999999 } },
  { subject_type: "helper", subject_id: helper, location_id: station, expected_status: "ready", snapshot: { netAmount: -999999999 } }
]);
const submitted = await db.query(
  `select public.workforce_send_payouts_for_review($1,$2,'2026-09-01','2026-09-30',$3::jsonb,array[$4]::uuid[]) as count`,
  [company, actor, items, station]
);
assert.equal(submitted.rows[0].count, 2);

let rows = await db.query(`
  select
    subject_type,
    status,
    calculation_snapshot->>'source' as source,
    calculation_snapshot->>'schema_version' as schema_version,
    calculation_snapshot->>'amounts_included' as amounts_included,
    calculation_snapshot ? 'netAmount' as has_client_amount
  from public.workforce_payout_review_submissions
  order by subject_type
`);
assert.deepEqual(rows.rows.map((row) => [row.subject_type, row.status, row.source, row.schema_version, row.amounts_included, row.has_client_amount]), [
  ["helper", "under_review", "workforce_payouts", "1", "false", false],
  ["workforce", "under_review", "workforce_payouts", "1", "false", false]
]);

const readyItems = JSON.stringify([{ subject_type: "workforce", subject_id: workforce, location_id: station, expected_status: "ready", snapshot: { netAmount: 125 } }]);
await assert.rejects(
  db.query(
    `select public.workforce_send_payouts_for_review($1,$2,'2026-09-01','2026-09-30',$3::jsonb,null)`,
    [company, actor, readyItems]
  ),
  /review state changed/i
);
await db.query(`update public.workforce_payout_review_submissions set status='returned'
  where subject_type='workforce' and subject_id=$1 and location_id=$2`, [workforce, station]);
await assert.rejects(
  db.query(`update public.workforce_payout_review_submissions set status='approved'
    where subject_type='workforce' and subject_id=$1 and location_id=$2`, [workforce, station]),
  /invalid payout review status transition/i,
  "a returned review must be resubmitted before approval"
);
await assert.rejects(
  db.query(
    `select public.workforce_send_payouts_for_review($1,$2,'2026-09-01','2026-09-30',$3::jsonb,null)`,
    [company, actor, readyItems]
  ),
  /review state changed/i,
  "a stale Ready token must not overwrite a Returned review"
);
assert.equal((await db.query(`select status from public.workforce_payout_review_submissions where subject_type='workforce' and location_id=$1`, [station])).rows[0].status, "returned");

const returnedItems = JSON.stringify([{ subject_type: "workforce", subject_id: workforce, location_id: station, expected_status: "returned" }]);
await db.query(
  `select public.workforce_send_payouts_for_review($1,$2,'2026-09-01','2026-09-30',$3::jsonb,null)`,
  [company, actor, returnedItems]
);
rows = await db.query(`select status, calculation_snapshot->>'source' as source, calculation_snapshot ? 'netAmount' as has_client_amount from public.workforce_payout_review_submissions where subject_type='workforce' and location_id=$1`, [station]);
assert.deepEqual(rows.rows[0], { status: "under_review", source: "workforce_payouts", has_client_amount: false });
await assert.rejects(
  db.query(
    `select public.workforce_send_payouts_for_review($1,$2,'2026-09-01','2026-09-30',$3::jsonb,null)`,
    [company, actor, returnedItems]
  ),
  /review state changed/i,
  "a Returned token must stop working after the row returns to Under Review"
);
assert.equal((await db.query(`select count(*)::int as count from public.workforce_payout_review_submissions`)).rows[0].count, 2);

await db.query(`insert into public.field_executive_provider_mappings(id,company_id,workforce_id,station_id,status,effective_from)
  values ($1,$2,$3,$4,'active','2026-01-01')`, ["00000000-0000-4000-8000-000000000007", company, workforce, otherStation]);
await db.query(
  `select public.workforce_send_payouts_for_review($1,$2,'2026-09-01','2026-09-30',$3::jsonb,null)`,
  [company, actor, JSON.stringify([{ subject_type: "workforce", subject_id: workforce, location_id: otherStation, expected_status: "ready" }])]
);
assert.equal((await db.query(`select count(*)::int as count from public.workforce_payout_review_submissions`)).rows[0].count, 3,
  "the same person can have separate review rows for simultaneous locations");

await db.query(`update public.workforce_payout_review_submissions set status='approved'
  where subject_type='workforce' and subject_id=$1 and location_id=$2`, [workforce, station]);
await assert.rejects(
  db.query(`update public.workforce_payout_review_submissions set status='returned'
    where subject_type='workforce' and subject_id=$1 and location_id=$2`, [workforce, station]),
  /cannot be reopened or changed/i,
  "a direct service-role table update cannot reopen an approved review"
);
await assert.rejects(
  db.query(
    `select public.workforce_send_payouts_for_review($1,$2,'2026-09-01','2026-09-30',$3::jsonb,null)`,
    [company, actor, returnedItems]
  ),
  /cannot be reopened/i
);

const duplicateItems = JSON.stringify([
  { subject_type: "workforce", subject_id: workforce, location_id: station, expected_status: "ready" },
  { subject_type: "workforce", subject_id: workforce, location_id: station, expected_status: "ready" }
]);
await assert.rejects(
  db.query(
    `select public.workforce_send_payouts_for_review($1,$2,'2026-09-01','2026-09-30',$3::jsonb,null)`,
    [company, actor, duplicateItems]
  ),
  /selected more than once/i
);
assert.equal((await db.query(`select count(*)::int as count from public.workforce_payout_review_submissions`)).rows[0].count, 3);

await db.query(`update public.workforce_payout_review_submissions set status='cancelled'
  where subject_type='helper' and subject_id=$1 and location_id=$2`, [helper, station]);
await assert.rejects(
  db.query(`update public.workforce_payout_review_submissions set status='under_review'
    where subject_type='helper' and subject_id=$1 and location_id=$2`, [helper, station]),
  /cannot be reopened or changed/i,
  "a direct service-role table update cannot reopen a cancelled review"
);

await assert.rejects(
  db.query(
    `select public.workforce_send_payouts_for_review($1,$2,'2026-09-01','2026-09-30',$3::jsonb,array[$4]::uuid[])`,
    [company, actor, items, otherStation]
  ),
  /outside your location scope/i
);

const rls = await db.query(`select relrowsecurity,relforcerowsecurity from pg_class where oid='public.workforce_payout_review_submissions'::regclass`);
assert.deepEqual(rls.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
const privileges = await db.query(`select
  has_table_privilege('service_role','public.workforce_payout_review_submissions','SELECT') as can_select,
  has_table_privilege('service_role','public.workforce_payout_review_submissions','INSERT') as can_insert,
  has_table_privilege('service_role','public.workforce_payout_review_submissions','UPDATE') as can_update,
  has_table_privilege('service_role','public.workforce_payout_review_submissions','DELETE') as can_delete,
  has_table_privilege('service_role','public.workforce_payout_review_submissions','TRUNCATE') as can_truncate
`);
assert.deepEqual(privileges.rows[0], {
  can_select: true,
  can_insert: true,
  can_update: true,
  can_delete: false,
  can_truncate: false
});

console.log("Workforce payout review submission verification passed.");
