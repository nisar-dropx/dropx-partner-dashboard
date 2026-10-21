// Ops loss recovery → payroll deductions: salary-month rule, exactly-once carry-forward and locks.
// Run from the repo root: node scripts/test-loss-recovery-payroll-migration.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
const db = new PGlite();
await db.exec(`create role service_role; create role anon; create role authenticated;
create table companies(id uuid primary key, code text);
create table stations(id uuid primary key, company_id uuid, station_code text);
create table cod_station_settings(location_id uuid, company_id uuid, portal_station_code text);
create table designations(id uuid primary key, company_id uuid, name text);
create table employees(id uuid primary key, company_id uuid, employee_code text, full_name text, designation_id uuid, is_active boolean default true, location_id uuid, deleted_at timestamptz, last_working_date date);
create table workforce(id uuid primary key, company_id uuid, dropx_id text, full_name text, designation text, is_active boolean default true, location_id uuid, deleted_at timestamptz, last_working_date date);
create function station_audit_employee_directory(p_company uuid,p_station uuid)
returns table(ref text,employee_code text,full_name text,designation text,is_active boolean) language sql stable as $$
 select 'employee:'||e.id,e.employee_code,e.full_name,'People',e.is_active from employees e where e.company_id=p_company and e.location_id=p_station
 union all select 'workforce:'||w.id,w.dropx_id,w.full_name,'DA',w.is_active from workforce w where w.company_id=p_company and w.location_id=p_station $$;
create table loss_report_runs(id uuid primary key default gen_random_uuid(), report text, started_at timestamptz default now());
create table nl_loss_sources(account_key text primary key, company_id uuid, recoverable_statuses text[] default array['Recoverable'], allow_equal_split boolean default true, allow_custom_split boolean default true, include_inactive_people boolean default false,
 recovery_policy jsonb not null default '{"salary_cap_enabled":false,"salary_month_offset":1,"salary_cap_percent":100,"reserve_other_recoveries":true,"attachment_max_count":5,"cctv_public_confirmation":true}', updated_at timestamptz default now());
create table nl_loss_month_cases(company_id uuid, report text not null default 'nl', month text, case_key text, station_code text, amount numeric(14,2), source_status text, details jsonb not null default '{}', source_present boolean default true, source_file text, source_run_id uuid, source_updated_at timestamptz default now(), last_seen_at timestamptz default now(), primary key(company_id,month,case_key));
create table nl_recovery_outcomes(company_id uuid, code text, label text, allocation_required boolean, remarks_required boolean default true, is_active boolean default true, sort_order int default 0, deduction_timing text default 'none', dispute_fields_enabled boolean default false, reason_required boolean default false, details_required boolean default false, attachments_enabled boolean default false, cctv_enabled boolean default false, restricted boolean default false, primary key(company_id,code));
create table nl_loss_recoveries(company_id uuid, month text, case_key text, outcome_code text, outcome_label text, split_mode text, allocations jsonb not null default '[]', remarks text default '', source_amount numeric(14,2), source_status text, is_deleted boolean not null default false, version int default 1, updated_by uuid, updated_by_name text, updated_at timestamptz default now(), deduction_timing text not null default 'none', deduction_month text, recovery_details jsonb default '{}', primary key(company_id,month,case_key));
create table nl_loss_recovery_events(id uuid primary key default gen_random_uuid(), company_id uuid, month text, case_key text, before_value jsonb, after_value jsonb, actor_id uuid, actor_name text, created_at timestamptz default now());
create table nl_recovery_payables(company_id uuid, employee_ref text, salary_month text, eligible boolean, payable numeric, source text, checked_at timestamptz default now(), policy_updated_at timestamptz, primary key(company_id,employee_ref,salary_month));
create table nl_recovery_attachments(id uuid primary key, company_id uuid, month text, case_key text);
create function nl_is_recoverable(co uuid,status text) returns boolean language sql stable as $$ select exists(select 1 from nl_loss_sources s,unnest(s.recoverable_statuses) l where s.company_id=co and lower(trim(l))=lower(trim(status))) $$;
create function nl_case_recoverable(co uuid,p_report text,status text) returns boolean language sql stable as $$ select p_report='slp' or nl_is_recoverable(co,status) $$;
create table hr_payroll_runs(id uuid primary key, company_id uuid, period_start date, period_end date, status text);
create table hr_payroll_run_people(id uuid primary key, company_id uuid, run_id uuid, worker_type text, worker_id uuid, unique(company_id,id));
create table hr_payroll_run_items(id uuid primary key default gen_random_uuid(), company_id uuid, run_person_id uuid, code text, name text, item_type text, amount numeric, source text, metadata jsonb not null default '{}');
create table workforce_payout_publications(id uuid primary key default gen_random_uuid(), company_id uuid, workforce_id uuid, station_id uuid, revision int, snapshot jsonb, period_start date, period_end date);
create table bumps(company_id uuid, period_month date, at timestamptz default clock_timestamp());
create function lock_workforce_payment_allocation_company(p uuid) returns void language sql as $$ select $$;
create function workforce_bump_payout_period_dependency_revision(p_company_id uuid,p_period_month date) returns void language sql as $$ insert into public.bumps values(p_company_id,date_trunc('month',p_period_month)::date) $$;
`);
const C = "00000000-0000-0000-0000-000000000001", S = "00000000-0000-0000-0000-0000000000a1";
const E1 = "00000000-0000-0000-0000-0000000000e1", W1 = "00000000-0000-0000-0000-0000000000f1", ACT = "00000000-0000-0000-0000-0000000000aa";
const SLP = "00000000-0000-0000-0000-0000000000bb";
await db.exec(`insert into companies values('${C}','X'); insert into stations values('${S}','${C}','BLR1');
 insert into employees(id,company_id,employee_code,full_name,location_id) values('${E1}','${C}','D0001','IC One','${S}');
 insert into workforce(id,company_id,dropx_id,full_name,location_id) values('${W1}','${C}','W0001','DA One','${S}');
 insert into nl_loss_sources(account_key,company_id) values('default','${C}');
 insert into nl_recovery_outcomes(company_id,code,label,allocation_required,deduction_timing) values('${C}','deduct','Deduct',true,'current_month'),('${C}','deduct_next_month','Deduct next month',true,'next_month'),('${C}','post_dispute','Re-dispute',false,'none');
 insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values
  ('${C}','nl','2026-09','N1','BLR1',1000,'Recoverable'),('${C}','nl','2026-09','N2','BLR1',500,'Recoverable'),
  ('${C}','slp','2026-09','slp:S1','BLR1',300,'SLP Initial');`);
// Applied twice: the migration must be safe to re-run.
for (const file of [
  "20261015130000_loss_recovery_payroll_deductions.sql",
  "20261016161000_loss_recovery_installments.sql",
  "20261022120000_nl_slp_loss_lifecycle.sql",
]) {
  const migration = readFileSync(`supabase/migrations/${file}`, "utf8");
  await db.exec(migration);
  await db.exec(migration);
}
let fails = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const one = async (sql) => (await db.query(sql)).rows[0];
const throws = async (name, sql, re) => { try { await db.query(sql); fails++; console.log("FAIL", name, "did not raise"); } catch (e) { const ok = re.test(e.message); if (!ok) fails++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : e.message); } };
const m = async (report, cm, at, fin, t) => (await one(`select nl_recovery_deduction_month('${report}','${cm}','${at}'::timestamptz,${fin ? `'${fin}'::timestamptz` : "null"},'${t}') v`)).v;
const approve = async (cs) => {
  const row = await one(`select r.version, c.lifecycle_version lv from nl_loss_recoveries r join nl_loss_month_cases c using(company_id,month,case_key) where r.case_key='${cs}'`);
  if (row && (await one(`select approval_status s from nl_loss_recoveries where case_key='${cs}'`)).s === "proposed") {
    await db.query(`select nl_loss_recovery_approve('${C}','2026-09','${cs}',${row.version},'${SLP}','SLP Mgr',null,${row.lv})`);
  }
};
// Salary month rule
eq("NL Sep assigned 4 Nov → Oct", await m("nl", "2026-09", "2026-11-04T10:00:00+05:30", null, "current_month"), "2026-10");
eq("NL Sep assigned 6 Nov 23:59 IST → Oct", await m("nl", "2026-09", "2026-11-06T23:59:00+05:30", null, "current_month"), "2026-10");
eq("NL Sep assigned 7 Nov → Nov", await m("nl", "2026-09", "2026-11-07T00:01:00+05:30", null, "current_month"), "2026-11");
eq("NL Sep assigned 3 Oct floors to Oct", await m("nl", "2026-09", "2026-10-03T10:00:00+05:30", null, "current_month"), "2026-10");
eq("NL Sep assigned 20 Oct → Oct", await m("nl", "2026-09", "2026-10-20T10:00:00+05:30", null, "current_month"), "2026-10");
eq("NL next month 4 Nov → Nov", await m("nl", "2026-09", "2026-11-04T10:00:00+05:30", null, "next_month"), "2026-11");
eq("SLP final 3 Oct → Sep (previous month)", await m("slp", "2026-09", "2026-09-25T10:00:00+05:30", "2026-10-03T10:00:00+05:30", "current_month"), "2026-09");
eq("SLP final 10 Oct → Oct", await m("slp", "2026-09", "2026-09-25T10:00:00+05:30", "2026-10-10T10:00:00+05:30", "current_month"), "2026-10");
eq("SLP assigned after final uses assign day", await m("slp", "2026-09", "2026-11-08T10:00:00+05:30", "2026-10-03T10:00:00+05:30", "current_month"), "2026-11");
eq("Jan cutoff wraps year", await m("slp", "2026-12", "2027-01-05T10:00:00+05:30", null, "current_month"), "2026-12");
eq("UTC 6 Nov 20:00 = IST 7 Nov 01:30 → Nov", await m("nl", "2026-09", "2026-11-06T20:00:00Z", null, "current_month"), "2026-11");
// Save: equal split between employee and DA
const save = (cs, ver, outcome, alloc, mode = "custom") => `select save_nl_recovery('${C}','2026-09','${cs}',${ver},'${outcome}','${mode}','${JSON.stringify(alloc)}','Recover loss','${ACT}','Ops')`;
await db.exec(`insert into nl_recovery_payables(company_id,employee_ref,salary_month,eligible,payable,source,policy_updated_at) select '${C}',r,to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '1 month','YYYY-MM'),true,50000,'x',(select updated_at from nl_loss_sources) from unnest(array['employee:${E1}','workforce:${W1}']) r`);
await db.query(save("N1", 0, "deduct", [{ employee_ref: `employee:${E1}`, amount: "600" }, { employee_ref: `workforce:${W1}`, amount: "400" }]));
const r1 = await one(`select deduction_month,assigned_at is not null a from nl_loss_recoveries where case_key='N1'`);
const today = new Date().toISOString();
eq("Save stamps the assignment and its salary month", r1, { deduction_month: await m("nl", "2026-09", today, null, "current_month"), a: true });
eq("Proposal is not payroll-due before SLP approval", (await db.query(`select * from nl_loss_recovery_due('${C}','2026-10','hrms')`)).rows.length, 0);
await approve("N1");
// Pin the plan to 15 Oct so the rest of the run does not depend on today's date.
const pin = (cs) => db.exec(`update nl_loss_recoveries set assigned_at='2026-10-15T10:00:00+05:30', deduction_month=nl_recovery_deduction_month(case when '${cs}' like 'slp:%' then 'slp' else 'nl' end,'2026-09','2026-10-15T10:00:00+05:30',(select final_seen_at from nl_loss_month_cases where case_key='${cs}'),deduction_timing) where case_key='${cs}'`);
await pin("N1");
eq("Saving a DA plan bumps payout months", Number((await one(`select count(*) n from bumps`)).n) > 0, true);
const dueH = async (month, run = null) => (await db.query(`select recovery_key,amount::text,label from nl_loss_recovery_due('${C}','${month}','hrms',${run ? `'${run}'` : "null"})`)).rows;
const dueW = async (month) => (await db.query(`select recovery_key,amount::text from nl_loss_recovery_due('${C}','${month}','workforce')`)).rows;
eq("HRMS Sep payroll: nothing (before go-live)", await dueH("2026-09"), []);
eq("HRMS Oct payroll: employee line only", (await dueH("2026-10")).map((r) => [r.recovery_key, r.amount]), [[`2026-09|N1|employee:${E1}`, "600.00"]]);
eq("Label", (await dueH("2026-10"))[0].label, "NL loss · Sep 2026 · N1");
eq("Workforce Oct payout: DA line only", (await dueW("2026-10")).map((r) => r.amount), ["400.00"]);
// Applied in Oct run → not due in Nov; due again for the same run's recalculation
const R10 = "00000000-0000-0000-0000-000000000010", P10 = "00000000-0000-0000-0000-000000000011";
await db.exec(`insert into hr_payroll_runs values('${R10}','${C}','2026-10-01','2026-10-31','calculated'); insert into hr_payroll_run_people values('${P10}','${C}','${R10}','employee','${E1}');
 insert into hr_payroll_run_items(company_id,run_person_id,code,name,item_type,amount,source,metadata) values('${C}','${P10}','OPS_LOSS_RECOVERY','Loss','deduction',600,'ops_loss_recovery','{"recovery_key":"2026-09|N1|employee:${E1}","month":"2026-09","case_key":"N1"}')`);
eq("Carried by Oct run → not due in Nov", await dueH("2026-11"), []);
eq("Still due when recalculating the Oct run itself", (await dueH("2026-10", R10)).length, 1);
// Draft/calculated runs don't lock; reviewed does
let n1Ver = Number((await one(`select version from nl_loss_recoveries where case_key='N1'`)).version);
await db.query(save("N1", n1Ver, "deduct", [{ employee_ref: `employee:${E1}`, amount: "500" }, { employee_ref: `workforce:${W1}`, amount: "500" }]));
await approve("N1");
await pin("N1");
n1Ver = Number((await one(`select version from nl_loss_recoveries where case_key='N1'`)).version);
eq("Calculated (unreviewed) run allows a change", n1Ver >= 2, true);
await db.exec(`update hr_payroll_run_items set amount=500, metadata=metadata; update hr_payroll_runs set status='approved'`);
await throws("Approved run locks the employee amount", save("N1", n1Ver, "deduct", [{ employee_ref: `employee:${E1}`, amount: "700" }, { employee_ref: `workforce:${W1}`, amount: "300" }]), /already deducted in October 2026 payroll for D0001/);
await throws("Approved run blocks switching to a non-deduct outcome", `select save_nl_recovery('${C}','2026-09','N1',${n1Ver},'post_dispute','none','[]','Re-dispute','${ACT}','Ops','{}')`, /already deducted/);
await throws("Approved run blocks clearing", `select clear_nl_recovery('${C}','2026-09','N1',${n1Ver},'${ACT}','Ops')`, /already deducted in October 2026 payroll/);
await db.query(save("N1", n1Ver, "deduct", [{ employee_ref: `employee:${E1}`, amount: "500" }, { employee_ref: `workforce:${W1}`, amount: "500" }]).replace("Recover loss", "Recover loss, remark edit"));
eq("Remark-only edit allowed and keeps month", (await one(`select deduction_month from nl_loss_recoveries where case_key='N1'`)).deduction_month, "2026-10");
// DA line published in Oct → not due in Nov; locks DA amount
await db.exec(`insert into workforce_payout_publications(company_id,workforce_id,station_id,revision,snapshot,period_start,period_end) values('${C}','${W1}','${S}',1,'{"worksheet":{"deduction_breakdown":[{"code":"LOSS_RECOVERY","label":"x","amount":500,"recoveryKey":"2026-09|N1|workforce:${W1}"}]}}','2026-10-01','2026-10-31')`);
eq("Published in Oct → DA not due in Nov", await dueW("2026-11"), []);
eq("Oct worksheet still shows its own line", (await dueW("2026-10")).length, 1);
// Revision 2 of the Oct publication dropped the line → due again in Nov (carry forward)
await db.exec(`insert into workforce_payout_publications(company_id,workforce_id,station_id,revision,snapshot,period_start,period_end) values('${C}','${W1}','${S}',2,'{"worksheet":{"deduction_breakdown":[]}}','2026-10-01','2026-10-31')`);
eq("Latest publication without the line → carries to Nov", (await dueW("2026-11")).length, 1);
// NL status flips non-recoverable → not due; source amount change → waits for review
await db.query(save("N2", 0, "deduct", [{ employee_ref: `employee:${E1}`, amount: "500" }]));
await approve("N2");
await pin("N2");
await db.exec(`update nl_loss_month_cases set source_status='Not Recoverable' where case_key='N2'`);
eq("Non-recoverable NL case is not deducted", (await dueH("2026-11")).filter((r) => r.recovery_key.includes("N2")), []);
await db.exec(`update nl_loss_month_cases set source_status='Recoverable', amount=450 where case_key='N2'`);
eq("Changed amount waits for review", (await dueH("2026-11")).filter((r) => r.recovery_key.includes("N2")), []);
await db.exec(`alter table nl_loss_month_cases disable trigger nl_loss_case_lifecycle_defaults; update nl_loss_month_cases set amount=500, lifecycle_status='recovery_approved_scheduled' where case_key='N2'; alter table nl_loss_month_cases enable trigger nl_loss_case_lifecycle_defaults`);
await db.exec(`update nl_loss_recoveries set approval_status='approved', source_amount=500 where case_key='N2'`);
eq("Restored → due (carry forward from Oct to Nov)", (await dueH("2026-11")).filter((r) => r.recovery_key.includes("N2")).length, 1);
// SLP: not due until Final; Final arrival reschedules
const saveS1 = `select save_nl_recovery('${C}','2026-09','slp:S1',0,'deduct','custom','${JSON.stringify([{ employee_ref: `workforce:${W1}`, amount: "300" }])}','Recover SLP','${ACT}','Ops')`;
await throws("SLP Initial cannot be assigned", saveS1, /still in SLP Initial/);
// A plan saved on Initial before this release waits for Final.
await db.exec(`insert into nl_loss_recoveries(company_id,month,case_key,outcome_code,outcome_label,split_mode,allocations,source_amount,source_status,updated_by,updated_by_name,deduction_timing,deduction_month,assigned_at,approval_status)
 values('${C}','2026-09','slp:S1','deduct','Deduct','custom','[{"ref":"workforce:${W1}","employee_code":"W0001","amount":300}]',300,'SLP Initial','${ACT}','Ops','current_month','2026-09',now(),'approved')`);
await pin("slp:S1");
eq("SLP Initial plan not due", (await dueW("2026-12")).filter((r) => r.recovery_key.includes("S1")), []);
await db.exec(`delete from bumps; update nl_loss_month_cases set source_status='SLP Final', details='{"in_final":true}' where case_key='slp:S1'`);
eq("SLP Final can be assigned", await (async () => { try { await db.query(saveS1.replace(",0,'deduct'", ",1,'deduct'")); return true; } catch (e) { return e.message; } })(), true);
await approve("slp:S1");
const s1 = await one(`select c.final_seen_at is not null f, r.deduction_month from nl_loss_month_cases c join nl_loss_recoveries r using(company_id,month,case_key) where case_key='slp:S1'`);
eq("SLP Final arrival stamps and reschedules to the day it arrived", s1, { f: true, deduction_month: await m("slp", "2026-09", "2026-10-15T10:00:00+05:30", today, "current_month") });
await db.exec(`alter table nl_loss_month_cases disable trigger nl_case_final_seen; alter table nl_loss_month_cases disable trigger nl_loss_case_lifecycle_defaults; update nl_loss_month_cases set final_seen_at='2026-10-15T10:00:00+05:30', lifecycle_status='recovery_approved_scheduled' where case_key='slp:S1'; alter table nl_loss_month_cases enable trigger nl_case_final_seen; alter table nl_loss_month_cases enable trigger nl_loss_case_lifecycle_defaults`);
await pin("slp:S1");
eq("SLP Final with same amount is due without re-saving", (await dueW("2026-10")).filter((r) => r.recovery_key.includes("S1")).length, 1);
eq("Source change bumps payout months", Number((await one(`select count(*) n from bumps`)).n) > 0, true);
await db.exec(`update nl_loss_month_cases set details='{"in_final":true,"x":1}' where case_key='slp:S1'`);
eq("final_seen_at never moves", (await one(`select final_seen_at=(select final_seen_at from nl_loss_month_cases where case_key='slp:S1') same from nl_loss_month_cases where case_key='slp:S1'`)).same, true);
eq("Unknown target returns nothing", (await db.query(`select * from nl_loss_recovery_due('${C}','2026-11','other')`)).rows, []);
eq("Bad month returns nothing", (await db.query(`select * from nl_loss_recovery_due('${C}','2026-13','hrms')`)).rows, []);
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
