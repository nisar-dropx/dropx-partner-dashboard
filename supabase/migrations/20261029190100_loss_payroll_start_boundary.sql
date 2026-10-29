begin;
-- Generated with migration new, then ordered after the existing 19:00 migration.
-- The configured payroll start month applies to unpaid/open payroll too.
-- Do not alter old payroll snapshots, payments or recovery audit history.
do $$
declare d text; cutoff text := $p$to_date(coalesce((select s.recovery_policy->>'payroll_start_month' from nl_loss_sources s where s.company_id=p_company limit 1),'2026-10'),'YYYY-MM')$p$;
begin
 d:=pg_get_functiondef('public.loss_recovery_payroll_windows(uuid,text[])'::regprocedure);
 if position('-- Payroll start boundary' in d)=0 then
  if position('where p.company_id=p_company and p.worker_type' in d)=0
   or position('where w.company_id=p_company' in d)=0 then
   raise exception 'Unexpected payroll-window function; refusing partial boundary patch';
  end if;
  d:=replace(d,'where p.company_id=p_company and p.worker_type',
   'where r.period_start >= '||cutoff||E' -- Payroll start boundary\n and p.company_id=p_company and p.worker_type');
  d:=replace(d,'where w.company_id=p_company',
   'where w.period_start >= '||cutoff||' and w.company_id=p_company');
  -- The second w is a Workforce profile, so use its generated month instead.
  d:=replace(d,'m where w.period_start >= ','m where m::date >= ');
  execute d;
 end if;

 d:=pg_get_functiondef('public.save_nl_recovery(uuid,text,text,integer,text,text,jsonb,text,uuid,text,jsonb,jsonb)'::regprocedure);
 if position('-- Enforce payroll start boundary' in d)=0 then
  if position('if pay_month>to_char' in d)=0 then raise exception 'Unexpected recovery writer'; end if;
  d:=replace(d,'if pay_month>to_char', $p$
  -- Enforce payroll start boundary even for an older open month or saved plan.
  if o.allocation_required and pay_month < coalesce(policy->>'payroll_start_month','2026-10') then
   raise exception 'Recovery can use payroll from % onward only.',coalesce(policy->>'payroll_start_month','2026-10');
  end if;
  if pay_month>to_char$p$);
  execute d;
 end if;

 d:=pg_get_functiondef('public.nl_loss_recovery_due(uuid,text,text,uuid)'::regprocedure);
 d:=replace(d,$p$where (p_salary_month>=policy.start_month or (coalesce((x->>'unpaid_open_payroll')::boolean,false) and p_salary_month>=r.deduction_month)) -- Explicit unpaid month$p$,
  'where p_salary_month>=policy.start_month -- Payroll start boundary');
 d:=replace(d,$p$and (greatest(r.deduction_month,policy.start_month)<=p_salary_month or (coalesce((x->>'unpaid_open_payroll')::boolean,false) and r.deduction_month<=p_salary_month))$p$,
  'and greatest(r.deduction_month,policy.start_month)<=p_salary_month');
 if position('-- Payroll start boundary' in d)=0 or position('Explicit unpaid month' in d)>0 then raise exception 'Unexpected recovery due function'; end if;
 execute d;
end $$;
notify pgrst,'reload schema';
commit;
