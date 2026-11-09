import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const db = new PGlite();
try {
  await db.exec(`
    create table windows(company uuid, employee_ref text, salary_month text, payroll_open boolean, payable numeric);
    insert into windows values
      ('00000000-0000-0000-0000-000000000001','workforce:open','2026-10',true,100),
      ('00000000-0000-0000-0000-000000000001','workforce:zero','2026-10',true,0),
      ('00000000-0000-0000-0000-000000000001','workforce:negative','2026-10',true,-10),
      ('00000000-0000-0000-0000-000000000001','workforce:unknown','2026-10',true,null),
      ('00000000-0000-0000-0000-000000000001','workforce:paid','2026-10',false,100),
      ('00000000-0000-0000-0000-000000000001','hrms:open','2026-10',true,100),
      ('00000000-0000-0000-0000-000000000001','hrms:paid','2026-10',false,100),
      ('00000000-0000-0000-0000-000000000002','workforce:paid','2026-10',true,100);
    create function loss_recovery_payroll_windows(p_company uuid,p_people text[])
    returns table(employee_ref text,salary_month text,payroll_open boolean,payable numeric)
    language sql stable as $$
      select employee_ref,salary_month,payroll_open,payable from windows
      where company=p_company and employee_ref=any(p_people)
    $$;
    create function loss_recovery_open_payroll(p_company uuid,p_employee text,p_month text)
    returns boolean language sql stable as $$
      select exists(select 1 from loss_recovery_payroll_windows(p_company,array[p_employee]) w
        where w.salary_month=p_month and w.payroll_open and (w.payable>0 or w.payable is null))
    $$;
    create function nl_loss_recovery_due(p_company uuid,p_month text,p_target text,p_run uuid)
    returns table(employee_ref text,salary_month text,is_open boolean) language sql stable security definer set search_path=public as $$
    with loss_due_open_month_candidates as materialized (
      select w.employee_ref,m.salary_month from windows w
      cross join (values ('2026-09'),('2026-10'),('2026-11')) m(salary_month)
      where w.company=p_company and w.employee_ref like p_target||':%'
    ), loss_due_open_months as materialized (
   select c.employee_ref,c.salary_month,
     public.loss_recovery_open_payroll(p_company,c.employee_ref,c.salary_month) is_open
   from loss_due_open_month_candidates c
 ) select * from loss_due_open_months order by employee_ref,salary_month;
    $$;
  `);
  const query = target => db.query(`select * from nl_loss_recovery_due('00000000-0000-0000-0000-000000000001','2026-11','${target}',null)`);
  const workforce = (await query('workforce')).rows;
  const people = (await query('hrms')).rows;
  const migration=readFileSync(new URL('../supabase/migrations/20261109184921_batch_loss_payroll_window_checks.sql',import.meta.url),'utf8');
  await db.exec(migration);
  assert.deepEqual((await query('workforce')).rows,workforce);
  assert.deepEqual((await query('hrms')).rows,people);
  assert.deepEqual((await query('missing')).rows,[]);
  assert.deepEqual(workforce.filter(r=>r.is_open).map(r=>r.employee_ref),['workforce:open','workforce:unknown']);
  await db.exec(migration); // replay must not alter behaviour
  assert.deepEqual((await query('workforce')).rows,workforce);
  const properties=await db.query(`select prosecdef,proconfig from pg_proc where oid='nl_loss_recovery_due(uuid,text,text,uuid)'::regprocedure`);
  assert.equal(properties.rows[0].prosecdef,true);
  assert.deepEqual(properties.rows[0].proconfig,['search_path=public']);
  console.log('Payroll batching preserves Workforce/People results, month/company boundaries, zero/null/paid gates and function security; replay is safe.');
} finally { await db.close(); }
