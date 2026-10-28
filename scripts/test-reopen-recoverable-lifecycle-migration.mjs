// Reopen not_recoverable when source flips back to recoverable; repair stuck rows.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`
create role service_role; create role anon; create role authenticated;
create table companies(id uuid primary key);
create table nl_loss_sources(account_key text primary key, company_id uuid,
 recoverable_statuses text[] default array['Recoverable - Missed SLA by eDSP','Recoverable - Partner miss']);
create function nl_is_recoverable(co uuid,status text) returns boolean language sql stable as $$
 select exists(select 1 from nl_loss_sources s,unnest(s.recoverable_statuses) l
  where s.company_id=co and lower(trim(l))=lower(trim(status))) $$;
create function nl_case_recoverable(co uuid,p_report text,status text) returns boolean language sql stable as $$
 select p_report='slp' or (p_report='station' and status='Approved') or nl_is_recoverable(co,status) $$;
create table nl_loss_month_cases(
 company_id uuid, report text not null default 'nl', month text, case_key text,
 station_code text, amount numeric(14,2), source_status text, details jsonb not null default '{}',
 source_present boolean default true, data_source text, final_seen_at timestamptz,
 lifecycle_status text not null default 'imported', lifecycle_version int not null default 1,
 lifecycle_updated_at timestamptz, lifecycle_note text default '',
 primary key(company_id,month,case_key));
`);

const C = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
await db.exec(`insert into companies values('${C}');
insert into nl_loss_sources(account_key,company_id) values('default','${C}');
insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status,data_source,lifecycle_status,lifecycle_version)
values
 ('${C}','nl','2026-09','630425673376','KLZA',1.91,'Recoverable - Missed SLA by eDSP','live','not_recoverable',2),
 ('${C}','nl','2026-09','KEEP','KLZA',5.00,'Non-Recoverable','historic','not_recoverable',1),
 ('${C}','nl','2026-09','FLIP','KLZA',3.00,'Non-Recoverable','historic','not_recoverable',1);`);

const sql = readFileSync("supabase/migrations/20261028230000_reopen_recoverable_not_recoverable_lifecycle.sql", "utf8");
await db.exec(sql);
await db.exec(sql); // idempotent (function + repair)

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const one = async (q) => (await db.query(q)).rows[0];

eq("KLZA case reopened to dispute window", await one(`select lifecycle_status,lifecycle_version from nl_loss_month_cases where case_key='630425673376'`),
  { lifecycle_status: "station_dispute_or_clarification_window", lifecycle_version: 3 });
eq("true non-recoverable stays closed", await one(`select lifecycle_status from nl_loss_month_cases where case_key='KEEP'`),
  { lifecycle_status: "not_recoverable" });

await db.exec(`update nl_loss_month_cases set source_status='Recoverable - Partner miss' where case_key='FLIP'`);
eq("source flip reopens via trigger", await one(`select lifecycle_status from nl_loss_month_cases where case_key='FLIP'`),
  { lifecycle_status: "cluster_validation_pending" });

await db.exec(`update nl_loss_month_cases set source_status='Non-Recoverable' where case_key='FLIP'`);
eq("source flip closes again", await one(`select lifecycle_status from nl_loss_month_cases where case_key='FLIP'`),
  { lifecycle_status: "not_recoverable" });

if (fails) process.exit(1);
console.log("All checks passed.");
