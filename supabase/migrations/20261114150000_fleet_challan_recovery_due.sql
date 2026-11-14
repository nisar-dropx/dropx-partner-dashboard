-- Fleet Challan Recovery payroll engine: a parallel to nl_loss_recovery_due that sources
-- from the SEPARATE challan recovery tables, so challan deductions reach payroll with the
-- same exactly-once / cap / exit / timing semantics as NL, without touching the NL ledger.
--
-- Safety design (per docs/team-ops-payroll-workflows.md ground rules):
--  * Money still moves ONLY through payroll (hr_payroll_run_items / workforce snapshot),
--    under the shared code OPS_LOSS_RECOVERY.
--  * EXACTLY ONCE: reuses the shared, generic guard nl_recovery_line_applied, which keys on
--    (OPS_LOSS_RECOVERY, recovery_key). Challan keys use case_key 'challan:<no>', a namespace
--    disjoint from NL/SLP case_keys, so a challan line can never collide with an NL line.
--  * Reuses the generic helpers nl_recovery_key / nl_recovery_alloc_keys /
--    nl_recovery_person_exit / nl_dispute_recovery_amount / loss_recovery_payroll_windows
--    verbatim (they are source-agnostic), so the salary math cannot drift from NL.
--
-- Apply alone to shared Supabase. The matching HRMS consumer change is in dropx-hrms.

begin;

-- Return shape mirrors nl_loss_recovery_due so the HRMS fit path can treat both uniformly.
create or replace function public.fleet_challan_recovery_due(
  p_company uuid, p_salary_month text, p_target text, p_run_id uuid default null
) returns table(
  recovery_key text, month text, case_key text, report text, employee_ref text, worker_id uuid,
  employee_code text, full_name text, amount numeric, deduction_month text, label text,
  installment_no integer, installment_count integer, cap_exempt boolean, cap_percent numeric,
  final_settlement boolean
)
language sql
stable
set search_path to 'public'
as $function$
 with policy as (
   select coalesce(s.recovery_policy->>'payroll_start_month','2026-10') start_month, 100::numeric cap_percent
   from nl_loss_sources s where s.company_id = p_company limit 1
 ),
 bounds as (
   select (to_date(p_salary_month,'YYYY-MM')+interval '1 month'-interval '1 day')::date last_day
   where p_salary_month ~ '^\d{4}-(0[1-9]|1[0-2])$'
 ),
 -- Collapse the per-associate allocation rows for a case into one JSONB alloc object,
 -- matching the shape nl_recovery_alloc_keys expects (ref, amount, installments[]).
 alloc_objs as materialized (
   select
     a.company_id, c.month, ('challan:'||c.challan_number) case_key, 'challan'::text report,
     min(a.salary_month) deduction_month,
     max(a.split_mode) split_mode,
     a.person_ref ref,
     jsonb_build_object(
       'ref', a.person_ref,
       'employee_code', '',
       'full_name', max(a.person_name),
       'amount', round(sum(case when a.installment_count<=1 then a.amount else 0 end),2),
       'installments', coalesce(
         jsonb_agg(jsonb_build_object('n', a.installment_no, 'amount', round(a.amount,2))
           order by a.installment_no) filter (where a.installment_count>1),
         '[]'::jsonb)
     ) alloc,
     c.amount case_amount, c.status case_status, c.id case_id
   from public.fleet_challan_recovery_allocations a
   join public.fleet_challan_recovery_cases c on c.company_id=a.company_id and c.id=a.case_id
   where a.company_id=p_company
     and a.status not in ('cancelled','waived')
     and coalesce(a.amount,0) > 0
   group by a.company_id, c.month, c.challan_number, c.amount, c.status, c.id, a.person_ref
 ),
 allocs as materialized (
   select o.month, o.case_key, o.report, o.deduction_month, false cap_override, o.alloc,
     o.ref employee_ref, nl_recovery_person_exit(p_company, o.ref) exit_date,
     'Challan · '||to_char(to_date(o.month,'YYYY-MM'),'Mon YYYY')||' · '||regexp_replace(o.case_key,'^challan:','') base_label
   from alloc_objs o cross join policy cross join bounds
   where p_salary_month >= policy.start_month
     and o.case_status in ('open','assigned','recovering')
     and ((p_target='hrms' and split_part(o.ref,':',1) in ('employee','contractor'))
       or (p_target='workforce' and split_part(o.ref,':',1)='workforce'))
     and greatest(o.deduction_month, policy.start_month) <= p_salary_month
 ),
 lines as materialized (
   select k.recovery_key, a.month, a.case_key, a.report, a.employee_ref,
     split_part(a.employee_ref,':',2)::uuid worker_id,
     a.alloc->>'employee_code' employee_code, a.alloc->>'full_name' full_name,
     public.nl_dispute_recovery_amount(p_company,k.recovery_key,k.amount) amount, a.deduction_month,
     k.installment_no, nullif(jsonb_array_length(coalesce(a.alloc->'installments','[]')),0) installment_count,
     a.exit_date is not null and a.exit_date<=b.last_day final_settlement, a.cap_override, a.base_label,
     nl_recovery_key(a.month,a.case_key,a.employee_ref) base_key,
     greatest(a.deduction_month, policy.start_month) scheduled_month
   from allocs a cross join bounds b cross join policy
   cross join lateral nl_recovery_alloc_keys(a.month,a.case_key,a.alloc) k
   where public.nl_dispute_recovery_amount(p_company,k.recovery_key,k.amount) > 0
 ),
 open_month_candidates as materialized (
   select distinct l.employee_ref, to_char(m::date,'YYYY-MM') salary_month
   from lines l cross join lateral generate_series(
     to_date(l.scheduled_month,'YYYY-MM'),
     to_date(p_salary_month,'YYYY-MM')-interval '1 month', interval '1 month') m
   where not l.final_settlement and l.scheduled_month<>p_salary_month
 ),
 payroll_windows as materialized (
   select w.* from public.loss_recovery_payroll_windows(
     p_company, array(select distinct employee_ref from open_month_candidates)) w
 ),
 open_months as materialized (
   select c.employee_ref, c.salary_month, exists(
     select 1 from payroll_windows w
     where w.employee_ref=c.employee_ref and w.salary_month=c.salary_month
       and w.payroll_open and (w.payable>0 or w.payable is null)) is_open
   from open_month_candidates c
 )
 select l.recovery_key, l.month, l.case_key, l.report, l.employee_ref, l.worker_id,
   l.employee_code, l.full_name, l.amount, l.deduction_month,
   l.base_label||case when l.installment_no is not null then ' · instalment '||l.installment_no||' of '||l.installment_count else '' end
     ||case when l.final_settlement then ' · final settlement' else '' end,
   l.installment_no, l.installment_count, l.cap_override or l.final_settlement, p.cap_percent, l.final_settlement
 from lines l cross join policy p
 where nl_recovery_line_applied(p_company,l.recovery_key,p_run_id,null) is null
   and (l.installment_no is null or l.installment_no=1 or l.final_settlement
     or nl_recovery_line_applied(p_company,l.base_key||'|'||(l.installment_no-1),p_run_id,null) < p_salary_month)
   and (
     l.final_settlement
     or l.scheduled_month=p_salary_month
     or not exists(
       select 1 from generate_series(
         to_date(l.scheduled_month,'YYYY-MM'),
         to_date(p_salary_month,'YYYY-MM')-interval '1 month', interval '1 month') m
       where (select o.is_open from open_months o
         where o.employee_ref=l.employee_ref and o.salary_month=to_char(m::date,'YYYY-MM')))
   )
 order by l.deduction_month, l.month, l.case_key, l.employee_ref, l.installment_no nulls first
$function$;

revoke all on function public.fleet_challan_recovery_due(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.fleet_challan_recovery_due(uuid, text, text, uuid) to service_role;

notify pgrst, 'reload schema';
commit;
