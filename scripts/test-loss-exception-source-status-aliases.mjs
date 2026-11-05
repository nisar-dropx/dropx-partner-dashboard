import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const co = "00000000-0000-0000-0000-000000000001";
const base = "Recoverable - Missed SLA by eDSP";

await db.exec(`
create role anon; create role authenticated; create role service_role;
create table nl_loss_month_cases(
  company_id uuid, month text, case_key text, amount numeric, source_status text,
  primary key(company_id,month,case_key));
create table nl_loss_exception_options(
  company_id uuid, month text, case_key text, kind text, enabled boolean,
  deduction_month text, source_amount numeric, source_status text, updated_at timestamptz default now(),
  primary key(company_id,month,case_key,kind));
`);

const keySql = fs.readFileSync("supabase/migrations/20261105052211_loss_recovery_source_status_aliases.sql", "utf8");
// Only the status-key helper is needed from that file for this test.
await db.exec(keySql.split("CREATE OR REPLACE FUNCTION public.nl_loss_case_lifecycle_defaults")[0]);

await db.query(
  `insert into nl_loss_month_cases values($1,'2026-09','tid-1',100,$2)`,
  [co, base + "2"],
);
await db.query(
  `insert into nl_loss_exception_options(company_id,month,case_key,kind,enabled,deduction_month,source_amount,source_status)
   values($1,'2026-09','tid-1','installments',true,null,100,$2),
         ($1,'2026-09','tid-1','next_month',true,'2026-10',100,$2)`,
  [co, base],
);

const aliasSql = fs.readFileSync("supabase/migrations/20261105124500_loss_exception_source_status_aliases.sql", "utf8");
await db.exec(aliasSql);
await db.exec(aliasSql);

assert.equal(
  (await db.query(`select nl_loss_exception_allowed($1,'2026-09','tid-1','installments',null) ok`, [co])).rows[0].ok,
  true,
  "installments remain allowed across eDSP aliases",
);
assert.equal(
  (await db.query(`select nl_loss_exception_allowed($1,'2026-09','tid-1','next_month','2026-10') ok`, [co])).rows[0].ok,
  true,
  "next_month remains allowed across eDSP aliases",
);
assert.equal(
  (await db.query(`select source_status from nl_loss_exception_options where kind='installments'`)).rows[0].source_status,
  base + "2",
  "grant label synced to live alias",
);

await db.query(`update nl_loss_month_cases set source_status='Non-recoverable' where case_key='tid-1'`);
assert.equal(
  (await db.query(`select nl_loss_exception_allowed($1,'2026-09','tid-1','installments',null) ok`, [co])).rows[0].ok,
  false,
  "genuine outcome changes still revoke the entitlement",
);

console.log("PASS: exception entitlements follow equivalent eDSP labels; genuine changes still block.");
await db.close();
