begin;

alter table public.workforce_payroll_runs
  add column if not exists payout_input_snapshot_hash text;

create or replace function public.workforce_payout_input_snapshot_hash(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
)
returns text
language sql
security definer
set search_path = ''
as $function$
  select md5(coalesce(jsonb_agg(material.payload order by material.source_kind, material.id)::text, '[]'))
  from (
    select
      'attendance'::text as source_kind,
      item.id::text as id,
      jsonb_build_object(
        'id', item.id::text,
        'workforce_id', item.workforce_id::text,
        'station_id', item.station_id::text,
        'work_date', item.work_date,
        'attendance_status', item.attendance_status,
        'work_day_units', item.work_day_units,
        'work_minutes', item.work_minutes,
        'updated_at_epoch', extract(epoch from item.updated_at)
      ) as payload
    from public.workforce_payout_attendance_overrides item
    where item.company_id = p_company_id
      and item.work_date between p_period_start and p_period_end

    union all

    select
      'payment_field'::text,
      item.id::text,
      jsonb_build_object(
        'id', item.id::text,
        'workforce_id', item.workforce_id::text,
        'station_id', item.station_id::text,
        'payment_field_id', item.payment_field_id::text,
        'field_code_snapshot', item.field_code_snapshot,
        'effective_from', item.effective_from,
        'effective_to', item.effective_to,
        'input_value', item.input_value,
        'updated_at_epoch', extract(epoch from item.updated_at)
      )
    from public.workforce_payment_field_overrides item
    where item.company_id = p_company_id
      and daterange(item.effective_from, item.effective_to, '[]')
        && daterange(p_period_start, p_period_end, '[]')

    union all

    select
      'production'::text,
      item.id::text,
      jsonb_build_object(
        'id', item.id::text,
        'workforce_id', item.workforce_id::text,
        'station_id', item.station_id::text,
        'payment_field_id', item.payment_field_id::text,
        'field_code_snapshot', item.field_code_snapshot,
        'work_date', item.work_date,
        'units', item.units,
        'updated_at_epoch', extract(epoch from item.updated_at)
      )
    from public.workforce_custom_production_inputs item
    where item.company_id = p_company_id
      and item.work_date between p_period_start and p_period_end

    union all

    select
      'additional'::text,
      item.id::text,
      jsonb_build_object(
        'id', item.id::text,
        'workforce_id', item.workforce_id::text,
        'station_id', item.station_id::text,
        'additional_payment_field_id', item.additional_payment_field_id::text,
        'field_code_snapshot', item.field_code_snapshot,
        'field_name_snapshot', item.field_name_snapshot,
        'calculation_type_snapshot', item.calculation_type_snapshot,
        'effective_from', item.effective_from,
        'effective_to', item.effective_to,
        'input_value', item.input_value,
        'rate_value', item.rate_value,
        'final_amount', item.final_amount,
        'updated_at_epoch', extract(epoch from item.updated_at)
      )
    from public.workforce_additional_payment_values item
    where item.company_id = p_company_id
      and daterange(item.effective_from, item.effective_to, '[]')
        && daterange(p_period_start, p_period_end, '[]')
  ) material;
$function$;

create or replace function public.capture_workforce_payout_input_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.calculated_at is null then
    new.payout_input_snapshot_hash := null;
  else
    perform 1
    from public.workforce workforce
    where workforce.company_id = new.company_id
    order by workforce.id
    for update;

    perform public.lock_workforce_payment_allocation_company(new.company_id);

    new.payout_input_snapshot_hash := public.workforce_payout_input_snapshot_hash(
      new.company_id,
      new.period_start,
      new.period_end
    );
  end if;
  return new;
end;
$function$;

create or replace function public.guard_finalized_workforce_payroll_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if lower(coalesce(new.status, '')) <> 'draft' then
      raise exception 'A Workforce payroll run must be created in draft status.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if lower(coalesce(old.status, '')) in ('approved', 'paid') then
      raise exception 'An approved or paid Workforce payroll cannot be deleted or reopened.';
    end if;
    return old;
  end if;

  if lower(coalesce(old.status, '')) = 'paid'
    and lower(coalesce(new.status, '')) <> 'paid' then
    raise exception 'A paid Workforce payroll cannot be downgraded or reopened.';
  end if;

  if lower(coalesce(old.status, '')) = 'approved'
    and lower(coalesce(new.status, '')) not in ('approved', 'paid') then
    raise exception 'An approved Workforce payroll cannot be downgraded or reopened.';
  end if;

  if (
      lower(coalesce(old.status, '')) in ('approved', 'paid')
      or lower(coalesce(new.status, '')) in ('approved', 'paid')
    ) and (
      new.company_id is distinct from old.company_id
      or new.period_start is distinct from old.period_start
      or new.period_end is distinct from old.period_end
    ) then
    raise exception 'An approved or paid Workforce payroll period cannot be moved or reassigned.';
  end if;
  return new;
end;
$function$;

create or replace function public.guard_workforce_payout_input_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_snapshot_hash text;
begin
  if lower(coalesce(new.status, '')) in ('review', 'approved', 'paid')
    and new.status is distinct from old.status then
    if new.calculated_at is null or new.payout_input_snapshot_hash is null then
      raise exception 'Workforce payout inputs were not captured with this payroll calculation. Return to draft and recalculate before confirmation.';
    end if;

    perform public.lock_workforce_payment_allocation_company(new.company_id);
    v_snapshot_hash := public.workforce_payout_input_snapshot_hash(
      new.company_id,
      new.period_start,
      new.period_end
    );
    if v_snapshot_hash is distinct from new.payout_input_snapshot_hash then
      raise exception 'Workforce payout inputs changed after this payroll was calculated. Return to draft and recalculate before confirmation.';
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.guard_finalized_workforce_payout_input()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_company_id uuid;
  v_new_company_id uuid;
  v_old_workforce_id uuid;
  v_new_workforce_id uuid;
  v_old_from date;
  v_old_to date;
  v_new_from date;
  v_new_to date;
begin
  if tg_op <> 'INSERT' then
    v_old_company_id := old.company_id;
    v_old_workforce_id := old.workforce_id;
    if tg_table_name in ('workforce_payout_attendance_overrides', 'workforce_custom_production_inputs') then
      v_old_from := case when tg_table_name = 'workforce_payout_attendance_overrides' then old.work_date else old.work_date end;
      v_old_to := v_old_from;
    else
      v_old_from := old.effective_from;
      v_old_to := old.effective_to;
    end if;
  end if;

  if tg_op <> 'DELETE' then
    v_new_company_id := new.company_id;
    v_new_workforce_id := new.workforce_id;
    if tg_table_name in ('workforce_payout_attendance_overrides', 'workforce_custom_production_inputs') then
      v_new_from := case when tg_table_name = 'workforce_payout_attendance_overrides' then new.work_date else new.work_date end;
      v_new_to := v_new_from;
    else
      v_new_from := new.effective_from;
      v_new_to := new.effective_to;
    end if;
  end if;

  perform 1
  from public.workforce workforce
  where (workforce.company_id = v_old_company_id and workforce.id = v_old_workforce_id)
     or (workforce.company_id = v_new_company_id and workforce.id = v_new_workforce_id)
  order by workforce.company_id, workforce.id
  for update;

  if v_old_company_id is not null and (v_new_company_id is null or v_old_company_id::text <= v_new_company_id::text) then
    perform public.lock_workforce_payment_allocation_company(v_old_company_id);
    if v_new_company_id is not null and v_new_company_id is distinct from v_old_company_id then
      perform public.lock_workforce_payment_allocation_company(v_new_company_id);
    end if;
  elsif v_new_company_id is not null then
    perform public.lock_workforce_payment_allocation_company(v_new_company_id);
    if v_old_company_id is not null and v_old_company_id is distinct from v_new_company_id then
      perform public.lock_workforce_payment_allocation_company(v_old_company_id);
    end if;
  end if;

  if (v_old_company_id is not null and exists (
      select 1 from public.workforce_payroll_runs payroll_run
      where payroll_run.company_id = v_old_company_id
        and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
        and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
          && daterange(v_old_from, v_old_to, '[]')
    )) or (v_new_company_id is not null and exists (
      select 1 from public.workforce_payroll_runs payroll_run
      where payroll_run.company_id = v_new_company_id
        and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
        and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
          && daterange(v_new_from, v_new_to, '[]')
    )) then
    raise exception 'Workforce payout input cannot change because the affected period is approved or paid.';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$function$;

drop trigger if exists workforce_00_initial_status_guard on public.workforce_payroll_runs;
create trigger workforce_00_initial_status_guard
before insert on public.workforce_payroll_runs
for each row execute function public.guard_finalized_workforce_payroll_scope();

drop trigger if exists workforce_00_finalized_scope_guard on public.workforce_payroll_runs;
create trigger workforce_00_finalized_scope_guard
before update of company_id, period_start, period_end, status on public.workforce_payroll_runs
for each row execute function public.guard_finalized_workforce_payroll_scope();

drop trigger if exists workforce_00_finalized_delete_guard on public.workforce_payroll_runs;
create trigger workforce_00_finalized_delete_guard
before delete on public.workforce_payroll_runs
for each row execute function public.guard_finalized_workforce_payroll_scope();

drop trigger if exists workforce_02_payout_input_snapshot_insert on public.workforce_payroll_runs;
create trigger workforce_02_payout_input_snapshot_insert
before insert on public.workforce_payroll_runs
for each row execute function public.capture_workforce_payout_input_snapshot();

drop trigger if exists workforce_02_payout_input_snapshot_calculation on public.workforce_payroll_runs;
create trigger workforce_02_payout_input_snapshot_calculation
before update of calculated_at, company_id, period_start, period_end on public.workforce_payroll_runs
for each row execute function public.capture_workforce_payout_input_snapshot();

drop trigger if exists workforce_zy_payout_input_gate on public.workforce_payroll_runs;
create trigger workforce_zy_payout_input_gate
before update of status on public.workforce_payroll_runs
for each row execute function public.guard_workforce_payout_input_snapshot();

drop trigger if exists workforce_payout_attendance_overrides_finalized_guard on public.workforce_payout_attendance_overrides;
create trigger workforce_payout_attendance_overrides_finalized_guard
before insert or update or delete on public.workforce_payout_attendance_overrides
for each row execute function public.guard_finalized_workforce_payout_input();

drop trigger if exists workforce_payment_field_overrides_finalized_guard on public.workforce_payment_field_overrides;
create trigger workforce_payment_field_overrides_finalized_guard
before insert or update or delete on public.workforce_payment_field_overrides
for each row execute function public.guard_finalized_workforce_payout_input();

drop trigger if exists workforce_custom_production_inputs_finalized_guard on public.workforce_custom_production_inputs;
create trigger workforce_custom_production_inputs_finalized_guard
before insert or update or delete on public.workforce_custom_production_inputs
for each row execute function public.guard_finalized_workforce_payout_input();

update public.workforce_payroll_runs payroll_run
set payout_input_snapshot_hash = case
  when payroll_run.calculated_at is not null
    and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
  then public.workforce_payout_input_snapshot_hash(
    payroll_run.company_id,
    payroll_run.period_start,
    payroll_run.period_end
  )
  else null
end;

comment on column public.workforce_payroll_runs.payout_input_snapshot_hash is
  'Version of payout attendance, rate, custom-production, and additional-payment inputs captured at payroll calculation.';
comment on function public.guard_finalized_workforce_payout_input() is
  'Serializes payout input writes with payroll confirmation and locks only approved or paid periods; draft and review periods remain editable.';
comment on function public.guard_finalized_workforce_payroll_scope() is
  'Requires new payroll runs to begin in draft and prevents an approved or paid run from being downgraded, deleted, moved to another company, or moved to another date range. Approved may advance only to paid.';

revoke all on function public.workforce_payout_input_snapshot_hash(uuid, date, date),
  public.capture_workforce_payout_input_snapshot(),
  public.guard_finalized_workforce_payroll_scope(),
  public.guard_workforce_payout_input_snapshot(),
  public.guard_finalized_workforce_payout_input()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
