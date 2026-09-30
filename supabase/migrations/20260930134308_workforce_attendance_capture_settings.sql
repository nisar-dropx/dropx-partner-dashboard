begin;

set local lock_timeout = '15s';
set local statement_timeout = '60s';

create table public.workforce_attendance_capture_settings (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  capture_method text not null default 'biometric',
  minimum_daily_deliveries integer,
  effective_from date not null,
  change_reason text not null,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_attendance_capture_settings_company_month_key
    unique (company_id, effective_from),
  constraint workforce_attendance_capture_settings_method_check check (
    capture_method in ('biometric', 'shipment_data')
  ),
  constraint workforce_attendance_capture_settings_threshold_check check (
    (capture_method = 'biometric' and minimum_daily_deliveries is null)
    or
    (capture_method = 'shipment_data' and minimum_daily_deliveries > 0)
  ),
  constraint workforce_attendance_capture_settings_month_start_check check (
    effective_from = date_trunc('month', effective_from)::date
  ),
  constraint workforce_attendance_capture_settings_reason_check check (
    char_length(btrim(change_reason)) between 3 and 250
  )
);

comment on table public.workforce_attendance_capture_settings is
  'Effective-dated company policy selecting biometric or shipment-delivery attendance for Workforce pay.';
comment on column public.workforce_attendance_capture_settings.minimum_daily_deliveries is
  'Inclusive delivered-shipment threshold. Required only when capture_method is shipment_data.';

create index workforce_attendance_capture_settings_created_by_idx
  on public.workforce_attendance_capture_settings(created_by)
  where created_by is not null;
create index workforce_attendance_capture_settings_updated_by_idx
  on public.workforce_attendance_capture_settings(updated_by)
  where updated_by is not null;

alter table public.workforce_attendance_capture_settings enable row level security;

revoke all on table public.workforce_attendance_capture_settings
  from public, anon, authenticated;
revoke all on sequence public.workforce_attendance_capture_settings_id_seq
  from public, anon, authenticated;
grant select, insert, update on table public.workforce_attendance_capture_settings
  to service_role;
grant usage, select on sequence public.workforce_attendance_capture_settings_id_seq
  to service_role;

create table public.workforce_attendance_capture_setting_history (
  id bigint generated always as identity primary key,
  setting_id bigint not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  effective_from date not null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  changed_by uuid references auth.users(id) on delete set null,
  before_data jsonb,
  after_data jsonb,
  changed_at timestamptz not null default now(),
  constraint workforce_attendance_capture_history_payload_check check (
    before_data is not null or after_data is not null
  )
);

comment on table public.workforce_attendance_capture_setting_history is
  'Immutable row-level audit trail for Workforce attendance-capture setting changes. setting_id remains as a historical identifier after deletion.';

create index workforce_attendance_capture_history_company_period_idx
  on public.workforce_attendance_capture_setting_history(
    company_id,
    effective_from,
    changed_at desc
  );
create index workforce_attendance_capture_history_setting_idx
  on public.workforce_attendance_capture_setting_history(setting_id, changed_at desc);
create index workforce_attendance_capture_history_changed_by_idx
  on public.workforce_attendance_capture_setting_history(changed_by)
  where changed_by is not null;

alter table public.workforce_attendance_capture_setting_history enable row level security;

revoke all on table public.workforce_attendance_capture_setting_history
  from public, anon, authenticated;
revoke all on sequence public.workforce_attendance_capture_setting_history_id_seq
  from public, anon, authenticated;
grant select, insert on table public.workforce_attendance_capture_setting_history
  to service_role;
grant usage, select on sequence public.workforce_attendance_capture_setting_history_id_seq
  to service_role;

create or replace function public.touch_workforce_attendance_capture_setting()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create or replace function public.audit_workforce_attendance_capture_setting()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.workforce_attendance_capture_setting_history (
    setting_id,
    company_id,
    effective_from,
    operation,
    changed_by,
    before_data,
    after_data
  ) values (
    case when tg_op = 'DELETE' then old.id else new.id end,
    case when tg_op = 'DELETE' then old.company_id else new.company_id end,
    case when tg_op = 'DELETE' then old.effective_from else new.effective_from end,
    lower(tg_op),
    case when tg_op = 'DELETE' then old.updated_by else new.updated_by end,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.workforce_attendance_capture_setting_matches_at(
  p_company_id uuid,
  p_effective_date date,
  p_capture_method text,
  p_minimum_daily_deliveries integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capture_method text;
  v_minimum_daily_deliveries integer;
begin
  select
    setting.capture_method,
    setting.minimum_daily_deliveries
  into
    v_capture_method,
    v_minimum_daily_deliveries
  from public.workforce_attendance_capture_settings setting
  where setting.company_id = p_company_id
    and setting.effective_from <= p_effective_date
  order by setting.effective_from desc
  limit 1;

  if not found then
    v_capture_method := 'biometric';
    v_minimum_daily_deliveries := null;
  end if;

  return (
    v_capture_method,
    v_minimum_daily_deliveries
  ) is not distinct from (
    p_capture_method,
    p_minimum_daily_deliveries
  );
end;
$$;

create or replace function public.assert_workforce_attendance_capture_interval_open(
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
    raise exception 'Attendance capture cannot change because finalized payroll depends on its effective period.';
  end if;
end;
$$;

create or replace function public.guard_finalized_workforce_attendance_capture_setting()
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
    from public.workforce_attendance_capture_settings setting
    where setting.company_id = new.company_id
      and setting.effective_from > new.effective_from;

    if exists (
      select 1
      from public.workforce_payroll_runs payroll_run
      where payroll_run.company_id = new.company_id
        and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
        and payroll_run.period_end >= new.effective_from
        and (v_new_until is null or payroll_run.period_start < v_new_until)
    ) and not public.workforce_attendance_capture_setting_matches_at(
      new.company_id,
      new.effective_from,
      new.capture_method,
      new.minimum_daily_deliveries
    ) then
      raise exception 'Attendance capture cannot change because finalized payroll depends on its effective period.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform public.lock_workforce_payment_allocation_company(old.company_id);

    select min(setting.effective_from)
    into v_old_until
    from public.workforce_attendance_capture_settings setting
    where setting.company_id = old.company_id
      and setting.id <> old.id
      and setting.effective_from > old.effective_from;

    perform public.assert_workforce_attendance_capture_interval_open(
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
  from public.workforce_attendance_capture_settings setting
  where setting.company_id = old.company_id
    and setting.id <> old.id
    and setting.effective_from > old.effective_from;

  select min(setting.effective_from)
  into v_new_until
  from public.workforce_attendance_capture_settings setting
  where setting.company_id = new.company_id
    and setting.id <> old.id
    and setting.effective_from > new.effective_from;

  perform public.assert_workforce_attendance_capture_interval_open(
    old.company_id,
    old.effective_from,
    v_old_until
  );
  perform public.assert_workforce_attendance_capture_interval_open(
    new.company_id,
    new.effective_from,
    v_new_until
  );
  return new;
end;
$$;

create or replace function public.save_workforce_attendance_capture_setting(
  p_company_id uuid,
  p_capture_method text,
  p_minimum_daily_deliveries integer,
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
  v_old_capture_method text;
  v_old_minimum_daily_deliveries integer;
  v_saved_id bigint;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and acting user are required.';
  end if;
  if p_effective_from is null
    or p_effective_from <> date_trunc('month', p_effective_from)::date then
    raise exception 'Choose a valid effective month.';
  end if;
  if p_capture_method not in ('biometric', 'shipment_data') then
    raise exception 'Choose biometric or shipment data for attendance capture.';
  end if;
  if p_capture_method = 'biometric' and p_minimum_daily_deliveries is not null then
    raise exception 'A shipment threshold applies only to shipment-data attendance.';
  end if;
  if p_capture_method = 'shipment_data'
    and (p_minimum_daily_deliveries is null or p_minimum_daily_deliveries <= 0) then
    raise exception 'Shipment-data attendance requires a positive daily delivery threshold.';
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
    raise exception 'Attendance capture cannot change because payroll for this month is finalized.';
  end if;

  select
    setting.capture_method,
    setting.minimum_daily_deliveries
  into
    v_old_capture_method,
    v_old_minimum_daily_deliveries
  from public.workforce_attendance_capture_settings setting
  where setting.company_id = p_company_id
    and setting.effective_from <= p_effective_from
  order by setting.effective_from desc
  limit 1;

  if not found then
    v_old_capture_method := 'biometric';
    v_old_minimum_daily_deliveries := null;
  end if;

  select min(setting.effective_from)
  into v_next_effective_from
  from public.workforce_attendance_capture_settings setting
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
    insert into public.workforce_attendance_capture_settings (
      company_id,
      capture_method,
      minimum_daily_deliveries,
      effective_from,
      change_reason,
      created_by,
      updated_by
    ) values (
      p_company_id,
      v_old_capture_method,
      v_old_minimum_daily_deliveries,
      v_preserve_from,
      'System preserved attendance capture used by finalized payroll.',
      p_actor_user_id,
      p_actor_user_id
    ) on conflict (company_id, effective_from) do nothing;
  end if;

  insert into public.workforce_attendance_capture_settings (
    company_id,
    capture_method,
    minimum_daily_deliveries,
    effective_from,
    change_reason,
    created_by,
    updated_by
  ) values (
    p_company_id,
    p_capture_method,
    p_minimum_daily_deliveries,
    p_effective_from,
    btrim(p_change_reason),
    p_actor_user_id,
    p_actor_user_id
  ) on conflict (company_id, effective_from) do update set
    capture_method = excluded.capture_method,
    minimum_daily_deliveries = excluded.minimum_daily_deliveries,
    change_reason = excluded.change_reason,
    updated_by = excluded.updated_by
  returning id into v_saved_id;

  return v_saved_id;
end;
$$;

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
  with payment_active_at_start as (
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
  ), payment_relevant_raw as (
    select
      coalesce(active.calculation_method, 'calendar_days') as calculation_method,
      coalesce(active.paid_off_days, 4::smallint)::smallint as paid_off_days,
      coalesce(active.work_units_per_paid_off, 6::numeric)::numeric(5,2) as work_units_per_paid_off,
      coalesce(active.cap_at_monthly_amount, true) as cap_at_monthly_amount,
      p_period_start as effective_from
    from (select 1) seed
    left join payment_active_at_start active on true

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
  ), payment_sequenced as (
    select
      payment_relevant_raw.*,
      row_number() over (order by payment_relevant_raw.effective_from) as sequence_number,
      lag(payment_relevant_raw.calculation_method) over (order by payment_relevant_raw.effective_from) as previous_method,
      lag(payment_relevant_raw.paid_off_days) over (order by payment_relevant_raw.effective_from) as previous_paid_off_days,
      lag(payment_relevant_raw.work_units_per_paid_off) over (order by payment_relevant_raw.effective_from) as previous_work_units_per_paid_off,
      lag(payment_relevant_raw.cap_at_monthly_amount) over (order by payment_relevant_raw.effective_from) as previous_cap_at_monthly_amount
    from payment_relevant_raw
  ), payment_relevant as (
    select *
    from payment_sequenced
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
  ), payment_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'calculation_method', payment_relevant.calculation_method,
          'paid_off_days', payment_relevant.paid_off_days,
          'work_units_per_paid_off', payment_relevant.work_units_per_paid_off,
          'cap_at_monthly_amount', payment_relevant.cap_at_monthly_amount,
          'effective_from', greatest(payment_relevant.effective_from, p_period_start)
        )
        order by payment_relevant.effective_from
      ),
      '[]'::jsonb
    ) as value
    from payment_relevant
  ), attendance_active_at_start as (
    select
      setting.capture_method,
      setting.minimum_daily_deliveries
    from public.workforce_attendance_capture_settings setting
    where setting.company_id = p_company_id
      and setting.effective_from <= p_period_start
    order by setting.effective_from desc
    limit 1
  ), attendance_relevant_raw as (
    select
      coalesce(active.capture_method, 'biometric') as capture_method,
      active.minimum_daily_deliveries,
      p_period_start as effective_from
    from (select 1) seed
    left join attendance_active_at_start active on true

    union all

    select
      setting.capture_method,
      setting.minimum_daily_deliveries,
      setting.effective_from
    from public.workforce_attendance_capture_settings setting
    where setting.company_id = p_company_id
      and setting.effective_from > p_period_start
      and setting.effective_from <= p_period_end
  ), attendance_sequenced as (
    select
      attendance_relevant_raw.*,
      row_number() over (order by attendance_relevant_raw.effective_from) as sequence_number,
      lag(attendance_relevant_raw.capture_method) over (order by attendance_relevant_raw.effective_from) as previous_method,
      lag(attendance_relevant_raw.minimum_daily_deliveries) over (order by attendance_relevant_raw.effective_from) as previous_threshold
    from attendance_relevant_raw
  ), attendance_relevant as (
    select *
    from attendance_sequenced
    where sequence_number = 1
      or (
        capture_method,
        minimum_daily_deliveries
      ) is distinct from (
        previous_method,
        previous_threshold
      )
  ), attendance_payload as (
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'capture_method', attendance_relevant.capture_method,
            'minimum_daily_deliveries', attendance_relevant.minimum_daily_deliveries,
            'effective_from', greatest(attendance_relevant.effective_from, p_period_start)
          )
          order by attendance_relevant.effective_from
        ),
        '[]'::jsonb
      ) as value,
      coalesce(bool_or(
        attendance_relevant.capture_method <> 'biometric'
        or attendance_relevant.minimum_daily_deliveries is not null
      ), false) as has_non_default
    from attendance_relevant
  )
  select md5(
    case
      when attendance_payload.has_non_default then jsonb_build_object(
        'attendance_capture', attendance_payload.value,
        'workforce_payment', payment_payload.value
      )::text
      else payment_payload.value::text
    end
  )
  from payment_payload
  cross join attendance_payload;
$$;

drop trigger if exists workforce_attendance_capture_setting_touch
  on public.workforce_attendance_capture_settings;
create trigger workforce_attendance_capture_setting_touch
before update on public.workforce_attendance_capture_settings
for each row execute function public.touch_workforce_attendance_capture_setting();

drop trigger if exists workforce_attendance_capture_setting_finalized_guard
  on public.workforce_attendance_capture_settings;
create trigger workforce_attendance_capture_setting_finalized_guard
before insert or update or delete on public.workforce_attendance_capture_settings
for each row execute function public.guard_finalized_workforce_attendance_capture_setting();

drop trigger if exists workforce_attendance_capture_setting_audit
  on public.workforce_attendance_capture_settings;
create trigger workforce_attendance_capture_setting_audit
after insert or update or delete on public.workforce_attendance_capture_settings
for each row execute function public.audit_workforce_attendance_capture_setting();

comment on function public.save_workforce_attendance_capture_setting(uuid, text, integer, date, text, uuid) is
  'Atomically saves one open attendance-capture month and preserves the prior method at the first later finalized month when required.';
comment on function public.guard_finalized_workforce_attendance_capture_setting() is
  'Protects attendance-capture intervals used by approved or paid Workforce payroll.';
comment on function public.workforce_payment_policy_snapshot_hash(uuid, date, date) is
  'Deterministic hash of Workforce payment and non-default attendance-capture settings for a payroll period; biometric defaults retain the legacy hash.';

revoke all on function public.touch_workforce_attendance_capture_setting(),
  public.audit_workforce_attendance_capture_setting(),
  public.workforce_attendance_capture_setting_matches_at(uuid, date, text, integer),
  public.assert_workforce_attendance_capture_interval_open(uuid, date, date),
  public.guard_finalized_workforce_attendance_capture_setting(),
  public.save_workforce_attendance_capture_setting(uuid, text, integer, date, text, uuid)
  from public, anon, authenticated;

grant execute on function public.touch_workforce_attendance_capture_setting(),
  public.audit_workforce_attendance_capture_setting(),
  public.workforce_attendance_capture_setting_matches_at(uuid, date, text, integer),
  public.assert_workforce_attendance_capture_interval_open(uuid, date, date),
  public.guard_finalized_workforce_attendance_capture_setting(),
  public.save_workforce_attendance_capture_setting(uuid, text, integer, date, text, uuid)
  to service_role;

revoke all on function public.workforce_payment_policy_snapshot_hash(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_payment_policy_snapshot_hash(uuid, date, date)
  to service_role;

notify pgrst, 'reload schema';

commit;
