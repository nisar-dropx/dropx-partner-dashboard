-- Captured production definition, confirmed against user-supplied SQL on 2026-11-09.
CREATE OR REPLACE FUNCTION public.nl_loss_recovery_due(p_company uuid, p_salary_month text, p_target text, p_run_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(recovery_key text, month text, case_key text, report text, employee_ref text, worker_id uuid, employee_code text, full_name text, amount numeric, deduction_month text, label text, installment_no integer, installment_count integer, cap_exempt boolean, cap_percent numeric, final_settlement boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 with policy as (
  select coalesce(s.recovery_policy->>'payroll_start_month','2026-10') start_month,
   100::numeric cap_percent
  from nl_loss_sources s where s.company_id=p_company limit 1),
 bounds as (
  select (to_date(p_salary_month,'YYYY-MM')+interval '1 month'-interval '1 day')::date last_day,
   case when p_target='workforce' then to_date(p_salary_month,'YYYY-MM') end excluded_period
  where p_salary_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 allocs as (
  select r.month, r.case_key, c.report, r.deduction_month, r.cap_override, x alloc, x->>'ref' employee_ref,
   nl_recovery_person_exit(p_company,x->>'ref') exit_date,
   upper(c.report)||' loss · '||to_char(to_date(r.month,'YYYY-MM'),'Mon YYYY')||' · '||regexp_replace(r.case_key,'^slp:','') base_label
  from nl_loss_recoveries r
  join nl_loss_month_cases c on c.company_id=r.company_id and c.month=r.month and c.case_key=r.case_key
  cross join jsonb_array_elements(r.allocations) x
  cross join policy cross join bounds
  where p_salary_month>=policy.start_month -- Payroll start boundary
   and r.company_id=p_company
   -- Redispute payroll gate
   and not exists(select 1 from nl_case_response_windows rw where rw.company_id=r.company_id and rw.month=r.month and rw.case_key=r.case_key and (rw.enabled or rw.workflow_status='won' or rw.recovery_month>p_salary_month))
   and not r.is_deleted and r.deduction_timing<>'none' and r.deduction_month is not null
   and r.approval_status = 'approved'
   and c.lifecycle_status in ('recovery_approved_scheduled','recovery_in_progress','exit_balance')
   and greatest(r.deduction_month,policy.start_month)<=p_salary_month
   and ((p_target='hrms' and split_part(x->>'ref',':',1) in ('employee','contractor')) or (p_target='workforce' and split_part(x->>'ref',':',1)='workforce'))
   and coalesce((x->>'amount')::numeric,0)>0
   and c.source_present and round(c.amount,2)=round(r.source_amount,2)
   and nl_case_recoverable(p_company,c.report,c.source_status)
   and (c.report<>'slp' or c.final_seen_at is not null)
   and not exists(select 1 from nl_recovery_waivers w
     where w.company_id=r.company_id and w.month=r.month and w.case_key=r.case_key and w.employee_ref=x->>'ref')),
 lines as (
  select k.recovery_key, a.month, a.case_key, a.report, a.employee_ref, split_part(a.employee_ref,':',2)::uuid worker_id,
   a.alloc->>'employee_code' employee_code, a.alloc->>'full_name' full_name, public.nl_dispute_recovery_amount(p_company,k.recovery_key,k.amount) amount, a.deduction_month,
   k.installment_no, nullif(jsonb_array_length(coalesce(a.alloc->'installments','[]')),0) installment_count,
   a.exit_date is not null and a.exit_date<=b.last_day final_settlement, a.cap_override, a.base_label,
   nl_recovery_key(a.month,a.case_key,a.employee_ref) base_key, b.excluded_period,
   greatest(a.deduction_month,policy.start_month) scheduled_month
  from allocs a cross join bounds b cross join policy
  cross join lateral nl_recovery_alloc_keys(a.month,a.case_key,a.alloc) k
  where public.nl_dispute_recovery_amount(p_company,k.recovery_key,k.amount)>0)
 select l.recovery_key, l.month, l.case_key, l.report, l.employee_ref, l.worker_id, l.employee_code, l.full_name, l.amount, l.deduction_month,
  l.base_label||case when l.installment_no is not null then ' · instalment '||l.installment_no||' of '||l.installment_count else '' end
   ||case when l.final_settlement then ' · final settlement' else '' end,
  l.installment_no, l.installment_count, l.cap_override or l.final_settlement, p.cap_percent, l.final_settlement
 from lines l cross join policy p
 where nl_recovery_line_applied(p_company,l.recovery_key,p_run_id,l.excluded_period) is null
  and (l.installment_no is null or l.installment_no=1 or l.final_settlement
   or nl_recovery_line_applied(p_company,l.base_key||'|'||(l.installment_no-1),p_run_id,l.excluded_period)<p_salary_month)
  -- Due-month window: stay on the scheduled month while any earlier open payroll still owns it.
  and (
    l.final_settlement
    or l.scheduled_month=p_salary_month
    or not exists (
      select 1
      from generate_series(
        to_date(l.scheduled_month,'YYYY-MM'),
        to_date(p_salary_month,'YYYY-MM') - interval '1 month',
        interval '1 month'
      ) m
      where loss_recovery_open_payroll(p_company, l.employee_ref, to_char(m::date,'YYYY-MM'))
    )
  )
 order by l.deduction_month,l.month,l.case_key,l.employee_ref,l.installment_no nulls first
$function$;
