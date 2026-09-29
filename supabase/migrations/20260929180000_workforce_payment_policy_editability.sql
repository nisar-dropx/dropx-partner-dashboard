begin;

alter table public.workforce_payroll_runs
  add column if not exists workforce_payment_policy_snapshot_hash text;

create or replace function public.workforce_payment_policy_snapshot_hash(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
)
returns text
language sql
security definer
set search_path = ''
as $$
  with relevant as (
    select
      setting.id,
      setting.calculation_method,
      setting.paid_off_days,
      setting.work_units_per_paid_off,
      setting.cap_at_monthly_amount,
      setting.effective_from
    from public.workforce_payment_settings setting
    where setting.company_id = p_company_id
      and (
        setting.effective_from = (
          select max(active.effective_from)
          from public.workforce_payment_settings active
          where active.company_id = p_company_id
            and active.effective_from <= p_period_start
        )
        or (
          setting.effective_from > p_period_start
          and setting.effective_from <= p_period_end
        )
      )
  )
  select md5(coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', relevant.id,
        'calculation_method', relevant.calculation_method,
        'paid_off_days', relevant.paid_off_days,
        'work_units_per_paid_off', relevant.work_units_per_paid_off,
        'cap_at_monthly_amount', relevant.cap_at_monthly_amount,
        'effective_from', relevant.effective_from
      )
      order by relevant.effective_from, relevant.id
    )::text,
    '[]'
  ))
  from relevant;
$$;

create or replace function public.capture_workforce_payment_policy_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.calculated_at is null then
    new.workforce_payment_policy_snapshot_hash := null;
  else
    perform public.lock_workforce_payment_allocation_company(new.company_id);
    new.workforce_payment_policy_snapshot_hash := public.workforce_payment_policy_snapshot_hash(
      new.company_id,
      new.period_start,
      new.period_end
    );
  end if;
  return new;
end;
$$;

create or replace function public.guard_workforce_payment_policy_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snapshot_hash text;
begin
  if lower(coalesce(new.status, '')) in ('review', 'approved', 'paid')
    and new.status is distinct from old.status then
    if new.calculated_at is null or new.workforce_payment_policy_snapshot_hash is null then
      raise exception 'Workforce payment policy changed after this payroll was calculated. Recalculate the payroll before confirmation.';
    end if;

    -- The existing workforce_adhoc_payroll_gate trigger sorts before this one
    -- and acquires the same company mutex after locking Workforce identities.
    perform public.lock_workforce_payment_allocation_company(new.company_id);
    v_snapshot_hash := public.workforce_payment_policy_snapshot_hash(
      new.company_id,
      new.period_start,
      new.period_end
    );

    if v_snapshot_hash is distinct from new.workforce_payment_policy_snapshot_hash then
      raise exception 'Workforce payment policy changed after this payroll was calculated. Recalculate the payroll before confirmation.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.assert_workforce_payment_policy_interval_open(
  p_company_id uuid,
  p_effective_from date,
  p_effective_until date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.workforce_payroll_runs payroll_run
    where payroll_run.company_id = p_company_id
      and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
      and payroll_run.period_end >= p_effective_from
      and (p_effective_until is null or payroll_run.period_start < p_effective_until)
  ) then
    raise exception 'Workforce payment policy cannot change because finalized payroll depends on its effective period.';
  end if;
end;
$$;

create or replace function public.guard_finalized_workforce_payment_setting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_until date;
  v_new_until date;
begin
  if tg_op = 'INSERT' then
    perform public.lock_workforce_payment_allocation_company(new.company_id);

    select min(setting.effective_from)
    into v_new_until
    from public.workforce_payment_settings setting
    where setting.company_id = new.company_id
      and setting.effective_from > new.effective_from;

    perform public.assert_workforce_payment_policy_interval_open(
      new.company_id,
      new.effective_from,
      v_new_until
    );
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform public.lock_workforce_payment_allocation_company(old.company_id);

    select min(setting.effective_from)
    into v_old_until
    from public.workforce_payment_settings setting
    where setting.company_id = old.company_id
      and setting.id <> old.id
      and setting.effective_from > old.effective_from;

    perform public.assert_workforce_payment_policy_interval_open(
      old.company_id,
      old.effective_from,
      v_old_until
    );
    return old;
  end if;

  if old.company_id::text <= new.company_id::text then
    perform public.lock_workforce_payment_allocation_company(old.company_id);
    if new.company_id is distinct from old.company_id then
      perform public.lock_workforce_payment_allocation_company(new.company_id);
    end if;
  else
    perform public.lock_workforce_payment_allocation_company(new.company_id);
    perform public.lock_workforce_payment_allocation_company(old.company_id);
  end if;

  select min(setting.effective_from)
  into v_old_until
  from public.workforce_payment_settings setting
  where setting.company_id = old.company_id
    and setting.id <> old.id
    and setting.effective_from > old.effective_from;

  select min(setting.effective_from)
  into v_new_until
  from public.workforce_payment_settings setting
  where setting.company_id = new.company_id
    and setting.id <> old.id
    and setting.effective_from > new.effective_from;

  perform public.assert_workforce_payment_policy_interval_open(
    old.company_id,
    old.effective_from,
    v_old_until
  );
  perform public.assert_workforce_payment_policy_interval_open(
    new.company_id,
    new.effective_from,
    v_new_until
  );
  return new;
end;
$$;

drop trigger if exists workforce_01_payment_policy_snapshot_insert
  on public.workforce_payroll_runs;
create trigger workforce_01_payment_policy_snapshot_insert
before insert
on public.workforce_payroll_runs
for each row execute function public.capture_workforce_payment_policy_snapshot();

drop trigger if exists workforce_01_payment_policy_snapshot_calculation
  on public.workforce_payroll_runs;
create trigger workforce_01_payment_policy_snapshot_calculation
before update of calculated_at, company_id, period_start, period_end
on public.workforce_payroll_runs
for each row execute function public.capture_workforce_payment_policy_snapshot();

drop trigger if exists workforce_zz_payment_policy_gate
  on public.workforce_payroll_runs;
create trigger workforce_zz_payment_policy_gate
before update of status
on public.workforce_payroll_runs
for each row execute function public.guard_workforce_payment_policy_snapshot();

-- Finalized runs are immutable, so recording the policy version that currently
-- explains them is safe. Mutable calculated runs must be recalculated once.
update public.workforce_payroll_runs payroll_run
set workforce_payment_policy_snapshot_hash = case
  when payroll_run.calculated_at is not null
    and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
  then public.workforce_payment_policy_snapshot_hash(
    payroll_run.company_id,
    payroll_run.period_start,
    payroll_run.period_end
  )
  else null
end;

comment on column public.workforce_payroll_runs.workforce_payment_policy_snapshot_hash is
  'Attendance-based monthly payment policy version captured at payroll calculation.';
comment on function public.guard_finalized_workforce_payment_setting() is
  'Allows effective-dated policy changes until an approved or paid payroll depends on any part of the affected interval.';
comment on function public.workforce_payment_policy_snapshot_hash(uuid, date, date) is
  'Deterministic hash of Workforce payment settings that apply during one payroll period.';
comment on function public.guard_workforce_payment_policy_snapshot() is
  'Requires payroll recalculation when Workforce payment settings changed after calculation.';

revoke all on function public.workforce_payment_policy_snapshot_hash(uuid, date, date),
  public.capture_workforce_payment_policy_snapshot(),
  public.guard_workforce_payment_policy_snapshot(),
  public.assert_workforce_payment_policy_interval_open(uuid, date, date),
  public.guard_finalized_workforce_payment_setting()
  from public, anon, authenticated;

grant execute on function public.workforce_payment_policy_snapshot_hash(uuid, date, date),
  public.capture_workforce_payment_policy_snapshot(),
  public.guard_workforce_payment_policy_snapshot(),
  public.assert_workforce_payment_policy_interval_open(uuid, date, date),
  public.guard_finalized_workforce_payment_setting()
  to service_role;

notify pgrst, 'reload schema';

commit;
