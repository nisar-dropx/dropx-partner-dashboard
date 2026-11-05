import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const co = "00000000-0000-0000-0000-000000000001";
const base = "Recoverable - Missed SLA by eDSP";
await db.exec(`
create role anon; create role authenticated; create role service_role;
create table nl_loss_month_cases(company_id uuid, month text, case_key text, report text default 'nl',
 station_code text, amount numeric, source_status text, source_present boolean default true,
 data_source text default 'historic', details jsonb default '{}', final_seen_at timestamptz,
 lifecycle_status text, lifecycle_version int default 2, lifecycle_note text,
 lifecycle_updated_by uuid, lifecycle_updated_by_name text, lifecycle_updated_at timestamptz,
 primary key(company_id,month,case_key));
create table nl_loss_recoveries(company_id uuid, month text, case_key text,
 source_amount numeric, source_status text, approval_status text, is_deleted boolean default false,
 deduction_month text, allocations jsonb, updated_at timestamptz, version int default 1,
 primary key(company_id,month,case_key));
create table nl_loss_lifecycle_events(id uuid default gen_random_uuid(),company_id uuid,month text,case_key text,
 action text,from_status text,to_status text,note text,actor_name text,snapshot jsonb,created_at timestamptz default now());
create table nl_loss_source_events(company_id uuid,month text,case_key text,before_value jsonb,after_value jsonb,created_at timestamptz);
create table cache_bumps(company_id uuid, months text[]);
create function nl_recovery_bump_payout_months(co uuid,months text[]) returns void language sql
as $$ insert into public.cache_bumps values(co,months) $$;
create function nl_case_recoverable(co uuid,report text,status text) returns boolean language sql
as $$ select report='slp' or status like 'Recoverable%' $$;
`);

for (const [key, approval, state] of [
  ["approved", "approved", "recovery_approved_scheduled"],
  ["proposed", "proposed", "slp_final_confirmation_pending"],
  ["deleted", "approved", "recovery_approved_scheduled"],
  ["amount-change", "approved", "recovery_approved_scheduled"],
  ["no-evidence", "approved", "recovery_approved_scheduled"],
  ["later-action", "approved", "recovery_approved_scheduled"],
  ["other-incident", "approved", "recovery_approved_scheduled"],
]) {
  await db.query(`insert into nl_loss_month_cases(company_id,month,case_key,amount,source_status,lifecycle_status,lifecycle_updated_at)
    values($1,'2026-09',$2,100,$3,'needs_review','2026-11-04 19:21:13.639181+00')`,[co,key,base+"2"]);
  await db.query(`insert into nl_loss_recoveries(company_id,month,case_key,source_amount,source_status,approval_status,
    deduction_month,allocations,updated_at) values($1,'2026-09',$2,100,$3,$4,'2026-10',
    '[{"ref":"workforce:00000000-0000-0000-0000-000000000002","amount":100}]','2026-10-28')`,[co,key,base,approval]);
  await db.query(`insert into nl_loss_lifecycle_events(company_id,month,case_key,action,to_status,created_at)
    values($1,'2026-09',$2,'save_recovery',$3,'2026-10-28')`,[co,key,state]);
  if(key!=="no-evidence") await db.query(`insert into nl_loss_source_events values($1,'2026-09',$2,$3,$4,'2026-11-04 19:21:13.639181+00')`,
    [co,key,JSON.stringify({amount:100,source_status:base}),JSON.stringify({amount:100,source_status:base+"2"})]);
}
await db.exec(`
update nl_loss_recoveries set is_deleted=true where case_key='deleted';
update nl_loss_month_cases set amount=101 where case_key='amount-change';
update nl_loss_month_cases set lifecycle_updated_at='2026-11-03' where case_key='other-incident';
insert into nl_loss_lifecycle_events(company_id,month,case_key,to_status,created_at)
 values('${co}','2026-09','later-action','returned_to_station','2026-11-05');
`);
const plansBefore=(await db.query("select * from nl_loss_recoveries order by case_key")).rows;
const sql=fs.readFileSync("supabase/migrations/20261105052211_loss_recovery_source_status_aliases.sql","utf8");
await db.exec(sql);
// Attach the production triggers, then run the migration twice against the incident fixture.
await db.exec(`
create trigger lifecycle_defaults before insert or update on nl_loss_month_cases
 for each row execute function nl_loss_case_lifecycle_defaults();
create trigger payout_bump after update on nl_loss_month_cases
 referencing old table as old_cases new table as new_cases
 for each statement execute function nl_case_bump_payout_months();
update nl_loss_month_cases set lifecycle_status='needs_review',lifecycle_updated_at='2026-11-04 19:21:13.639181+00'
 where case_key in ('approved','proposed');
delete from nl_loss_lifecycle_events where action='restore_source_label_alias';
delete from cache_bumps;
`);
await db.exec(sql);
const states=(await db.query("select case_key,lifecycle_status from nl_loss_month_cases order by case_key")).rows;
assert.equal(states.find(r=>r.case_key==="approved").lifecycle_status,"recovery_approved_scheduled");
assert.equal(states.find(r=>r.case_key==="proposed").lifecycle_status,"slp_final_confirmation_pending");
for(const r of states.filter(r=>!["approved","proposed"].includes(r.case_key))) assert.equal(r.lifecycle_status,"needs_review",r.case_key);
assert.equal((await db.query("select count(*)::int n from cache_bumps")).rows[0].n,1);
assert.equal((await db.query("select count(*)::int n from nl_loss_lifecycle_events where action='restore_source_label_alias'")).rows[0].n,2);
const versions=(await db.query("select case_key,lifecycle_version from nl_loss_month_cases order by case_key")).rows;
await db.exec(sql);
assert.deepEqual((await db.query("select case_key,lifecycle_version from nl_loss_month_cases order by case_key")).rows,versions);
assert.equal((await db.query("select count(*)::int n from nl_loss_lifecycle_events where action='restore_source_label_alias'")).rows[0].n,2);
assert.deepEqual((await db.query("select * from nl_loss_recoveries order by case_key")).rows,plansBefore);
const snapshot=(await db.query("select snapshot from nl_loss_lifecycle_events where action='restore_source_label_alias' limit 1")).rows[0].snapshot;
assert.equal(snapshot.before_case.lifecycle_status,"needs_review");
assert.ok(snapshot.previous_event_id);
assert.equal(snapshot.recovery_plan.deduction_month,"2026-10");
await db.query("update nl_loss_month_cases set source_status=$1 where case_key='approved'",[base+"1"]);
assert.equal((await db.query("select lifecycle_status from nl_loss_month_cases where case_key='approved'")).rows[0].lifecycle_status,"recovery_approved_scheduled");
await db.exec("update nl_loss_month_cases set amount=102 where case_key='approved'");
assert.equal((await db.query("select lifecycle_status from nl_loss_month_cases where case_key='approved'")).rows[0].lifecycle_status,"needs_review");
await db.exec("update nl_loss_month_cases set source_status='Non-recoverable' where case_key='proposed'");
assert.equal((await db.query("select lifecycle_status from nl_loss_month_cases where case_key='proposed'")).rows[0].lifecycle_status,"needs_review");
console.log("PASS: audited repair, pending approvals preserved, no plan mutation, cache invalidation, idempotency, future alias refresh and genuine drift guards.");
await db.close();
