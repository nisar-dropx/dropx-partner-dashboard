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
  with active_at_start as (
    select
      setting.calculation_method,
      setting.paid_off_days,
      setting.work_units_per_paid_off,
      setting.cap_at_monthly_amount
    from public.workforce_payment_settings setting
    where setting.company_id = p_company_id
      and setting.effective_from <= p_period_start
    order by setting.effective_from desc
    limit 1
  ), relevant_raw as (
    select
      coalesce(active_at_start.calculation_method, 'calendar_days') as calculation_method,
      coalesce(active_at_start.paid_off_days, 4::smallint)::smallint as paid_off_days,
      coalesce(active_at_start.work_units_per_paid_off, 6::numeric)::numeric(5,2) as work_units_per_paid_off,
      coalesce(active_at_start.cap_at_monthly_amount, true) as cap_at_monthly_amount,
      p_period_start as effective_from
    from (select 1) seed
    left join active_at_start on true

    union all

    select
      setting.calculation_method,
      setting.paid_off_days,
      setting.work_units_per_paid_off,
      setting.cap_at_monthly_amount,
      setting.effective_from
    from public.workforce_payment_settings setting
    where setting.company_id = p_company_id
      and setting.effective_from > p_period_start
      and setting.effective_from <= p_period_end
  ), sequenced as (
    select
      relevant_raw.*,
      row_number() over (order by relevant_raw.effective_from) as sequence_number,
      lag(relevant_raw.calculation_method) over (order by relevant_raw.effective_from) as previous_method,
      lag(relevant_raw.paid_off_days) over (order by relevant_raw.effective_from) as previous_paid_off_days,
      lag(relevant_raw.work_units_per_paid_off) over (order by relevant_raw.effective_from) as previous_work_units_per_paid_off,
      lag(relevant_raw.cap_at_monthly_amount) over (order by relevant_raw.effective_from) as previous_cap_at_monthly_amount
    from relevant_raw
  ), relevant as (
    select *
    from sequenced
    where sequence_number = 1
      or (
        calculation_method,
        paid_off_days,
        work_units_per_paid_off,
        cap_at_monthly_amount
      ) is distinct from (
        previous_method,
        previous_paid_off_days,
        previous_work_units_per_paid_off,
        previous_cap_at_monthly_amount
      )
  )
  select md5(coalesce(
    jsonb_agg(
      jsonb_build_object(
        'calculation_method', relevant.calculation_method,
        'paid_off_days', relevant.paid_off_days,
        'work_units_per_paid_off', relevant.work_units_per_paid_off,
        'cap_at_monthly_amount', relevant.cap_at_monthly_amount,
        'effective_from', greatest(relevant.effective_from, p_period_start)
      )
      order by relevant.effective_from
    )::text,
    '[]'
  ))
  from relevant;
$$;

create or replace function public.workforce_payment_policy_matches_at(
  p_company_id uuid,
  p_effective_date date,
  p_calculation_method text,
  p_paid_off_days smallint,
  p_work_units_per_paid_off numeric,
  p_cap_at_monthly_amount boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_calculation_method text;
  v_paid_off_days smallint;
  v_work_units_per_paid_off numeric;
  v_cap_at_monthly_amount boolean;
begin
  select
    setting.calculation_method,
    setting.paid_off_days,
    setting.work_units_per_paid_off,
    setting.cap_at_monthly_amount
  into
    v_calculation_method,
    v_paid_off_days,
    v_work_units_per_paid_off,
    v_cap_at_monthly_amount
  from public.workforce_payment_settings setting
  where setting.company_id = p_company_id
    and setting.effective_from <= p_effective_date
  order by setting.effective_from desc
  limit 1;

  if not found then
    v_calculation_method := 'calendar_days';
    v_paid_off_days := 4;
    v_work_units_per_paid_off := 6;
    v_cap_at_monthly_amount := true;
  end if;

  return (
    v_calculation_method,
    v_paid_off_days,
    v_work_units_per_paid_off,
    v_cap_at_monthly_amount
  ) is not distinct from (
    p_calculation_method,
    p_paid_off_days,
    p_work_units_per_paid_off,
    p_cap_at_monthly_amount
  );
end;
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

    if exists (
      select 1
      from public.workforce_payroll_runs payroll_run
      where payroll_run.company_id = new.company_id
        and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
        and payroll_run.period_end >= new.effective_from
        and (v_new_until is null or payroll_run.period_start < v_new_until)
    ) and not public.workforce_payment_policy_matches_at(
      new.company_id,
      new.effective_from,
      new.calculation_method,
      new.paid_off_days,
      new.work_units_per_paid_off,
      new.cap_at_monthly_amount
    ) then
      raise exception 'Workforce payment policy cannot change because finalized payroll depends on its effective period.';
    end if;
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

create or replace function public.save_workforce_payment_setting(
  p_company_id uuid,
  p_calculation_method text,
  p_paid_off_days smallint,
  p_work_units_per_paid_off numeric,
  p_cap_at_monthly_amount boolean,
  p_effective_from date,
  p_change_reason text,
  p_actor_user_id uuid
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_next_effective_from date;
  v_preserve_from date;
  v_old_calculation_method text;
  v_old_paid_off_days smallint;
  v_old_work_units_per_paid_off numeric;
  v_old_cap_at_monthly_amount boolean;
  v_saved_id bigint;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and acting user are required.';
  end if;
  if p_effective_from is null
    or p_effective_from <> date_trunc('month', p_effective_from)::date then
    raise exception 'Choose a valid effective month.';
  end if;
  if p_calculation_method not in ('calendar_days', 'fixed_paid_offs', 'earned_paid_offs') then
    raise exception 'Choose a valid workforce payment calculation method.';
  end if;
  if char_length(btrim(coalesce(p_change_reason, ''))) not between 3 and 250 then
    raise exception 'Change reason must be from 3 to 250 characters.';
  end if;

  perform public.lock_workforce_payment_allocation_company(p_company_id);

  if exists (
    select 1
    from public.workforce_payroll_runs payroll_run
    where payroll_run.company_id = p_company_id
      and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
      and payroll_run.period_end >= p_effective_from
      and payroll_run.period_start < (p_effective_from + interval '1 month')::date
  ) then
    raise exception 'Workforce payment policy cannot change because payroll for this month is finalized.';
  end if;

  select
    setting.calculation_method,
    setting.paid_off_days,
    setting.work_units_per_paid_off,
    setting.cap_at_monthly_amount
  into
    v_old_calculation_method,
    v_old_paid_off_days,
    v_old_work_units_per_paid_off,
    v_old_cap_at_monthly_amount
  from public.workforce_payment_settings setting
  where setting.company_id = p_company_id
    and setting.effective_from <= p_effective_from
  order by setting.effective_from desc
  limit 1;

  if not found then
    v_old_calculation_method := 'calendar_days';
    v_old_paid_off_days := 4;
    v_old_work_units_per_paid_off := 6;
    v_old_cap_at_monthly_amount := true;
  end if;

  select min(setting.effective_from)
  into v_next_effective_from
  from public.workforce_payment_settings setting
  where setting.company_id = p_company_id
    and setting.effective_from > p_effective_from;

  select min(date_trunc('month', payroll_run.period_start)::date)
  into v_preserve_from
  from public.workforce_payroll_runs payroll_run
  where payroll_run.company_id = p_company_id
    and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
    and date_trunc('month', payroll_run.period_start)::date > p_effective_from
    and (v_next_effective_from is null or payroll_run.period_start < v_next_effective_from);

  if v_preserve_from is not null then
    insert into public.workforce_payment_settings (
      company_id,
      calculation_method,
      paid_off_days,
      work_units_per_paid_off,
      cap_at_monthly_amount,
      effective_from,
      change_reason,
      created_by,
      updated_by
    ) values (
      p_company_id,
      v_old_calculation_method,
      v_old_paid_off_days,
      v_old_work_units_per_paid_off,
      v_old_cap_at_monthly_amount,
      v_preserve_from,
      'System preserved the policy used by finalized payroll.',
      p_actor_user_id,
      p_actor_user_id
    ) on conflict (company_id, effective_from) do nothing;
  end if;

  insert into public.workforce_payment_settings (
    company_id,
    calculation_method,
    paid_off_days,
    work_units_per_paid_off,
    cap_at_monthly_amount,
    effective_from,
    change_reason,
    created_by,
    updated_by
  ) values (
    p_company_id,
    p_calculation_method,
    p_paid_off_days,
    p_work_units_per_paid_off,
    p_cap_at_monthly_amount,
    p_effective_from,
    btrim(p_change_reason),
    p_actor_user_id,
    p_actor_user_id
  ) on conflict (company_id, effective_from) do update set
    calculation_method = excluded.calculation_method,
    paid_off_days = excluded.paid_off_days,
    work_units_per_paid_off = excluded.work_units_per_paid_off,
    cap_at_monthly_amount = excluded.cap_at_monthly_amount,
    change_reason = excluded.change_reason,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning id into v_saved_id;

  return v_saved_id;
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
  'Protects finalized payroll intervals while allowing semantically identical preservation boundaries.';
comment on function public.save_workforce_payment_setting(uuid, text, smallint, numeric, boolean, date, text, uuid) is
  'Atomically saves an open month and restores the prior policy at the first later finalized month when required.';
comment on function public.workforce_payment_policy_snapshot_hash(uuid, date, date) is
  'Deterministic hash of Workforce payment settings that apply during one payroll period.';
comment on function public.guard_workforce_payment_policy_snapshot() is
  'Requires payroll recalculation when Workforce payment settings changed after calculation.';

revoke all on function public.workforce_payment_policy_snapshot_hash(uuid, date, date),
  public.workforce_payment_policy_matches_at(uuid, date, text, smallint, numeric, boolean),
  public.capture_workforce_payment_policy_snapshot(),
  public.guard_workforce_payment_policy_snapshot(),
  public.assert_workforce_payment_policy_interval_open(uuid, date, date),
  public.guard_finalized_workforce_payment_setting(),
  public.save_workforce_payment_setting(uuid, text, smallint, numeric, boolean, date, text, uuid)
  from public, anon, authenticated;

grant execute on function public.workforce_payment_policy_snapshot_hash(uuid, date, date),
  public.workforce_payment_policy_matches_at(uuid, date, text, smallint, numeric, boolean),
  public.capture_workforce_payment_policy_snapshot(),
  public.guard_workforce_payment_policy_snapshot(),
  public.assert_workforce_payment_policy_interval_open(uuid, date, date),
  public.guard_finalized_workforce_payment_setting(),
  public.save_workforce_payment_setting(uuid, text, smallint, numeric, boolean, date, text, uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
