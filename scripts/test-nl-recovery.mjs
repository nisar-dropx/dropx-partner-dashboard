import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  isRecoverable,
  splitRecovery,
  recoveryCsv,
} from "../src/lib/ops-pulse/nl-loss-policy.ts";
const db = new PGlite();
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const co = id(1),
  other = id(2),
  station = id(3),
  actor = id(4);
await db.exec(`create role anon;create role authenticated;create role service_role;
create table companies(id uuid primary key,code text);insert into companies values('${co}','DROPX_LOGISTICS'),('${other}','OTHER');
create table stations(id uuid primary key,company_id uuid,station_code text);insert into stations values('${station}','${co}','TEST');
create table cod_station_settings(company_id uuid,location_id uuid,portal_station_code text);
create table app_pages(id uuid default gen_random_uuid() primary key,company_id uuid,code text,name text,sort_order int,unique(company_id,code));
create table user_roles(id uuid primary key,company_id uuid,code text);
create table role_page_permissions(company_id uuid,role_id uuid,page_id uuid,can_view boolean,can_add boolean,can_edit boolean,unique(company_id,role_id,page_id));
create function station_audit_employee_directory(p_company uuid,p_station uuid) returns table(ref text,employee_code text,full_name text,designation text,is_active boolean) language sql as $$
 select 'employee:'||n,n::text,'Test person '||n,'Station staff',n<>3 from generate_series(1,3)n where p_company='${co}' and p_station='${station}' $$;`);
for (const file of [
  "20260929120000_nl_slp_loss_reports.sql",
  "20260929160000_loss_cases_typed.sql",
])
  await db.exec(fs.readFileSync("supabase/migrations/" + file, "utf8"));
await db.exec(
  fs.readFileSync(
    "supabase/migrations/20261005194905_nl_monthly_recovery.sql",
    "utf8",
  ),
);
const row = (key, month = "2026-8", amount = 1000, status = "Recoverable") => ({
  case_key: key,
  tid: key,
  period: month,
  station_code: "TEST",
  amount,
  extra: { nl_status: status },
});
const pull = async (rows) =>
  (
    await db.query("select loss_apply_cases('nl',$1,$2) id", [
      { source_file: "fixture.csv", source_total_count: rows.length },
      rows,
    ])
  ).rows[0].id;
await pull([
  row("A"),
  row("B", "2026-8", 90, "Non-Recoverable"),
  row("C", "2026-8", 10, "Recoverable - Missed SLA by eDSP1"),
]);
let cases = (
  await db.query("select * from nl_loss_month_cases order by case_key")
).rows;
assert.equal(cases.length, 3);
assert.equal(cases[0].month, "2026-08");
assert.equal(
  (
    await db.query(
      "select count(*)::int n from nl_loss_month_cases where nl_is_recoverable(company_id,source_status)",
    )
  ).rows[0].n,
  2,
);
const save = async ({
  key = "A",
  month = "2026-08",
  company = co,
  version = 0,
  mode = "equal",
  people = ["employee:1", "employee:2", "employee:3"],
  amounts = [],
  outcome = "recover",
  remarks = "Verified responsibility",
} = {}) =>
  (
    await db.query(
      "select save_nl_recovery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r",
      [
        company,
        month,
        key,
        version,
        outcome,
        mode,
        people.map((ref, i) => ({
          employee_ref: ref,
          ...(amounts[i] != null ? { amount: amounts[i] } : {}),
        })),
        remarks,
        actor,
        "Test manager",
      ],
    )
  ).rows[0].r;
await assert.rejects(save({ company: other }), /no longer recoverable/);
await assert.rejects(save({ key: "B" }), /no longer recoverable/);
await assert.rejects(save({ people: ["employee:99"] }), /not linked/);
await assert.rejects(
  save({ people: ["employee:1", "employee:1"] }),
  /only be selected once/,
);
await assert.rejects(
  save({ mode: "custom", people: ["employee:1"], amounts: [999] }),
  /full loss value/,
);
await assert.rejects(
  save({ mode: "custom", people: ["employee:1"], amounts: [1000.001] }),
  /two decimal/,
);
let saved = await save();
assert.deepEqual(
  saved.allocations.map((a) => a.amount),
  [333.34, 333.33, 333.33],
);
await assert.rejects(save(), /Another person/);
saved = await save({
  version: 1,
  mode: "custom",
  people: ["employee:1", "employee:2"],
  amounts: [600, 400],
});
assert.equal(saved.version, 2);
await db.query("select clear_nl_recovery($1,$2,$3,$4,$5,$6)", [
  co,
  "2026-08",
  "A",
  2,
  actor,
  "Test manager",
]);
assert.equal(
  (await db.query("select is_deleted from nl_loss_recoveries")).rows[0]
    .is_deleted,
  true,
);
saved = await save({
  version: 3,
  outcome: "post_dispute",
  mode: "none",
  people: [],
});
assert.equal(saved.is_deleted, false);
assert.equal(saved.version, 4);
assert.equal(
  (await db.query("select count(*)::int n from nl_loss_recovery_events"))
    .rows[0].n,
  4,
);
await db.query(
  "update nl_loss_sources set allow_equal_split=false,include_inactive_people=false where company_id=$1",
  [co],
);
await assert.rejects(save({ version: 4 }), /disabled in Master/);
await assert.rejects(
  save({ version: 4, mode: "custom", people: ["employee:3"], amounts: [1000] }),
  /Inactive employees/,
);
await db.query(
  "update nl_recovery_outcomes set is_active=false where company_id=$1 and code='post_dispute'",
  [co],
);
await assert.rejects(
  save({ version: 4, outcome: "post_dispute", mode: "none", people: [] }),
  /active outcome/,
);
assert.equal(
  (await db.query("select count(*)::int n from nl_recovery_master_events"))
    .rows[0].n,
  2,
);
await pull([row("A", "2026-9", 20)]);
assert.equal(
  (await db.query("select count(*)::int n from nl_loss_month_cases")).rows[0].n,
  4,
  "month rollover preserves history and same TID",
);
await pull([row("A", "2026-8", 1000, "Non-Recoverable")]);
assert.equal(
  (
    await db.query(
      "select source_present from nl_loss_month_cases where case_key='C'",
    )
  ).rows[0].source_present,
  false,
  "removed source cases disappear for the refreshed month",
);
assert.equal(
  (
    await db.query(
      "select count(*)::int n from nl_loss_month_cases where source_present and nl_is_recoverable(company_id,source_status)",
    )
  ).rows[0].n,
  1,
);
await assert.rejects(pull([]), /Empty NL export/);
await assert.rejects(pull([row("Z", "unknown")]), /ambiguous/);
assert.equal(
  (await db.query("select count(*)::int n from nl_loss_month_cases")).rows[0].n,
  4,
  "failed imports are atomic",
);
for (const name of [
  "save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text)",
  "clear_nl_recovery(uuid,text,text,int,uuid,text)",
  "nl_archive_pull(uuid,jsonb)",
])
  assert.equal(
    (
      await db.query(
        "select has_function_privilege('authenticated',$1,'EXECUTE') ok",
        [name],
      )
    ).rows[0].ok,
    false,
  );
assert.equal(
  (
    await db.query(
      "select has_table_privilege('authenticated','nl_loss_recoveries','SELECT') ok",
    )
  ).rows[0].ok,
  false,
);
assert.equal(isRecoverable("Non-Recoverable", ["Recoverable"]), false);
assert.equal(isRecoverable(" recoverable ", ["Recoverable"]), true);
assert.deepEqual(
  splitRecovery(1000, ["a", "b", "c"]).map((a) => a.amount),
  [333.34, 333.33, 333.33],
);
assert.equal(recoveryCsv("=SUM(A1)"), '"\'=SUM(A1)"');
await db.close();
console.log(
  "PASS: monthly retention, source status, tenant isolation, employee scope, splits, version conflicts, removal history, Master controls and RPC privileges",
);
