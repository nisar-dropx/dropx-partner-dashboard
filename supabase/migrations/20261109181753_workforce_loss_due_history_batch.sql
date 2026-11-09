begin;
set local lock_timeout = '5s';

-- Keep the live eligibility/approval/scheduling rules. Only replace repeated
-- Workforce publication lookups with one statement-local history projection.
do $patch$
declare
  d text;
  anchor text := 'with policy as (';
  current_lookup text := 'nl_recovery_line_applied(p_company,l.recovery_key,p_run_id,l.excluded_period)';
  previous_lookup text := 'nl_recovery_line_applied(p_company,l.base_key||''|''||(l.installment_no-1),p_run_id,l.excluded_period)';
  open_lookup text := 'loss_recovery_open_payroll(p_company, l.employee_ref, to_char(m::date,''YYYY-MM''))';
  final_select text := E')\n select l.recovery_key';
  open_cte text := $sql$), loss_due_open_month_candidates as materialized (
   select distinct l.employee_ref,to_char(m::date,'YYYY-MM') salary_month
   from lines l cross join lateral generate_series(
     to_date(l.scheduled_month,'YYYY-MM'),
     to_date(p_salary_month,'YYYY-MM')-interval '1 month',interval '1 month'
   ) m
   where not l.final_settlement and l.scheduled_month<>p_salary_month
 ), loss_due_open_months as materialized (
   select c.employee_ref,c.salary_month,
     public.loss_recovery_open_payroll(p_company,c.employee_ref,c.salary_month) is_open
   from loss_due_open_month_candidates c
 )
 select l.recovery_key$sql$;
  history_cte text := $sql$with workforce_loss_applied_history as materialized (
   -- workforce_loss_due_history_batch_v1
   -- Select the latest revision BEFORE reading its JSON. Old revisions must
   -- never suppress a deduction removed in a newer revision.
   select latest.workforce_id, deduction->>'recoveryKey' recovery_key,
     min(to_char(latest.period_start,'YYYY-MM')) applied_month
   from (
     select distinct on (w.workforce_id,w.station_id,w.period_start,w.period_end)
       w.id,w.workforce_id,w.period_start
     from public.workforce_payout_publications w
     where p_target='workforce' and w.company_id=p_company
       and w.period_start is not null
       and w.period_start is distinct from to_date(p_salary_month,'YYYY-MM')
     order by w.workforce_id,w.station_id,w.period_start,w.period_end,w.revision desc
   ) latest
   join public.workforce_payout_publications publication on publication.id=latest.id
     and publication.company_id=p_company
   cross join lateral jsonb_array_elements(case
     when jsonb_typeof(publication.snapshot #> '{worksheet,deduction_breakdown}')='array'
       then publication.snapshot #> '{worksheet,deduction_breakdown}'
     else '[]'::jsonb end) deduction
   where deduction->>'recoveryKey' is not null
   group by latest.workforce_id,deduction->>'recoveryKey'
 ), policy as ($sql$;
begin
  select replace(pg_get_functiondef(
    'public.nl_loss_recovery_due(uuid,text,text,uuid)'::regprocedure
  ),E'\r\n',E'\n') into d;
  if strpos(d,'workforce_loss_due_history_batch_v1')>0 then return; end if;
  if strpos(d,anchor)=0 or strpos(d,current_lookup)=0 or strpos(d,previous_lookup)=0 then
    raise exception 'Loss due function differs from inspected version; no changes applied.';
  end if;
  -- Exit dates and installment expansion are reused in several output and
  -- eligibility expressions. Evaluate each allocation/line once as well.
  d:=replace(d,'allocs as (','allocs as materialized (');
  d:=replace(d,'lines as (','lines as materialized (');
  if strpos(d,open_lookup)>0 then
    if strpos(d,final_select)=0 then
      raise exception 'Cannot locate loss due-month query; no changes applied.';
    end if;
    d:=replace(d,final_select,open_cte);
    d:=replace(d,open_lookup,$sql$(select o.is_open from loss_due_open_months o
      where o.employee_ref=l.employee_ref and o.salary_month=to_char(m::date,'YYYY-MM'))$sql$);
  elsif strpos(d,'loss_recovery_open_payroll')>0 then
    raise exception 'Unexpected open-payroll check; no changes applied.';
  end if;
  d:=replace(d,anchor,history_cte);
  d:=replace(d,current_lookup,$sql$(case when p_target='workforce' then (
    select h.applied_month from workforce_loss_applied_history h
    where h.workforce_id=l.worker_id and h.recovery_key=l.recovery_key
  ) else nl_recovery_line_applied(p_company,l.recovery_key,p_run_id,l.excluded_period) end)$sql$);
  d:=replace(d,previous_lookup,$sql$(case when p_target='workforce' then (
    select h.applied_month from workforce_loss_applied_history h
    where h.workforce_id=l.worker_id and h.recovery_key=l.base_key||'|'||(l.installment_no-1)
  ) else nl_recovery_line_applied(p_company,l.base_key||'|'||(l.installment_no-1),p_run_id,l.excluded_period) end)$sql$);
  execute d;
end
$patch$;
notify pgrst, 'reload schema';
commit;

select strpos(pg_get_functiondef('public.nl_loss_recovery_due(uuid,text,text,uuid)'::regprocedure),
  'workforce_loss_due_history_batch_v1')>0 as performance_fix_installed;
