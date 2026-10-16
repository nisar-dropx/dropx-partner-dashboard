// Ops loss recovery instalments: schedules, one instalment per payroll, salary cap, exit settlement, ledger, write-off.
// Run from the repo root: node scripts/test-loss-recovery-installments-migration.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
const db = new PGlite();
await db.exec(`create role service_role; create role anon; create role authenticated;
create table companies(id uuid primary key, code text);
create table stations(id uuid primary key, company_id uuid, station_code text);
create table cod_station_settings(location_id uuid, company_id uuid, portal_station_code text);
create table employees(id uuid primary key, company_id uuid, employee_code text, full_name text, is_active boolean default true, location_id uuid, last_working_date date);
create table workforce(id uuid primary key, company_id uuid, dropx_id text, full_name text, is_active boolean default true, location_id uuid, last_working_date date);
create function station_audit_employee_directory(p_company uuid,p_station uuid)
returns table(ref text,employee_code text,full_name text,designation text,is_active boolean) language sql stable as $$
 select 'employee:'||e.id,e.employee_code,e.full_name,'People',e.is_active from employees e where e.company_id=p_company and e.location_id=p_station
 union all select 'workforce:'||w.id,w.dropx_id,w.full_name,'DA',w.is_active from workforce w where w.company_id=p_company and w.location_id=p_station $$;
create table loss_report_runs(id uuid primary key default gen_random_uuid(), report text, started_at timestamptz default now());
create table nl_loss_sources(account_key text primary key, company_id uuid, recoverable_statuses text[] default array['Recoverable'], allow_equal_split boolean default true, allow_custom_split boolean default true, include_inactive_people boolean default false,
 recovery_policy jsonb not null default '{"salary_cap_enabled":true,"salary_month_offset":1,"salary_cap_percent":100,"reserve_other_recoveries":true,"attachment_max_count":5,"cctv_public_confirmation":true}', updated_at timestamptz default now());
create table nl_loss_month_cases(company_id uuid, report text not null default 'nl', month text, case_key text, station_code text, amount numeric(14,2), source_status text, details jsonb not null default '{}', source_present boolean default true, source_file text, source_run_id uuid, source_updated_at timestamptz default now(), last_seen_at timestamptz default now(), primary key(company_id,month,case_key));
create table nl_recovery_outcomes(company_id uuid, code text, label text, allocation_required boolean, remarks_required boolean default true, is_active boolean default true, sort_order int default 0, deduction_timing text default 'none', dispute_fields_enabled boolean default false, reason_required boolean default false, details_required boolean default false, attachments_enabled boolean default false, cctv_enabled boolean default false, restricted boolean default false, primary key(company_id,code));
create table nl_loss_recoveries(company_id uuid, month text, case_key text, outcome_code text, outcome_label text, split_mode text, allocations jsonb not null default '[]', remarks text default '', source_amount numeric(14,2), source_status text, is_deleted boolean not null default false, version int default 1, updated_by uuid, updated_by_name text, updated_at timestamptz default now(), deduction_timing text not null default 'none', deduction_month text, recovery_details jsonb default '{}', primary key(company_id,month,case_key));
create table nl_loss_recovery_events(id uuid primary key default gen_random_uuid(), company_id uuid, month text, case_key text, before_value jsonb, after_value jsonb not null, actor_id uuid, actor_name text, created_at timestamptz default now());
create table nl_recovery_payables(company_id uuid, employee_ref text, salary_month text, eligible boolean, payable numeric, source text, checked_at timestamptz default now(), policy_updated_at timestamptz, primary key(company_id,employee_ref,salary_month));
create table nl_recovery_attachments(id uuid primary key, company_id uuid, month text, case_key text);
create function nl_is_recoverable(co uuid,status text) returns boolean language sql stable as $$ select exists(select 1 from nl_loss_sources s,unnest(s.recoverable_statuses) l where s.company_id=co and lower(trim(l))=lower(trim(status))) $$;
create function nl_case_recoverable(co uuid,p_report text,status text) returns boolean language sql stable as $$ select p_report='slp' or nl_is_recoverable(co,status) $$;
create table hr_payroll_runs(id uuid primary key, company_id uuid, period_start date, period_end date, status text);
create table hr_payroll_run_people(id uuid primary key, company_id uuid, run_id uuid, worker_type text, worker_id uuid, unique(company_id,id));
create table hr_payroll_run_items(id uuid primary key default gen_random_uuid(), company_id uuid, run_person_id uuid, code text, name text, item_type text, amount numeric, source text, metadata jsonb not null default '{}');
create table workforce_payout_publications(id uuid primary key default gen_random_uuid(), company_id uuid, workforce_id uuid, station_id uuid, revision int, snapshot jsonb, period_start date, period_end date);
create table bumps(company_id uuid, period_month date, at timestamptz default clock_timestamp());
create function workforce_bump_payout_period_dependency_revision(p_company_id uuid,p_period_month date) returns void language sql as $$ insert into public.bumps values(p_company_id,date_trunc('month',p_period_month)::date) $$;
`);
const C = "00000000-0000-0000-0000-000000000001", S = "00000000-0000-0000-0000-0000000000a1";
const E1 = "00000000-0000-0000-0000-0000000000e1", E2 = "00000000-0000-0000-0000-0000000000e2", W1 = "00000000-0000-0000-0000-0000000000f1", ACT = "00000000-0000-0000-0000-0000000000aa";
await db.exec(`insert into companies values('${C}','X'); insert into stations values('${S}','${C}','BLR1');
 insert into employees(id,company_id,employee_code,full_name,location_id) values('${E1}','${C}','D0001','IC One','${S}'),('${E2}','${C}','D0002','IC Two','${S}');
 insert into workforce(id,company_id,dropx_id,full_name,location_id) values('${W1}','${C}','W0001','DA One','${S}');
 insert into nl_loss_sources(account_key,company_id) values('default','${C}');
 insert into nl_recovery_outcomes(company_id,code,label,allocation_required,deduction_timing) values('${C}','deduct','Deduct',true,'current_month'),('${C}','post_dispute','Re-dispute',false,'none');
 insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status) values
  ('${C}','nl','2026-09','I1','BLR1',1000,'Recoverable'),('${C}','nl','2026-09','I2','BLR1',1000,'Recoverable'),('${C}','nl','2026-09','F1','BLR1',200,'Recoverable'),
  ('${C}','nl','2026-09','CAP','BLR1',1200,'Recoverable'),('${C}','nl','2026-09','W1','BLR1',900,'Recoverable');`);
// Each migration applied twice: both must be safe to re-run.
for (const file of ["20261015130000_loss_recovery_payroll_deductions.sql", "20261016161000_loss_recovery_installments.sql", "20261016181000_station_loss_claims.sql"]) {
  const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
  await db.exec(sql); await db.exec(sql);
}
let fails = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const one = async (sql) => (await db.query(sql)).rows[0];
const throws = async (name, sql, re) => { try { await db.query(sql); fails++; console.log("FAIL", name, "did not raise"); } catch (e) { const ok = re.test(e.message); if (!ok) fails++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : e.message); } };

eq("Default cap moves to 50% with 24 instalments", (await one(`select recovery_policy->>'salary_cap_percent' p, recovery_policy->>'max_installments' k from nl_loss_sources`)), { p: "50", k: "24" });
const payables = async (payable = 50000, gross = null) => db.exec(`delete from nl_recovery_payables; insert into nl_recovery_payables(company_id,employee_ref,salary_month,eligible,payable,gross,source,policy_updated_at) select '${C}',r,to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '1 month','YYYY-MM'),true,${payable},${gross ?? "null"},'x',(select updated_at from nl_loss_sources) from unnest(array['employee:${E1}','employee:${E2}','workforce:${W1}']) r`);
await payables();
const save = (cs, ver, alloc, plan = {}, remarks = "Recover loss") =>
  `select save_nl_recovery('${C}','2026-09','${cs}',${ver},'deduct','custom','${JSON.stringify(alloc)}','${remarks}','${ACT}','Ops','{}','${JSON.stringify(plan)}')`;
const pin = (cs) => db.exec(`update nl_loss_recoveries set assigned_at='2026-10-15T10:00:00+05:30', deduction_month='2026-10' where case_key='${cs}'`);
const due = async (target, month, run = null) => (await db.query(`select recovery_key,amount::text,installment_no,installment_count,cap_exempt,cap_percent::text,final_settlement,label from nl_loss_recovery_due('${C}','${month}','${target}',${run ? `'${run}'` : "null"})`)).rows;
const keys = (rows, cs) => rows.filter((r) => r.recovery_key.includes(`|${cs}|`)).map((r) => [r.recovery_key.split("|").slice(3).join("|") || "full", r.amount]);

// --- Validation
const E1A = (amount) => [{ employee_ref: `employee:${E1}`, amount: String(amount) }];
await throws("Months must be at least 2", save("I1", 0, E1A(1000), { mode: "installments", basis: "months", value: "1" }), /between 2 and 24/);
await throws("Months at most 24", save("I1", 0, E1A(1000), { mode: "installments", basis: "months", value: "25" }), /between 2 and 24/);
await throws("Fractional months rejected", save("I1", 0, E1A(1000), { mode: "installments", basis: "months", value: "2.5" }), /between 2 and 24/);
await throws("Missing basis rejected", save("I1", 0, E1A(1000), { mode: "installments", value: "3" }), /number of months or by amount/);
await throws("Unknown mode rejected", save("I1", 0, E1A(1000), { mode: "weekly" }), /Full debit or Recurring debit/);
await throws("Monthly amount covering the share → use full debit", save("I1", 0, E1A(1000), { mode: "installments", basis: "amount", value: "1000" }), /Use Full debit/);
await throws("Monthly amount needing too many instalments", save("I1", 0, E1A(1000), { mode: "installments", basis: "amount", value: "10" }), /needs 100 instalments; the maximum is 24/);
await throws("Override without reason rejected", save("I1", 0, E1A(1000), { mode: "full", cap_override: true }), /reason for recovering beyond the salary cap/);

// --- Months basis: 1000 over 3 → 333.34 / 333.33 / 333.33
await db.query(save("I1", 0, E1A(1000), { mode: "installments", basis: "months", value: "3" }));
await pin("I1");
const i1 = await one(`select recovery_mode,installment_basis,installment_value::text v,allocations->0->'installments' s,allocations->0->>'monthly_amount' m from nl_loss_recoveries where case_key='I1'`);
eq("Months schedule splits paise onto the first instalments", i1.s.map((x) => [x.n, x.amount]), [[1, 333.34], [2, 333.33], [3, 333.33]]);
eq("Plan stores mode, basis and monthly amount", [i1.recovery_mode, i1.installment_basis, i1.v, i1.m], ["installments", "months", "3.00", "333.34"]);
eq("Oct payroll: only instalment 1 is due", keys(await due("hrms", "2026-10"), "I1"), [["1", "333.34"]]);
eq("Instalment label", (await due("hrms", "2026-10")).find((r) => r.recovery_key.endsWith("I1|employee:" + E1 + "|1")).label, "NL loss · Sep 2026 · I1 · instalment 1 of 3");
eq("Instalment carries cap, not exempt", (await due("hrms", "2026-10")).filter((r) => r.recovery_key.includes("|I1|")).map((r) => [r.cap_exempt, r.cap_percent, r.installment_count]), [[false, "50", 3]]);

// Oct run carries instalment 1
const R10 = "00000000-0000-0000-0000-000000000010", P10 = "00000000-0000-0000-0000-000000000011";
const R11 = "00000000-0000-0000-0000-000000000020", P11 = "00000000-0000-0000-0000-000000000021";
const R12 = "00000000-0000-0000-0000-000000000030", P12 = "00000000-0000-0000-0000-000000000031";
const carry = (person, key, amount) => db.exec(`insert into hr_payroll_run_items(company_id,run_person_id,code,name,item_type,amount,source,metadata) values('${C}','${person}','OPS_LOSS_RECOVERY','Loss','deduction',${amount},'ops_loss_recovery','{"recovery_key":"${key}"}')`);
await db.exec(`insert into hr_payroll_runs values('${R10}','${C}','2026-10-01','2026-10-31','calculated'); insert into hr_payroll_run_people values('${P10}','${C}','${R10}','employee','${E1}')`);
const k1 = `2026-09|I1|employee:${E1}`;
await carry(P10, `${k1}|1`, 333.34);
eq("Recalculating Oct keeps instalment 1 only", keys(await due("hrms", "2026-10", R10), "I1"), [["1", "333.34"]]);
eq("Nov payroll: instalment 2 only", keys(await due("hrms", "2026-11"), "I1"), [["2", "333.33"]]);
eq("Nov run never takes two instalments", keys(await due("hrms", "2026-11"), "I1").length, 1);
// Nov payroll skipped the line (e.g. no take-home) → Dec takes instalment 2, not 3: the schedule shifts
eq("Missed Nov → Dec takes instalment 2", keys(await due("hrms", "2026-12"), "I1"), [["2", "333.33"]]);
await db.exec(`insert into hr_payroll_runs values('${R11}','${C}','2026-11-01','2026-11-30','calculated'); insert into hr_payroll_run_people values('${P11}','${C}','${R11}','employee','${E1}')`);
await carry(P11, `${k1}|2`, 333.33);
eq("After Nov carries 2 → Dec takes 3", keys(await due("hrms", "2026-12"), "I1"), [["3", "333.33"]]);
eq("Recalculating Nov keeps instalment 2 and not 3", keys(await due("hrms", "2026-11", R11), "I1"), [["2", "333.33"]]);

// --- Ledger (finalized runs only count as deducted)
const led = async (cs) => (await db.query(`select total::text,deducted::text,in_payroll::text,outstanding::text,deducted_count,installment_count,status from nl_recovery_ledger('${C}') where case_key='${cs}'`)).rows;
eq("Ledger: calculated runs are in payroll, not deducted", await led("I1"), [{ total: "1000.00", deducted: "0", in_payroll: "666.67", outstanding: "1000.00", deducted_count: 0, installment_count: 3, status: "in_progress" }]);
await db.exec(`update hr_payroll_runs set status='approved' where id in ('${R10}','${R11}')`);
eq("Ledger: approved runs are deducted", await led("I1"), [{ total: "1000.00", deducted: "666.67", in_payroll: "0", outstanding: "333.33", deducted_count: 2, installment_count: 3, status: "in_progress" }]);

// --- Locks: a deducted schedule cannot be changed, a remark can
await throws("Deducted schedule cannot be re-planned", save("I1", 1, E1A(1000), { mode: "installments", basis: "months", value: "4" }), /already deducted in October 2026 payroll for D0001/);
await throws("Deducted plan cannot switch to full debit", save("I1", 1, E1A(1000), { mode: "full" }), /already deducted/);
await throws("Deducted plan cannot be cleared", `select clear_nl_recovery('${C}','2026-09','I1',1,'${ACT}','Ops')`, /already deducted/);
await db.query(save("I1", 1, E1A(1000), { mode: "installments", basis: "months", value: "3" }, "Remark edit only"));
eq("Remark edit keeps salary month and schedule", (await one(`select version,deduction_month,jsonb_array_length(allocations->0->'installments') n from nl_loss_recoveries where case_key='I1'`)), { version: 2, deduction_month: "2026-10", n: 3 });

// --- Amount basis and workforce payouts: 900 at 400/month → 400 / 400 / 100
await db.query(save("W1", 0, [{ employee_ref: `workforce:${W1}`, amount: "900" }], { mode: "installments", basis: "amount", value: "400" }));
await pin("W1");
eq("Amount schedule ends with the remainder", (await one(`select allocations->0->'installments' s from nl_loss_recoveries where case_key='W1'`)).s.map((x) => x.amount), [400, 400, 100]);
eq("Workforce Oct payout: instalment 1", keys(await due("workforce", "2026-10"), "W1"), [["1", "400.00"]]);
const kW = `2026-09|W1|workforce:${W1}`;
await db.exec(`insert into workforce_payout_publications(company_id,workforce_id,station_id,revision,snapshot,period_start,period_end) values('${C}','${W1}','${S}',1,'{"worksheet":{"deduction_breakdown":[{"code":"LOSS_RECOVERY","amount":400,"recoveryKey":"${kW}|1"}]}}','2026-10-01','2026-10-31')`);
eq("Oct worksheet keeps its own instalment", keys(await due("workforce", "2026-10"), "W1"), [["1", "400.00"]]);
eq("Published Oct → Nov payout takes instalment 2", keys(await due("workforce", "2026-11"), "W1"), [["2", "400.00"]]);
await db.exec(`insert into workforce_payout_publications(company_id,workforce_id,station_id,revision,snapshot,period_start,period_end) values('${C}','${W1}','${S}',2,'{"worksheet":{"deduction_breakdown":[]}}','2026-10-01','2026-10-31')`);
eq("Oct republished without it → Nov takes instalment 1 again", keys(await due("workforce", "2026-11"), "W1"), [["1", "400.00"]]);

// --- Full debit keeps its original key
await db.query(save("F1", 0, [{ employee_ref: `employee:${E2}`, amount: "200" }]));
await pin("F1");
eq("Full debit key unchanged", (await due("hrms", "2026-10")).filter((r) => r.recovery_key.includes("|F1|")).map((r) => [r.recovery_key, r.installment_no, r.cap_exempt]), [[`2026-09|F1|employee:${E2}`, null, false]]);
eq("Full debit plan defaults", (await one(`select recovery_mode,installment_basis,cap_override from nl_loss_recoveries where case_key='F1'`)), { recovery_mode: "full", installment_basis: null, cap_override: false });

// --- Salary cap on the monthly amount (payable 1000 → 50% = 500), override, and gross
await payables(1000, 2000);
const E2A = (amount) => [{ employee_ref: `employee:${E2}`, amount: String(amount) }];
await throws("Full debit above 50% of take-home is refused", save("CAP", 0, E2A(1200)), /monthly recovery of ₹1200.00 for D0002 is more than the 50% salary limit of ₹300\.00.*record a cap override/);
await db.query(save("CAP", 0, E2A(1200), { mode: "installments", basis: "months", value: "4" }));
eq("Same loss spread over 4 months fits the cap", (await one(`select allocations->0->>'monthly_amount' m from nl_loss_recoveries where case_key='CAP'`)).m, "300.00");
await throws("Override still cannot pass take-home", save("CAP", 1, E2A(1200), { mode: "full", cap_override: true, cap_override_reason: "Approved by finance head" }), /more than the take-home salary limit of ₹800\.00/);
await db.query(save("CAP", 1, E2A(1200), { mode: "installments", basis: "months", value: "2", cap_override: true, cap_override_reason: "Approved by finance head" }));
eq("Override with reason saves and is recorded", (await one(`select cap_override,cap_override_reason r,allocations->0->>'salary_gross' g from nl_loss_recoveries where case_key='CAP'`)), { cap_override: true, r: "Approved by finance head", g: "2000.00" });
await db.exec(`update nl_loss_recoveries set deduction_month='2026-10' where case_key='CAP'`);
eq("Override lines are cap-exempt in payroll", (await due("hrms", "2026-10")).filter((r) => r.recovery_key.includes("|CAP|")).map((r) => r.cap_exempt), [true]);
await payables(5000, 500);
await throws("Monthly recovery above gross pay is refused", save("CAP", 2, E2A(1200), { mode: "installments", basis: "months", value: "2", cap_override: true, cap_override_reason: "Approved by finance head" }), /more than their gross pay of ₹500/);
await payables();

// --- Exit: every remaining instalment in the final settlement, uncapped
await db.query(save("I2", 0, [{ employee_ref: `employee:${E2}`, amount: "1000" }], { mode: "installments", basis: "months", value: "4" }));
await pin("I2");
eq("Before exit: one instalment", keys(await due("hrms", "2026-10"), "I2"), [["1", "250.00"]]);
await db.exec(`update employees set last_working_date='2026-10-20' where id='${E2}'`);
const fin = (await due("hrms", "2026-10")).filter((r) => r.recovery_key.includes("|I2|"));
eq("Exit in Oct: all 4 instalments due in final settlement", fin.map((r) => [r.installment_no, r.final_settlement, r.cap_exempt]), [[1, true, true], [2, true, true], [3, true, true], [4, true, true]]);
eq("Final settlement label", fin[0].label, "NL loss · Sep 2026 · I2 · instalment 1 of 4 · final settlement");
eq("Exit after the salary month is not accelerated", keys(await due("hrms", "2026-09"), "I2"), []);
await db.exec(`update employees set last_working_date='2026-11-05' where id='${E2}'`);
eq("Exit next month: Oct still one instalment", keys(await due("hrms", "2026-10"), "I2"), [["1", "250.00"]]);
await db.exec(`update employees set last_working_date='2026-10-20' where id='${E2}'`);
// Final settlement carried only 1 and 2 (take-home ran out)
await db.exec(`insert into hr_payroll_runs values('${R12}','${C}','2026-10-01','2026-10-31','approved'); insert into hr_payroll_run_people values('${P12}','${C}','${R12}','employee','${E2}')`);
const k2 = `2026-09|I2|employee:${E2}`;
await carry(P12, `${k2}|1`, 250); await carry(P12, `${k2}|2`, 250);
eq("Ledger shows the exit balance", await led("I2"), [{ total: "1000.00", deducted: "500.00", in_payroll: "0", outstanding: "500.00", deducted_count: 2, installment_count: 4, status: "exit_balance" }]);

// --- Write-off: only an exited person's balance, with a reason, once
const waive = (cs, ref, reason) => `select waive_nl_recovery_balance('${C}','2026-09','${cs}','${ref}','${reason}','${ACT}','HR Head')`;
await throws("Active person's balance cannot be written off", waive("I1", `employee:${E1}`, "Person left suddenly"), /Only the balance of a person who has exited/);
await throws("Write-off needs a real reason", waive("I2", `employee:${E2}`, "short"), /write-off reason/);
await db.query(waive("I2", `employee:${E2}`, "Full and final settled; balance not recoverable"));
eq("Written-off balance and ledger", await led("I2"), [{ total: "1000.00", deducted: "500.00", in_payroll: "0", outstanding: "0", deducted_count: 2, installment_count: 4, status: "written_off" }]);
eq("Write-off amount is the outstanding only", (await one(`select amount::text a from nl_recovery_waivers where case_key='I2'`)).a, "500.00");
eq("Written-off line is never due again", keys(await due("hrms", "2026-11"), "I2"), []);
await throws("Write-off cannot repeat", waive("I2", `employee:${E2}`, "Full and final settled again"), /already written off/);
eq("Write-off is in the case history", Number((await one(`select count(*) n from nl_loss_recovery_events where case_key='I2' and after_value ? 'write_off'`)).n), 1);

// --- Station loss claims: CM approval opens a Team Ops loss case that flows through the same recovery
const CM = "00000000-0000-0000-0000-0000000000cc";
const claim = async (ref, amount = 800) => (await one(`select * from station_claim_submit('${C}','${S}','blr1','${ref}',current_date-3,'cash_shortage',${amount},'Cash short at day close by 800','https://drive.example/x','DA One','${ACT}','Station Lead')`));
const act = (id, action, version, actor, note = null, patch = {}) => `select * from station_claim_transition('${C}','${id}','${action}',${version},'${actor}','Someone',${note ? `'${note}'` : "null"},'${JSON.stringify(patch)}')`;
const c1 = await claim("blr-cash-001");
eq("Claim is submitted with an upper-case reference", [c1.status, c1.reference, c1.station_code], ["submitted", "BLR-CASH-001", "BLR1"]);
await throws("Reference is unique", `select station_claim_submit('${C}','${S}','BLR1','BLR-CASH-001',current_date,'other',10,'Duplicate reference here','','','${ACT}','x')`, /already used/);
await throws("Future incident refused", `select station_claim_submit('${C}','${S}','BLR1','FUT-1',current_date+1,'other',10,'Future incident here','','','${ACT}','x')`, /last 180 days/);
await throws("Raiser cannot approve", act(c1.id, "approve", 1, ACT), /cluster manager must decide/);
await throws("Return needs a reason", act(c1.id, "return", 1, CM), /at least 5/);
await throws("Stale version refused", act(c1.id, "approve", 9, CM), /Someone else updated/);
const r1 = await one(act(c1.id, "return", 1, CM, "Attach the cash book photo"));
eq("Returned for information", r1.status, "returned");
await throws("Only the raiser resubmits", act(c1.id, "resubmit", 2, CM, null, { amount: "750", description: "Corrected after recount" }), /Only the person who raised/);
const s1 = await one(act(c1.id, "resubmit", 2, ACT, null, { amount: "750", description: "Corrected after recount", evidence_url: "https://drive.example/y" }));
eq("Resubmitted with corrections", [s1.status, s1.amount], ["submitted", "750.00"]);
const a1 = await one(act(c1.id, "approve", 3, CM));
eq("Approved claim links to its loss case", [a1.status, a1.case_key, a1.case_month], ["approved", "station:BLR-CASH-001", a1.case_month]);
const sc = await one(`select report,amount::text,source_status,nl_case_recoverable(company_id,report,source_status) ok from nl_loss_month_cases where case_key='station:BLR-CASH-001'`);
eq("Station case is recoverable at the approved amount", sc, { report: "station", amount: "750.00", source_status: "Approved", ok: true });
await throws("Approved claim cannot be decided again", act(c1.id, "reject", 4, CM, "Changed my mind"), /now approved/);
await payables();
await db.query(`select save_nl_recovery('${C}','${a1.case_month}','station:BLR-CASH-001',0,'deduct','custom','${JSON.stringify([{ employee_ref: `workforce:${W1}`, amount: "750" }])}','Recover station cash','${ACT}','Ops','{}','{"mode":"installments","basis":"months","value":"3"}')`);
await db.exec(`update nl_loss_recoveries set deduction_month='2026-10' where case_key='station:BLR-CASH-001'`);
eq("Station loss is due in the Workforce payout, instalment 1", (await due("workforce", "2026-10")).filter((r) => r.recovery_key.includes("station:BLR-CASH-001")).map((r) => [r.amount, r.label.startsWith("STATION loss")]), [["250.00", true]]);
eq("NL cases still use Amazon's decision", (await one(`select nl_case_recoverable('${C}','nl','Not Recoverable') a, nl_case_recoverable('${C}','station','Pending') b`)), { a: false, b: false });
const c2 = await claim("blr-cash-002");
eq("Withdraw by raiser", (await one(act(c2.id, "withdraw", 1, ACT))).status, "withdrawn");
eq("Claim history is complete", (await db.query(`select action from ops_station_loss_claim_events where claim_id='${c1.id}' order by created_at,id`)).rows.map((r) => r.action), ["raised", "return", "resubmit", "approve"]);
await throws("Claim history cannot be edited", `update ops_station_loss_claim_events set note='x'`, /cannot be changed/);
eq("Unknown target returns nothing", (await db.query(`select * from nl_loss_recovery_due('${C}','2026-11','other')`)).rows, []);
eq("Bad month returns nothing", (await db.query(`select * from nl_loss_recovery_due('${C}','2026-13','hrms')`)).rows, []);
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
