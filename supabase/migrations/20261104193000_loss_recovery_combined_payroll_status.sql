begin;

-- The recovery screen follows the latest outstanding payroll/payout period,
-- not the wall-clock month. On 4 Nov, for example, October can still be the
-- current unpaid period for both People payroll and Workforce payouts.
create or replace function public.nl_recovery_current_payroll_month(p_company uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with candidate(month_start) as (
    select max(run.period_start)
    from public.hr_payroll_runs run
    where run.company_id = p_company
      and run.status in ('draft', 'calculated', 'review')
    union all
    select max(date_trunc('month', batch.effective_from)::date)
    from public.workforce_payout_import_batches batch
    where batch.company_id = p_company
      and batch.status = 'committed'
      and batch.effective_to < (now() at time zone 'Asia/Kolkata')::date
    union all
    select max(publication.period_start)
    from public.workforce_payout_publications publication
    where publication.company_id = p_company
  )
  select coalesce(
    to_char(max(month_start), 'YYYY-MM'),
    to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM')
  )
  from candidate
$$;

comment on function public.nl_recovery_current_payroll_month(uuid) is
  'Latest outstanding People payroll or Workforce payout period used by Ops loss recovery reporting.';

-- One truthful ledger for both payroll engines. Applied rows come from an
-- immutable payroll/payout artifact; due rows remain explicitly scheduled and
-- must never be presented as already deducted.
create or replace function public.nl_recovery_payroll_status(
  p_company uuid,
  p_salary_month text default null,
  p_ref text default null
)
returns table(
  recovery_key text,
  loss_month text,
  case_key text,
  station_code text,
  employee_ref text,
  employee_code text,
  full_name text,
  designation text,
  amount numeric,
  payroll_month text,
  payroll_status text,
  payroll_source text,
  shipment_id text
)
language sql
stable
security definer
set search_path = public
as $$
  with selected_month as (
    select coalesce(nullif(p_salary_month, ''), public.nl_recovery_current_payroll_month(p_company)) value
  ),
  applied as (
    select
      debit.recovery_key,
      debit.loss_month,
      debit.case_key,
      debit.station_code,
      debit.employee_ref,
      debit.employee_code,
      debit.full_name,
      debit.designation,
      debit.amount,
      debit.payroll_month,
      case when debit.is_deducted then 'deducted' else 'draft' end payroll_status,
      case when split_part(debit.employee_ref, ':', 1) = 'workforce' then 'workforce' else 'people' end payroll_source,
      debit.shipment_id
    from public.nl_recovery_debits(p_company, p_ref) debit
    where p_salary_month is null or debit.payroll_month = p_salary_month
  ),
  due as (
    select due_line.*, 'people'::text payroll_source
    from selected_month month
    cross join lateral public.nl_loss_recovery_due(p_company, month.value, 'hrms', null) due_line
    union all
    select due_line.*, 'workforce'::text payroll_source
    from selected_month month
    cross join lateral public.nl_loss_recovery_due(p_company, month.value, 'workforce', null) due_line
  ),
  scheduled as (
    select
      due.recovery_key,
      due.month loss_month,
      due.case_key,
      loss_case.station_code,
      due.employee_ref,
      due.employee_code,
      due.full_name,
      coalesce(allocation.item->>'designation', '') designation,
      due.amount,
      month.value payroll_month,
      'scheduled'::text payroll_status,
      due.payroll_source,
      coalesce(nullif(loss_case.details->>'tid', ''), regexp_replace(due.case_key, '^slp:', '', 'i')) shipment_id
    from due
    cross join selected_month month
    join public.nl_loss_month_cases loss_case
      on loss_case.company_id = p_company
     and loss_case.month = due.month
     and loss_case.case_key = due.case_key
    left join public.nl_loss_recoveries recovery
      on recovery.company_id = p_company
     and recovery.month = due.month
     and recovery.case_key = due.case_key
    left join lateral (
      select item
      from jsonb_array_elements(coalesce(recovery.allocations, '[]'::jsonb)) item
      where item->>'ref' = due.employee_ref
      limit 1
    ) allocation on true
    where (p_ref is null or due.employee_ref = p_ref)
      and not exists (
        select 1 from applied
        where applied.recovery_key = due.recovery_key
      )
  )
  select * from applied
  union all
  select * from scheduled
  order by payroll_month, recovery_key
$$;

comment on function public.nl_recovery_payroll_status(uuid,text,text) is
  'Combined People payroll and Workforce payout loss-recovery ledger with scheduled, draft and deducted states.';

revoke all on function public.nl_recovery_current_payroll_month(uuid),
  public.nl_recovery_payroll_status(uuid,text,text) from public, anon, authenticated;
grant execute on function public.nl_recovery_current_payroll_month(uuid),
  public.nl_recovery_payroll_status(uuid,text,text) to service_role;

notify pgrst, 'reload schema';
commit;
