import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
create table hr_payroll_runs(id uuid,company_id uuid,period_start date,period_end date,updated_at timestamptz,status text);
create table hr_payroll_run_people(id uuid,company_id uuid,run_id uuid,worker_type text,worker_id uuid,net_pay numeric,adjusted_net_pay numeric);
create table hr_payroll_run_items(company_id uuid,run_person_id uuid,code text,item_type text,amount numeric,metadata jsonb);
create table hr_payroll_run_manual_entries(company_id uuid,run_id uuid,worker_type text,worker_id uuid,applied_by uuid,salary_hold_reason_id uuid);
create table ops_salary_holds(id uuid,company_id uuid,worker_type text,worker_id uuid,status text,requested_by_name text,requested_by_user_id uuid,reason text,applied_run_id uuid);
create table profiles(id uuid,full_name text,email text);
create table hr_salary_hold_reasons(id uuid,company_id uuid,name text);
create table workforce_payout_payment_hold_events(id uuid,company_id uuid,workforce_id uuid,period_start date,period_end date,created_at timestamptz,actor_user_id uuid,remarks text,action text);
create table hr_payroll_bank_lines(company_id uuid,run_id uuid,worker_id uuid,worker_type text,status text,amount numeric);
create function loss_recovery_payroll_windows(p_company uuid,p_refs text[]) returns table(employee_ref text,salary_month text,payroll_open boolean,payable numeric,paid numeric,processing boolean) language sql as $$
select p.worker_type||':'||p.worker_id,to_char(r.period_start,'YYYY-MM'),r.status='calculated' and not b.processing,
greatest(0,coalesce(p.adjusted_net_pay,p.net_pay,0) -case when h.in_net then 0 else h.held end + h.loss-b.paid),b.paid,b.processing
from hr_payroll_run_people p join hr_payroll_runs r on r.id=p.run_id
cross join lateral(select coalesce(sum(i.amount) filter(where i.code='SALARY_HOLD'),0) held,false in_net,coalesce(sum(i.amount) filter(where i.code='OPS_LOSS_RECOVERY'),0) loss from hr_payroll_run_items i where i.run_person_id=p.id) h
cross join lateral(select coalesce(sum(b.amount) filter(where b.status='paid'),0) paid,coalesce(bool_or(b.status in ('issued','processing')),false) processing from hr_payroll_bank_lines b where b.company_id=p.company_id and b.run_id=p.run_id and b.worker_id=p.worker_id) b
where p.company_id=p_company and p.worker_type||':'||p.worker_id=any(p_refs);$$;`);
const sql=readFileSync('supabase/migrations/20261105183000_salary_hold_deduction_context.sql','utf8');await db.exec(sql);await db.exec(sql);
const c='00000000-0000-0000-0000-000000000001',r='00000000-0000-0000-0000-000000000002',w='00000000-0000-0000-0000-000000000003',p='00000000-0000-0000-0000-000000000004',a='00000000-0000-0000-0000-000000000005';
await db.exec(`insert into hr_payroll_runs values('${r}','${c}','2026-10-01','2026-10-31',now(),'calculated');
insert into hr_payroll_run_people values('${p}','${c}','${r}','employee','${w}',2000,null);
insert into hr_payroll_run_items values('${c}','${p}','SALARY_HOLD','information',2000,'{"full_month":true,"reason":"Review"}');
insert into hr_payroll_run_manual_entries values('${c}','${r}','employee','${w}','${a}',null);
insert into profiles values('${a}','Finance actor','actor@example.test');
insert into hr_payroll_bank_lines values('${c}','${r}','${w}','contractor','issued',2000);`);
const window=()=>db.query(`select * from loss_recovery_payroll_windows('${c}',array['employee:${w}'])`);
assert.equal((await window()).rows[0].payable,'2000');assert.equal((await window()).rows[0].payroll_open,true);
const holds=await db.query(`select * from salary_hold_context('${c}',array['employee:${w}'],array['2026-10'])`);
assert.equal(holds.rows[0].actor_name,'Finance actor');assert.equal(holds.rows[0].reason,'Review');assert.equal(holds.rows.length,1);
assert.equal((await db.query(`select * from salary_hold_context('${a}',array['employee:${w}'],array['2026-10'])`)).rows.length,0);
assert.equal((await db.query(`select * from salary_hold_context('${c}',null,array['2026-10'])`)).rows.length,0);
await db.exec(`insert into hr_payroll_bank_lines values('${c}','${r}','${w}','employee','paid',500)`);
assert.equal((await window()).rows[0].payable,'1500');
await db.exec(`insert into hr_payroll_bank_lines values('${c}','${r}','${w}','employee','processing',100)`);
assert.equal((await window()).rows[0].payroll_open,false);
assert.equal((await db.query(`select has_function_privilege('authenticated','salary_hold_context(uuid,text[],text[])','execute') permitted`)).rows[0].permitted,false);
console.log('Hold context: full hold capacity, paid balance, processing lock, typed identity, scope, actor/reason, permissions and idempotence passed.');await db.close();
