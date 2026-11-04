import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const company = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const worker = "11111111-1111-4111-8111-111111111111";
const employee = "22222222-2222-4222-8222-222222222222";

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table hr_payroll_runs(company_id uuid, period_start date, status text);
  create table workforce_payout_import_batches(company_id uuid, status text, effective_from date, effective_to date);
  create table workforce_payout_publications(company_id uuid, period_start date);
  create table nl_loss_month_cases(company_id uuid, month text, case_key text, station_code text, details jsonb);
  create table nl_loss_recoveries(company_id uuid, month text, case_key text, allocations jsonb);
  create table test_recovery_debits(
    company_id uuid, recovery_key text, loss_month text, case_key text, station_code text,
    employee_ref text, employee_code text, full_name text, designation text, amount numeric,
    payroll_month text, is_deducted boolean, shipment_id text
  );
  create table test_recovery_due(
    company_id uuid, target text, recovery_key text, month text, case_key text, report text,
    employee_ref text, worker_id uuid, employee_code text, full_name text, amount numeric,
    deduction_month text, label text, installment_no int, installment_count int,
    cap_exempt boolean, cap_percent numeric, final_settlement boolean
  );
  create function nl_recovery_debits(p_company uuid, p_ref text default null)
  returns table(recovery_key text,loss_month text,case_key text,station_code text,employee_ref text,employee_code text,full_name text,designation text,amount numeric,payroll_month text,is_deducted boolean,shipment_id text)
  language sql stable as $$
    select recovery_key,loss_month,case_key,station_code,employee_ref,employee_code,full_name,designation,amount,payroll_month,is_deducted,shipment_id
    from test_recovery_debits where company_id=p_company and (p_ref is null or employee_ref=p_ref)
  $$;
  create function nl_loss_recovery_due(p_company uuid,p_salary_month text,p_target text,p_run_id uuid default null)
  returns table(recovery_key text,month text,case_key text,report text,employee_ref text,worker_id uuid,employee_code text,full_name text,amount numeric,deduction_month text,label text,installment_no int,installment_count int,cap_exempt boolean,cap_percent numeric,final_settlement boolean)
  language sql stable as $$
    select recovery_key,month,case_key,report,employee_ref,worker_id,employee_code,full_name,amount,deduction_month,label,installment_no,installment_count,cap_exempt,cap_percent,final_settlement
    from test_recovery_due where company_id=p_company and target=p_target and deduction_month<=p_salary_month
  $$;
  insert into hr_payroll_runs values ('${company}','2026-10-01','calculated');
  insert into workforce_payout_import_batches values ('${company}','committed','2026-09-01','2026-09-30');
  insert into test_recovery_debits values
    ('${company}','applied-people','2026-09','case-applied-people','QLDA','employee:${employee}','EMP1','People Person','Team Lead',1100,'2026-10',false,'TID-PEOPLE'),
    ('${company}','applied-workforce','2026-09','case-applied-workforce','QLDA','workforce:${worker}','WF1','Workforce Person','DA',900,'2026-09',true,'TID-WORKFORCE');
  insert into nl_loss_month_cases values
    ('${company}','2026-09','case-due-people','QLDA','{"tid":"TID-DUE-PEOPLE"}'),
    ('${company}','2026-09','case-due-workforce','QLDA','{"tid":"TID-DUE-WORKFORCE"}');
  insert into nl_loss_recoveries values
    ('${company}','2026-09','case-due-people','[{"ref":"employee:${employee}","designation":"Station Support Associate"}]'),
    ('${company}','2026-09','case-due-workforce','[{"ref":"workforce:${worker}","designation":"Delivery Associate"}]');
  insert into test_recovery_due values
    ('${company}','hrms','due-people','2026-09','case-due-people','nl','employee:${employee}','${employee}','EMP1','People Person',1200,'2026-10','People due',null,null,false,100,false),
    ('${company}','workforce','due-workforce','2026-09','case-due-workforce','nl','workforce:${worker}','${worker}','WF1','Workforce Person',1300,'2026-10','Workforce due',null,null,false,100,false),
    ('${company}','workforce','applied-workforce','2026-09','case-due-workforce','nl','workforce:${worker}','${worker}','WF1','Workforce Person',900,'2026-10','Already applied',null,null,false,100,false);
`);

const migration = fs.readFileSync("supabase/migrations/20261104193000_loss_recovery_combined_payroll_status.sql", "utf8");
await db.exec(migration);
await db.exec(migration);

const current = await db.query("select nl_recovery_current_payroll_month($1::uuid) as payroll_month", [company]);
assert.equal(current.rows[0].payroll_month, "2026-10", "latest open People/Workforce period, not wall-clock month, is current");

const ledger = await db.query(
  "select recovery_key,payroll_status,payroll_source,payroll_month,designation,shipment_id,amount from nl_recovery_payroll_status($1::uuid) order by recovery_key",
  [company],
);
assert.deepEqual(ledger.rows.map((row) => [row.recovery_key, row.payroll_status, row.payroll_source]), [
  ["applied-people", "draft", "people"],
  ["applied-workforce", "deducted", "workforce"],
  ["due-people", "scheduled", "people"],
  ["due-workforce", "scheduled", "workforce"],
]);
assert.equal(ledger.rows.find((row) => row.recovery_key === "due-workforce").designation, "Delivery Associate");
assert.equal(ledger.rows.find((row) => row.recovery_key === "due-people").shipment_id, "TID-DUE-PEOPLE");
assert.equal(ledger.rows.filter((row) => row.recovery_key === "applied-workforce").length, 1, "a due line already applied is not duplicated");

console.log("PASS combined recovery ledger: current open period, People payroll, Workforce payout, scheduled/draft/deducted truth, and applied-line de-duplication.");
