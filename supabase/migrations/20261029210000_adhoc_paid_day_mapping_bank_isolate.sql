-- Bank finalize was aborting whole Transaction Enquiry uploads when a work-day
-- Adhoc DA had no station-scoped Workforce mapping: resolve returned null and
-- enqueue_workforce_payout_dependency_refresh raised a generic dependency error
-- that the partial finalizer does not isolate.
--
-- Fix:
-- 1) Prefer the request station mapping; if none, accept a company-unique
--    provider-member match for the same client and work date.
-- 2) Fail paid work-day transitions with a clear row-scoped message before
--    enqueue when Workforce still cannot be resolved.
-- 3) Isolate that message (and the legacy dependency message) in the partial
--    bank finalizer so the rest of the file can settle.
-- 4) Skip advance payout-refresh enqueue when period/station identity is incomplete.

begin;

create or replace function public.resolve_adhoc_paid_day_worker(
  company uuid,
  station uuid,
  client_name text,
  member text,
  day date
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with candidates as (
    select
      w.id as workforce_id,
      case when m.station_id = station then 0 else 1 end as station_rank
    from public.field_executive_provider_mappings m
    join public.providers p
      on p.company_id = m.company_id
     and p.id = m.provider_id
    join public.workforce w
      on w.company_id = m.company_id
     and (
       w.id = m.workforce_id
       or (
         m.workforce_id is null
         and (
           w.id = m.field_executive_id
           or w.source_profile_id = coalesce(m.contractor_id, m.employee_id, m.field_executive_id)
         )
       )
     )
    where m.company_id = company
      and upper(btrim(m.provider_member_id)) = upper(btrim(member))
      and (lower(p.code) = lower(client_name) or lower(p.name) = lower(client_name))
      and m.status in ('active', 'closed')
      and m.effective_from <= day
      and (m.effective_to is null or m.effective_to >= day)
  ), preferred as (
    select workforce_id
    from candidates
    where station_rank = (select min(station_rank) from candidates)
  )
  select case
    when count(distinct workforce_id) = 1 then min(workforce_id::text)::uuid
    else null
  end
  from preferred;
$$;

do $patch_adhoc_guard$
declare
  v_definition text;
  v_old text := replace($old$
      new.adhoc_workforce_id:=public.resolve_adhoc_paid_day_worker(new.company_id,new.location_id,new.adhoc_client,new.adhoc_provider_employee_id,new.adhoc_work_date);
      if exists(select 1 from public.workforce_payout_effective_paid_allocations a where a.company_id=new.company_id and a.credited_workforce_id=new.adhoc_workforce_id
        and a.station_id=new.location_id and new.adhoc_work_date between a.period_start and a.period_end)
        or exists(select 1 from public.workforce_payroll_runs r join public.workforce_payroll_items i on i.payroll_run_id=r.id and i.company_id=r.company_id
          where r.company_id=new.company_id and i.workforce_id=new.adhoc_workforce_id and r.status in ('approved','paid') and i.status<>'excluded' and new.adhoc_work_date between r.period_start and r.period_end) then
        raise exception 'This work date is already in a finalized Workforce payout. Finance must review it before paying ad hoc';
      end if;
      perform public.workforce_bump_payout_period_dependency_revision(new.company_id,new.adhoc_work_date);
      perform public.enqueue_workforce_payout_dependency_refresh(new.company_id,new.adhoc_workforce_id,new.location_id,new.adhoc_work_date,new.adhoc_work_date,new.updated_by);
$old$, E'\r\n', E'\n');
  v_new text := replace($new$
      new.adhoc_workforce_id:=public.resolve_adhoc_paid_day_worker(new.company_id,new.location_id,new.adhoc_client,new.adhoc_provider_employee_id,new.adhoc_work_date);
      if new.adhoc_workforce_id is null or new.location_id is null or new.adhoc_work_date is null then
        raise exception 'Paid work-day Adhoc DA % has no Workforce mapping for this station and work date.', coalesce(nullif(btrim(new.request_no), ''), new.id::text);
      end if;
      if exists(select 1 from public.workforce_payout_effective_paid_allocations a where a.company_id=new.company_id and a.credited_workforce_id=new.adhoc_workforce_id
        and a.station_id=new.location_id and new.adhoc_work_date between a.period_start and a.period_end)
        or exists(select 1 from public.workforce_payroll_runs r join public.workforce_payroll_items i on i.payroll_run_id=r.id and i.company_id=r.company_id
          where r.company_id=new.company_id and i.workforce_id=new.adhoc_workforce_id and r.status in ('approved','paid') and i.status<>'excluded' and new.adhoc_work_date between r.period_start and r.period_end) then
        raise exception 'This work date is already in a finalized Workforce payout. Finance must review it before paying ad hoc';
      end if;
      perform public.workforce_bump_payout_period_dependency_revision(new.company_id,new.adhoc_work_date);
      perform public.enqueue_workforce_payout_dependency_refresh(new.company_id,new.adhoc_workforce_id,new.location_id,new.adhoc_work_date,new.adhoc_work_date,new.updated_by);
$new$, E'\r\n', E'\n');
begin
  select replace(pg_get_functiondef('public.payment_adhoc_da_guard()'::regprocedure), E'\r\n', E'\n')
    into v_definition;
  if position(v_old in v_definition) = 0 then
    if position('Paid work-day Adhoc DA' in v_definition) > 0 then
      return;
    end if;
    raise exception 'Unexpected payment_adhoc_da_guard paid-day block; migration stopped without changing it.';
  end if;
  execute replace(v_definition, v_old, v_new);
end
$patch_adhoc_guard$;

do $patch_partial_finalizer$
declare
  v_definition text;
  v_old text := replace($old$
        elsif v_error_message like 'Payroll payment % no longer belongs to this company.' then
          v_safe_error_message := 'This payroll payment is no longer available for finalization.';
        end if;
$old$, E'\r\n', E'\n');
  v_new text := replace($new$
        elsif v_error_message like 'Payroll payment % no longer belongs to this company.' then
          v_safe_error_message := 'This payroll payment is no longer available for finalization.';
        elsif v_error_message like 'Paid work-day Adhoc DA % has no Workforce mapping for this station and work date.' then
          v_safe_error_message := 'This paid work-day Adhoc DA has no Workforce mapping for its station and work date.';
        elsif v_error_message = 'A payout dependency refresh requires company, Workforce, location, and a valid effective period.' then
          v_safe_error_message := 'This payment cannot refresh Workforce payout dependencies because company, worker, location, or period is missing.';
        end if;
$new$, E'\r\n', E'\n');
begin
  if to_regprocedure(
    'public.finalize_central_bank_response_partially(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)'
  ) is null then
    return;
  end if;
  select replace(
    pg_get_functiondef(
      'public.finalize_central_bank_response_partially(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure
    ),
    E'\r\n',
    E'\n'
  ) into v_definition;
  if position('Paid work-day Adhoc DA % has no Workforce mapping for this station and work date.' in v_definition) > 0 then
    return;
  end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected partial bank finalizer exception map; migration stopped without changing it.';
  end if;
  execute replace(v_definition, v_old, v_new);
end
$patch_partial_finalizer$;

do $patch_advance_refresh$
declare
  v_definition text;
  v_old text := replace($old$
  if a.worker_type='workforce' and a.worker_id is not null then
    for location in select distinct station_id from public.workforce_payout_publications
      where company_id=a.company_id and workforce_id=a.worker_id and period_end>=a.first_due_period loop
$old$, E'\r\n', E'\n');
  v_new text := replace($new$
  if a.worker_type='workforce' and a.worker_id is not null and refresh_from is not null then
    for location in select distinct station_id from public.workforce_payout_publications
      where company_id=a.company_id and workforce_id=a.worker_id and period_end>=a.first_due_period and station_id is not null loop
$new$, E'\r\n', E'\n');
begin
  if to_regprocedure('public.pay_advance_queue_payout_refresh()') is null then
    return;
  end if;
  select replace(pg_get_functiondef('public.pay_advance_queue_payout_refresh()'::regprocedure), E'\r\n', E'\n')
    into v_definition;
  if position('refresh_from is not null' in v_definition) > 0
    and position('and station_id is not null loop' in v_definition) > 0 then
    return;
  end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected pay_advance_queue_payout_refresh body; migration stopped without changing it.';
  end if;
  execute replace(v_definition, v_old, v_new);
end
$patch_advance_refresh$;

revoke all on function public.resolve_adhoc_paid_day_worker(uuid,uuid,text,text,date),
  public.payment_adhoc_da_guard()
from public, anon, authenticated;
grant execute on function public.resolve_adhoc_paid_day_worker(uuid,uuid,text,text,date) to service_role;

comment on function public.resolve_adhoc_paid_day_worker(uuid,uuid,text,text,date) is
  'Resolves the Workforce identity for a paid work-day Adhoc DA. Prefers the request station mapping, then a company-unique provider-member match for the same client and day.';

notify pgrst, 'reload schema';
commit;
