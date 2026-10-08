import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  casePhase,
  disputeGate,
  filedInCloak,
  parseLiveWindow,
  windowSummary,
} from "../src/lib/ops-pulse/nl-dispute-policy.ts";
import {
  parseAllocationCell,
  matchOutcome,
} from "../src/lib/ops-pulse/loss-workbook-policy.ts";

const db = new PGlite();
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const co = id(1),
  station = id(3),
  actor = id(4),
  admin = id(5),
  slpm = id(6),
  clm = id(7);
await db.exec(`create role anon;create role authenticated;create role service_role;
create table companies(id uuid primary key,code text);insert into companies values('${co}','DROPX_LOGISTICS');
create table stations(id uuid primary key,company_id uuid,station_code text);insert into stations values('${station}','${co}','TEST');
create table cod_station_settings(company_id uuid,location_id uuid,portal_station_code text);
create table app_pages(id uuid default gen_random_uuid() primary key,company_id uuid,code text,name text,sort_order int,unique(company_id,code));
insert into app_pages(company_id,code,name) values('${co}','cod_master','COD'),('${co}','ops_losses','Losses');
create table user_roles(id uuid primary key,company_id uuid,code text);
insert into user_roles values('${admin}','${co}','TECH'),('${slpm}','${co}','OPERATIONS_SLPM'),('${clm}','${co}','OPERATIONS_CLM');
create table role_page_permissions(company_id uuid,role_id uuid,page_id uuid,can_view boolean,can_add boolean,can_edit boolean,unique(company_id,role_id,page_id));
insert into role_page_permissions select '${co}','${admin}',id,true,true,true from app_pages where code='cod_master';
create function station_audit_employee_directory(p_company uuid,p_station uuid) returns table(ref text,employee_code text,full_name text,designation text,is_active boolean) language sql as $$
 select 'employee:'||n,n::text,'Test person '||n,'Station staff',true from generate_series(1,3)n where p_company='${co}' and p_station='${station}' $$;`);
for (const file of [
  "20260929120000_nl_slp_loss_reports.sql",
  "20260929160000_loss_cases_typed.sql",
  "20261005194905_nl_monthly_recovery.sql",
  "20261005205405_nl_full_recovery_deduction_month.sql",
])
  await db.exec(fs.readFileSync("supabase/migrations/" + file, "utf8"));

// Data that exists before the migration: one historic month, one live month and both SLP stages.
const nl = (key, month, status, extra = {}) => ({
  case_key: key,
  tid: key,
  period: month,
  station_code: "TEST",
  amount: 1000,
  case_status: extra.case_status ?? null,
  extra: { ...(status ? { nl_status: status } : {}), ...extra },
});
const slp = (key, period, month, amount = 900) => ({
  case_key: `${period}|${key}`,
  tid: key,
  period,
  station_code: "TEST",
  amount,
  case_status: "Approved",
  category: "Missing Switcheroo Return",
  impact_date: "2026-08-10",
  extra: { month },
});
const apply = async (report, run, rows) =>
  (
    await db.query("select loss_apply_cases($1,$2,$3) id", [report, run, rows])
  ).rows[0].id;
await apply(
  "nl",
  { source_file: "cloak-historic-download-1.csv", period_label: "2026-8" },
  [nl("H1", "2026-8", "Recoverable")],
);
await apply("nl", { source_file: "bulk-download-1.csv" }, [
  nl("L1", "9", null, { current_sla_stage: "eDSP1", case_status: "not_started" }),
]);
await apply("slp_initial", { source_file: "initial.zip" }, [
  slp("S1", "Aug-Sep", "9 2026"),
  slp("S2", "Aug-Sep", "9.0 2026"),
]);
await apply("slp_final", { source_file: "final.zip" }, [
  slp("S1", "Aug-Sep", "9 2026", 750),
]);

await db.exec(
  fs.readFileSync(
    "supabase/migrations/20261008120000_loss_disputes_slp_recovery.sql",
    "utf8",
  ),
);
const cases = async (where = "true") =>
  (
    await db.query(
      `select * from nl_loss_month_cases where ${where} order by case_key`,
    )
  ).rows;

// Backfill: existing NL rows are tagged by source, SLP cases are archived once.
assert.deepEqual(
  (await cases("report='nl'")).map((c) => [c.case_key, c.data_source]),
  [
    ["H1", "historic"],
    ["L1", "live"],
  ],
);
let slpRows = await cases("report='slp'");
assert.deepEqual(
  slpRows.map((c) => [
    c.case_key,
    c.month,
    Number(c.amount),
    c.source_status,
    c.details.in_initial,
    c.details.in_final,
    c.details.final_published,
  ]),
  [
    ["slp:Aug-Sep|S1", "2026-09", 750, "SLP Final", true, true, true],
    ["slp:Aug-Sep|S2", "2026-09", 900, "SLP Initial", true, false, true],
  ],
);

// A new NL pull must never hide SLP cases that share its month, and keeps tagging the source.
await apply("nl", { source_file: "bulk-download-2.csv" }, [
  nl("L1", "9", null, { current_sla_stage: "eDSP1", case_status: "not_started" }),
  nl("L2", "9", null, { current_sla_stage: "eDSP1", case_status: "not_started" }),
]);
assert.equal((await cases("report='slp' and source_present")).length, 2);
assert.equal((await cases("case_key='L2'"))[0].data_source, "live");
// The month moves to the historic export once Amazon closes it.
await apply(
  "nl",
  { source_file: "cloak-historic-download-2.csv", period_label: "2026-9" },
  [nl("L1", "2026-9", "Recoverable")],
);
assert.deepEqual(
  (await cases("month='2026-09' and report='nl'")).map((c) => [
    c.case_key,
    c.data_source,
    c.source_present,
  ]),
  [
    ["L1", "historic", true],
    ["L2", "live", false],
  ],
);

// A later SLP pull re-archives: a dropped case is hidden, the survivor keeps its identity.
await apply("slp_initial", { source_file: "initial-2.zip" }, [
  slp("S1", "Aug-Sep", "9 2026"),
]);
slpRows = await cases("report='slp'");
assert.deepEqual(
  slpRows.map((c) => [c.case_key, c.source_present]),
  [
    ["slp:Aug-Sep|S1", true],
    ["slp:Aug-Sep|S2", false],
  ],
);

// Recovery plans: SLP cases are accepted without an NL decision; salary rules are unchanged.
await db.query(
  `insert into nl_recovery_payables(company_id,employee_ref,salary_month,eligible,payable,source,policy_updated_at)
 select $1,'employee:'||n,to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '1 month','YYYY-MM'),true,10000,'Test payroll',updated_at from nl_loss_sources,generate_series(1,3)n where company_id=$1`,
  [co],
);
const save = (key, month, outcome, people, version = 0) =>
  db.query("select save_nl_recovery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r", [
    co,
    month,
    key,
    version,
    outcome,
    people.length ? "equal" : "none",
    JSON.stringify(people.map((employee_ref) => ({ employee_ref }))),
    "Verified responsibility",
    actor,
    "Tester",
    "{}",
  ]);
const plan = (await save("slp:Aug-Sep|S1", "2026-09", "recover", ["employee:1", "employee:2"])).rows[0].r;
assert.equal(plan.allocations.length, 2);
assert.equal(Number(plan.source_amount), 750);
assert.ok(plan.deduction_month);
await assert.rejects(
  save("slp:Aug-Sep|S2", "2026-09", "recover", ["employee:1"]),
  /no longer recoverable/,
);
// NL still follows the Master's recoverable decisions.
await assert.rejects(
  save("L2", "2026-09", "recover", ["employee:1"]),
  /no longer recoverable/,
);
assert.equal(
  (await save("L1", "2026-09", "already_recovered", [])).rows[0].r.outcome_code,
  "already_recovered",
);

// Restricted outcome + its permission start with Master editors and the SLP manager only.
const outcome = (
  await db.query(
    "select restricted,allocation_required,deduction_timing from nl_recovery_outcomes where code='already_recovered'",
  )
).rows[0];
assert.deepEqual(outcome, {
  restricted: true,
  allocation_required: false,
  deduction_timing: "none",
});
assert.deepEqual(
  (
    await db.query(
      `select r.code from role_page_permissions p join app_pages a on a.id=p.page_id join user_roles r on r.id=p.role_id
     where a.code='ops_loss_recovered' and p.can_edit order by r.code`,
    )
  ).rows.map((r) => r.code),
  ["OPERATIONS_SLPM", "TECH"],
);

// Dispute requests: versioned, locked once submitted, fully audited.
await apply("nl", { source_file: "bulk-download-3.csv" }, [
  nl("D1", "10", null, { current_sla_stage: "eDSP1", case_status: "not_started" }),
]);
const dispute = (action, values, version, key = "D1") =>
  db.query("select save_nl_dispute_request($1,$2,$3,$4,$5,$6,$7,$8) r", [
    co,
    "2026-10",
    key,
    version,
    action,
    JSON.stringify(values),
    actor,
    "Tester",
  ]);
const good = {
  decision: "dispute",
  reason: "WRTS but MDR",
  remarks: "Same package departed, CCTV attached.",
  cctv_url: "https://drive.example/x",
  attachments: [],
};
await assert.rejects(dispute("submit", { ...good, remarks: "short" }, 0), /Explain the dispute/);
await assert.rejects(dispute("save", { ...good, decision: "maybe" }, 0), /dispute or accept/);
await assert.rejects(dispute("save", { ...good, cctv_url: "http://x" }, 0), /HTTPS/);
await assert.rejects(
  dispute("save", { ...good, attachments: [{ id: id(99) }] }, 0),
  /Attachment is not linked/,
);
let d = (await dispute("save", { ...good, remarks: "" }, 0)).rows[0].r;
assert.equal(d.status, "draft");
await assert.rejects(dispute("save", good, 0), /Another person/);
d = (await dispute("submit", good, d.version)).rows[0].r;
assert.equal(d.status, "submitted");
assert.ok(d.submitted_at);
assert.equal(d.source_stage, "eDSP1");
await assert.rejects(dispute("save", good, d.version), /already sent/);
await assert.rejects(dispute("return", { desk_note: "no" }, d.version), /what to correct/);
d = (await dispute("return", { desk_note: "Add the CCTV timestamp." }, d.version)).rows[0].r;
assert.equal(d.status, "returned");
assert.ok(d.submitted_at);
d = (await dispute("submit", good, d.version)).rows[0].r;
d = (await dispute("withdraw", {}, d.version)).rows[0].r;
assert.equal(d.status, "draft");
assert.equal(d.submitted_at, null);
d = (await dispute("submit", { decision: "accept" }, d.version)).rows[0].r;
assert.equal(d.decision, "accept");
d = (await dispute("file", { desk_note: "" }, d.version)).rows[0].r;
assert.equal(d.status, "filed");
assert.ok(d.filed_at);
await assert.rejects(dispute("file", {}, d.version), /Only a submitted/);
await assert.rejects(dispute("save", good, 0, "slp:Aug-Sep|S1"), /no longer in the Cloak export/);
// Round two: once Amazon hands the case back (eDSP2), the filed request can be answered afresh, once.
await assert.rejects(dispute("save", good, d.version), /already sent/);
await apply("nl", { source_file: "bulk-download-4.csv" }, [
  nl("D1", "10", null, { current_sla_stage: "eDSP2", case_status: "in_progress", dispute_selected: "YES" }),
]);
d = (await dispute("submit", good, d.version)).rows[0].r;
assert.equal(d.status, "submitted");
assert.equal(d.source_stage, "eDSP2");
assert.equal(d.filed_at, null);
await assert.rejects(dispute("save", good, d.version), /already sent/);
assert.equal(
  (await db.query("select count(*)::int n from nl_dispute_request_events")).rows[0].n,
  8,
);

// Window policy (pure): deadlines without a year resolve around "now"; gates follow Cloak's stage.
const now = new Date("2026-10-08T06:00:00Z");
const window = parseLiveWindow(
  [
    { current_sla_stage: "NL1", sla_date: "22 October" },
    { current_sla_stage: "NL2", sla_date: "3 November" },
    { current_sla_stage: "eDSP1", sla_date: "11 October" },
    { current_sla_stage: "eDSP2", sla_date: "24 October" },
    { current_sla_stage: "Completed", sla_date: "Completed" },
  ],
  now,
);
assert.deepEqual(window, {
  eDSP1: "2026-10-11",
  NL1: "2026-10-22",
  eDSP2: "2026-10-24",
  NL2: "2026-11-03",
});
// A January deadline seen in December belongs to next year, and the reverse.
assert.equal(
  parseLiveWindow([{ current_sla_stage: "NL2", sla_date: "3 January" }], new Date("2026-12-20T00:00:00Z")).NL2,
  "2027-01-03",
);
assert.equal(
  parseLiveWindow([{ current_sla_stage: "eDSP1", sla_date: "28 December" }], new Date("2027-01-02T00:00:00Z")).eDSP1,
  "2026-12-28",
);
assert.deepEqual(parseLiveWindow("nonsense", now), {});
const live = (stage, status, extra = {}) => ({
  case_status: status,
  nl_status: extra.nl_status ?? null,
  extra: { current_sla_stage: stage, ...extra },
});
assert.equal(disputeGate(live("eDSP1", "not_started"), window, now).open, true);
// The window stays open through the end of the deadline day in India, then closes.
assert.equal(disputeGate(live("eDSP1", "not_started"), window, new Date("2026-10-11T18:29:00Z")).open, true);
assert.equal(disputeGate(live("eDSP1", "not_started"), window, new Date("2026-10-11T18:31:00Z")).open, false);
assert.equal(disputeGate(live("NL1", "in_progress"), window, now).open, false);
assert.equal(disputeGate(live("eDSP2", "in_progress"), window, now).kind, "respond");
assert.equal(disputeGate(live("Completed", "resolved"), window, now).open, false);
// Unknown deadlines never lock a station out while Cloak still shows the case with the partner.
assert.equal(disputeGate(live("eDSP1", "not_started"), {}, now).open, true);
assert.equal(casePhase(live("eDSP1", "not_started")).key, "action");
assert.equal(casePhase(live("NL1", "in_progress")).key, "amazon");
assert.equal(casePhase(live("eDSP2", "in_progress")).key, "respond");
assert.equal(casePhase(live("Completed", "not_disputed")).key, "accepted");
assert.equal(casePhase({ ...live("Completed", "resolved"), nl_status: "Non-Recoverable" }).key, "won");
assert.equal(casePhase({ ...live("Completed", "resolved"), nl_status: "Recoverable" }).key, "lost");
// A sent request closes itself only when Cloak holds the same decision and the case has left the station.
const sentDispute = { decision: "dispute", status: "submitted" };
assert.equal(filedInCloak(sentDispute, live("NL1", "in_progress", { dispute_selected: "YES" })), true);
assert.equal(filedInCloak(sentDispute, live("eDSP1", "not_started")), false);
assert.equal(filedInCloak(sentDispute, live("Completed", "not_disputed", { dispute_selected: "NO" })), false);
assert.equal(filedInCloak({ decision: "accept", status: "submitted" }, live("Completed", "not_disputed", { dispute_selected: "NO" })), true);
// eDSP2 still shows the first round's YES; the response is not filed yet.
assert.equal(filedInCloak(sentDispute, live("eDSP2", "in_progress", { dispute_selected: "YES" })), false);
assert.equal(filedInCloak({ decision: "dispute", status: "draft" }, live("NL1", "in_progress", { dispute_selected: "YES" })), false);
assert.equal(filedInCloak({ decision: "dispute", status: "filed" }, live("eDSP1", "not_started")), true);
assert.equal(filedInCloak(null, live("NL1", "in_progress")), false);
assert.equal(windowSummary(window, now).stage, "eDSP1");
assert.equal(windowSummary(window, now).daysLeft, 3);
assert.equal(windowSummary(window, new Date("2026-10-23T06:00:00Z")).stage, "eDSP2");
assert.equal(windowSummary(window, new Date("2026-11-05T06:00:00Z")).stage, "Completed");
assert.equal(windowSummary({}, now).stage, null);

// Workbook cells (pure).
assert.deepEqual(parseAllocationCell("d0123 , D0456"), {
  mode: "equal",
  people: [{ code: "D0123" }, { code: "D0456" }],
});
assert.deepEqual(parseAllocationCell("D0123=500; D0456 = 449.50"), {
  mode: "custom",
  people: [
    { code: "D0123", amount: 500 },
    { code: "D0456", amount: 449.5 },
  ],
});
assert.match(parseAllocationCell("D0123=500, D0456").error, /every employee/);
assert.match(parseAllocationCell("D0123, d0123").error, /once/);
assert.match(parseAllocationCell("D0123=abc").error, /amount/);
assert.match(parseAllocationCell("D0123=10.123").error, /amount/);
assert.deepEqual(parseAllocationCell("  "), { mode: "none", people: [] });
const outcomes = [
  { code: "recover", label: "Recover from employees", is_active: true },
  { code: "old", label: "Old action", is_active: false },
];
assert.equal(matchOutcome(" recover from EMPLOYEES ", outcomes)?.code, "recover");
assert.equal(matchOutcome("recover", outcomes)?.code, "recover");
assert.equal(matchOutcome("Old action", outcomes), null);
assert.equal(matchOutcome("nope", outcomes), null);
console.log("loss disputes + SLP recovery: ok");
