begin;

create or replace function public.guard_finalized_workforce_payment_allocation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old_range daterange;
  v_new_range daterange;
  v_definition_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'cancelled'
      and exists (
        select 1
        from public.workforce_payroll_runs payroll_run
        where payroll_run.company_id = new.company_id
          and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
          and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
            && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
      ) then
      raise exception 'Finalized Workforce payroll exists for this period. Start the direct payment allocation after the approved or paid payroll period.';
    end if;
    return new;
  end if;

  v_old_range := daterange(old.effective_from, coalesce(old.effective_to, 'infinity'::date), '[]');

  if tg_op = 'DELETE' then
    if old.status <> 'cancelled'
      and exists (
        select 1
        from public.workforce_payroll_runs payroll_run
        where payroll_run.company_id = old.company_id
          and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
          and daterange(payroll_run.period_start, payroll_run.period_end, '[]') && v_old_range
      ) then
      raise exception 'Finalized Workforce payroll uses this direct payment allocation. Keep the history row and create a later effective-dated change.';
    end if;
    return old;
  end if;

  v_new_range := daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]');
  v_definition_changed := row(
    new.company_id,
    new.workforce_id,
    new.station_id,
    new.station_code_snapshot,
    new.designation_id,
    new.designation_code_snapshot,
    new.designation_name_snapshot,
    new.payment_method_id,
    new.payment_values,
    new.payment_components,
    new.effective_from
  ) is distinct from row(
    old.company_id,
    old.workforce_id,
    old.station_id,
    old.station_code_snapshot,
    old.designation_id,
    old.designation_code_snapshot,
    old.designation_name_snapshot,
    old.payment_method_id,
    old.payment_values,
    old.payment_components,
    old.effective_from
  );

  if v_definition_changed
    and (
      (old.status <> 'cancelled' and exists (
        select 1
        from public.workforce_payroll_runs payroll_run
        where payroll_run.company_id = old.company_id
          and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
          and daterange(payroll_run.period_start, payroll_run.period_end, '[]') && v_old_range
      ))
      or
      (new.status <> 'cancelled' and exists (
        select 1
        from public.workforce_payroll_runs payroll_run
        where payroll_run.company_id = new.company_id
          and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
          and daterange(payroll_run.period_start, payroll_run.period_end, '[]') && v_new_range
      ))
    ) then
    raise exception 'Finalized Workforce payroll uses this direct payment allocation. Create a later effective-dated version instead of changing historical payment terms.';
  end if;

  if exists (
    select 1
    from public.workforce_payroll_runs payroll_run
    where lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
      and payroll_run.company_id in (old.company_id, new.company_id)
      and (
        case
          when payroll_run.company_id = old.company_id
            and old.status <> 'cancelled'
            and daterange(payroll_run.period_start, payroll_run.period_end, '[]') && v_old_range
          then daterange(payroll_run.period_start, payroll_run.period_end, '[]') * v_old_range
          else 'empty'::daterange
        end
      ) is distinct from (
        case
          when payroll_run.company_id = new.company_id
            and new.status <> 'cancelled'
            and daterange(payroll_run.period_start, payroll_run.period_end, '[]') && v_new_range
          then daterange(payroll_run.period_start, payroll_run.period_end, '[]') * v_new_range
          else 'empty'::daterange
        end
      )
  ) then
    raise exception 'Finalized Workforce payroll uses this allocation period. End or cancel it only after the approved or paid payroll period.';
  end if;

  return new;
end;
$$;

drop trigger if exists workforce_payment_allocations_finalized_guard
  on public.workforce_payment_allocations;
create trigger workforce_payment_allocations_finalized_guard
before insert or update or delete
on public.workforce_payment_allocations
for each row execute function public.guard_finalized_workforce_payment_allocation();

comment on function public.guard_finalized_workforce_payment_allocation() is
  'Prevents a direct-pay allocation from retroactively changing a company pay period after Workforce marks its payroll approved or paid. Draft and review runs remain correctable.';

revoke all on function public.guard_finalized_workforce_payment_allocation()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
