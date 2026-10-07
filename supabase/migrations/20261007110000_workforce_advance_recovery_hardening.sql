begin;

-- This revision is the material version of every database input consumed by
-- loadWorkforcePayoutRows when it calculates the amount available for an
-- advance recovery.  Dependency writers bump it while holding the same
-- company advisory lock that the recovery RPC holds from validation to commit.
-- Consequently a writer either commits (and bumps) before recovery validation,
-- or is serialized after the recovery; it cannot commit an unversioned change
-- through the validation window.
create table public.workforce_payout_dependency_revisions (
  company_id uuid primary key references public.companies(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

alter table public.workforce_payout_dependency_revisions enable row level security;
revoke all on table public.workforce_payout_dependency_revisions from public, anon, authenticated;
grant select on table public.workforce_payout_dependency_revisions to service_role;
create policy workforce_payout_dependency_revisions_service_role_select
  on public.workforce_payout_dependency_revisions
  for select to service_role using (true);

insert into public.workforce_payout_dependency_revisions(company_id, revision)
select company.id, 0
from public.companies company
on conflict (company_id) do nothing;

create or replace function public.workforce_bump_payout_dependency_revision(
  p_company_id uuid,
  p_should_bump boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_company_id is null then return; end if;

  perform public.lock_workforce_payment_allocation_company(p_company_id);
  if coalesce(p_should_bump, false) then
    insert into public.workforce_payout_dependency_revisions(company_id, revision, updated_at)
    values (p_company_id, 1, clock_timestamp())
    on conflict (company_id) do update
      set revision = public.workforce_payout_dependency_revisions.revision + 1,
          updated_at = clock_timestamp();
  end if;
end;
$function$;

-- Generic transition-table trigger functions.  Statement-level triggers keep
-- large shipment/attendance imports to one revision bump per affected company.
create or replace function public.workforce_touch_payout_dependency_from_new_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  for v_company_id in
    select distinct row_data.company_id
    from payout_dependency_new_rows row_data
    where row_data.company_id is not null
    order by row_data.company_id
  loop
    perform public.workforce_bump_payout_dependency_revision(v_company_id, true);
  end loop;
  return null;
end;
$function$;

create or replace function public.workforce_touch_payout_dependency_from_old_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  for v_company_id in
    select distinct row_data.company_id
    from payout_dependency_old_rows row_data
    where row_data.company_id is not null
    order by row_data.company_id
  loop
    perform public.workforce_bump_payout_dependency_revision(v_company_id, true);
  end loop;
  return null;
end;
$function$;

create or replace function public.workforce_touch_payout_dependency_from_changed_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  for v_company_id in
    select distinct changed.company_id
    from (
      select row_data.company_id from payout_dependency_old_rows row_data
      union
      select row_data.company_id from payout_dependency_new_rows row_data
    ) changed
    where changed.company_id is not null
    order by changed.company_id
  loop
    perform public.workforce_bump_payout_dependency_revision(v_company_id, true);
  end loop;
  return null;
end;
$function$;

-- ADVANCE values written by the recovery RPC are deliberately version-neutral:
-- the loader removes the current ADVANCE line before calculating max_amount.
-- Every other deduction value changes that cap and must advance the revision.
create or replace function public.workforce_touch_payout_dependency_from_deductions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_change record;
begin
  if tg_op = 'INSERT' then
    for v_change in
      select
        row_data.company_id,
        bool_or(not (
          upper(btrim(coalesce(head.code, ''))) = 'ADVANCE'
          and head.is_system is true
        )) as should_bump
      from payout_dependency_new_rows row_data
      left join public.workforce_deduction_heads head
        on head.company_id = row_data.company_id
       and head.id = row_data.deduction_head_id
      where row_data.company_id is not null
      group by row_data.company_id
      order by row_data.company_id
    loop
      perform public.workforce_bump_payout_dependency_revision(v_change.company_id, v_change.should_bump);
    end loop;
  elsif tg_op = 'DELETE' then
    for v_change in
      select
        row_data.company_id,
        bool_or(not (
          upper(btrim(coalesce(head.code, ''))) = 'ADVANCE'
          and head.is_system is true
        )) as should_bump
      from payout_dependency_old_rows row_data
      left join public.workforce_deduction_heads head
        on head.company_id = row_data.company_id
       and head.id = row_data.deduction_head_id
      where row_data.company_id is not null
      group by row_data.company_id
      order by row_data.company_id
    loop
      perform public.workforce_bump_payout_dependency_revision(v_change.company_id, v_change.should_bump);
    end loop;
  else
    for v_change in
      select
        changed.company_id,
        bool_or(not (
          upper(btrim(coalesce(head.code, ''))) = 'ADVANCE'
          and head.is_system is true
        )) as should_bump
      from (
        select row_data.company_id, row_data.deduction_head_id
        from payout_dependency_old_rows row_data
        union all
        select row_data.company_id, row_data.deduction_head_id
        from payout_dependency_new_rows row_data
      ) changed
      left join public.workforce_deduction_heads head
        on head.company_id = changed.company_id
       and head.id = changed.deduction_head_id
      where changed.company_id is not null
      group by changed.company_id
      order by changed.company_id
    loop
      perform public.workforce_bump_payout_dependency_revision(v_change.company_id, v_change.should_bump);
    end loop;
  end if;

  -- Even a system ADVANCE mutation takes the lock. This serializes direct
  -- service-role writes with the RPC while keeping its own end-check stable.
  return null;
end;
$function$;

-- Pending-balance mutations do not change max_amount, but they must share the
-- recovery lock so the FIFO plan remains stable until commit.
create or replace function public.workforce_lock_advance_state_from_new_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  for v_company_id in
    select distinct row_data.company_id
    from payout_dependency_new_rows row_data
    where row_data.company_id is not null
    order by row_data.company_id
  loop
    perform public.workforce_bump_payout_dependency_revision(v_company_id, false);
  end loop;
  return null;
end;
$function$;

create or replace function public.workforce_lock_advance_state_from_old_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  for v_company_id in
    select distinct row_data.company_id
    from payout_dependency_old_rows row_data
    where row_data.company_id is not null
    order by row_data.company_id
  loop
    perform public.workforce_bump_payout_dependency_revision(v_company_id, false);
  end loop;
  return null;
end;
$function$;

create or replace function public.workforce_lock_advance_state_from_changed_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  for v_company_id in
    select distinct changed.company_id
    from (
      select row_data.company_id from payout_dependency_old_rows row_data
      union
      select row_data.company_id from payout_dependency_new_rows row_data
    ) changed
    where changed.company_id is not null
    order by changed.company_id
  loop
    perform public.workforce_bump_payout_dependency_revision(v_company_id, false);
  end loop;
  return null;
end;
$function$;

create or replace function public.workforce_touch_all_payout_dependency_revisions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  for v_company_id in
    select company.id from public.companies company order by company.id
  loop
    perform public.workforce_bump_payout_dependency_revision(v_company_id, true);
  end loop;
  return null;
end;
$function$;

create or replace function public.workforce_lock_all_advance_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  for v_company_id in
    select company.id from public.companies company order by company.id
  loop
    perform public.workforce_bump_payout_dependency_revision(v_company_id, false);
  end loop;
  return null;
end;
$function$;

do $block$
declare
  v_table text;
  v_dependencies text[] := array[
    'stations',
    'location_models',
    'field_executive_provider_mappings',
    'workforce_payment_allocations',
    'payment_field_provider_metrics',
    'provider_production_metrics',
    'workforce_deduction_heads',
    'workforce_payment_settings',
    'workforce_attendance_capture_settings',
    'workforce',
    'cps_shipment_daily',
    'contractors',
    'employees',
    'connect_profile_verifications',
    'payment_method_components',
    'payment_methods',
    'payment_fields',
    'workforce_payout_attendance_overrides',
    'workforce_payout_attendance_values',
    'workforce_payment_field_overrides',
    'workforce_custom_production_inputs',
    'attendance_daily',
    'workforce_additional_payment_fields',
    'workforce_additional_payment_values',
    'workforce_payout_deduction_values',
    'providers',
    'designations'
  ];
begin
  foreach v_table in array v_dependencies
  loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'Required payout dependency table public.% is missing.', v_table;
    end if;
    if not exists (
      select 1
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = v_table
        and column_info.column_name = 'company_id'
        and column_info.udt_name = 'uuid'
    ) then
      raise exception 'Required payout dependency table public.% must have a UUID company_id column.', v_table;
    end if;

    execute format('drop trigger if exists workforce_payout_dependency_revision_insert on public.%I', v_table);
    execute format(
      'create trigger workforce_payout_dependency_revision_insert after insert on public.%I '
      || 'referencing new table as payout_dependency_new_rows for each statement '
      || 'execute function public.workforce_touch_payout_dependency_from_new_rows()',
      v_table
    );
    execute format('drop trigger if exists workforce_payout_dependency_revision_update on public.%I', v_table);
    execute format(
      'create trigger workforce_payout_dependency_revision_update after update on public.%I '
      || 'referencing old table as payout_dependency_old_rows new table as payout_dependency_new_rows '
      || 'for each statement execute function public.workforce_touch_payout_dependency_from_changed_rows()',
      v_table
    );
    execute format('drop trigger if exists workforce_payout_dependency_revision_delete on public.%I', v_table);
    execute format(
      'create trigger workforce_payout_dependency_revision_delete after delete on public.%I '
      || 'referencing old table as payout_dependency_old_rows for each statement '
      || 'execute function public.workforce_touch_payout_dependency_from_old_rows()',
      v_table
    );
    execute format('drop trigger if exists workforce_payout_dependency_revision_truncate on public.%I', v_table);
    execute format(
      'create trigger workforce_payout_dependency_revision_truncate after truncate on public.%I '
      || 'for each statement execute function public.workforce_touch_all_payout_dependency_revisions()',
      v_table
    );
  end loop;
end;
$block$;

drop trigger if exists workforce_payout_dependency_revision_insert on public.workforce_payout_deduction_values;
drop trigger if exists workforce_payout_dependency_revision_update on public.workforce_payout_deduction_values;
drop trigger if exists workforce_payout_dependency_revision_delete on public.workforce_payout_deduction_values;
create trigger workforce_payout_dependency_revision_insert
after insert on public.workforce_payout_deduction_values
referencing new table as payout_dependency_new_rows
for each statement execute function public.workforce_touch_payout_dependency_from_deductions();
create trigger workforce_payout_dependency_revision_update
after update on public.workforce_payout_deduction_values
referencing old table as payout_dependency_old_rows new table as payout_dependency_new_rows
for each statement execute function public.workforce_touch_payout_dependency_from_deductions();
create trigger workforce_payout_dependency_revision_delete
after delete on public.workforce_payout_deduction_values
referencing old table as payout_dependency_old_rows
for each statement execute function public.workforce_touch_payout_dependency_from_deductions();
drop trigger if exists workforce_payout_dependency_revision_truncate on public.workforce_payout_deduction_values;
create trigger workforce_payout_dependency_revision_truncate
after truncate on public.workforce_payout_deduction_values
for each statement execute function public.workforce_touch_all_payout_dependency_revisions();

do $block$
declare
  v_table text;
begin
  foreach v_table in array array['workforce_advances', 'workforce_advance_recoveries']
  loop
    execute format('drop trigger if exists workforce_advance_state_lock_insert on public.%I', v_table);
    execute format(
      'create trigger workforce_advance_state_lock_insert after insert on public.%I '
      || 'referencing new table as payout_dependency_new_rows for each statement '
      || 'execute function public.workforce_lock_advance_state_from_new_rows()',
      v_table
    );
    execute format('drop trigger if exists workforce_advance_state_lock_update on public.%I', v_table);
    execute format(
      'create trigger workforce_advance_state_lock_update after update on public.%I '
      || 'referencing old table as payout_dependency_old_rows new table as payout_dependency_new_rows '
      || 'for each statement execute function public.workforce_lock_advance_state_from_changed_rows()',
      v_table
    );
    execute format('drop trigger if exists workforce_advance_state_lock_delete on public.%I', v_table);
    execute format(
      'create trigger workforce_advance_state_lock_delete after delete on public.%I '
      || 'referencing old table as payout_dependency_old_rows for each statement '
      || 'execute function public.workforce_lock_advance_state_from_old_rows()',
      v_table
    );
    execute format('drop trigger if exists workforce_advance_state_lock_truncate on public.%I', v_table);
    execute format(
      'create trigger workforce_advance_state_lock_truncate after truncate on public.%I '
      || 'for each statement execute function public.workforce_lock_all_advance_state()',
      v_table
    );
  end loop;
end;
$block$;

create or replace function public.workforce_advance_recovery_snapshot_hash(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
)
returns text
language sql
security definer
set search_path = ''
as $function$
  select md5(
    p_company_id::text || ':' ||
    p_period_start::text || ':' ||
    p_period_end::text || ':' ||
    (statement_timestamp() at time zone 'Asia/Kolkata')::date::text || ':' ||
    coalesce(revision.revision, 0)::text
  )
  from (select 1) seed
  left join public.workforce_payout_dependency_revisions revision
    on revision.company_id = p_company_id;
$function$;

create or replace function public.workforce_apply_advance_recoveries(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_period_start date,
  p_period_end date,
  p_items jsonb,
  p_allowed_location_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_head public.workforce_deduction_heads%rowtype;
  v_item jsonb;
  v_workforce_id uuid;
  v_station_id uuid;
  v_max_amount numeric(18,2);
  v_recovered numeric(18,2);
  v_deduction_value_id uuid;
  v_existing_deduction_id uuid;
  v_existing_source text;
  v_existing_amount numeric(18,2);
  v_existing_station_id uuid;
  v_expected_snapshot_hash text;
  v_current_snapshot_hash text;
  v_existing_plan jsonb;
  v_desired_plan jsonb;
  v_plan_item jsonb;
  v_plan_is_identical boolean;
  v_results jsonb := '[]'::jsonb;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and actor are required.';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'A valid payout period is required.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one Workforce payout.';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Apply advances to at most 1000 payouts at a time.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    group by lower(item->>'workforce_id')
    having count(*) > 1
  ) then
    raise exception 'A Workforce member can be selected only once per recovery batch.';
  end if;

  v_expected_snapshot_hash := nullif(p_items->0->>'snapshot_hash', '');
  if v_expected_snapshot_hash is null or exists (
    select 1 from jsonb_array_elements(p_items) item
    where nullif(item->>'snapshot_hash', '') is distinct from v_expected_snapshot_hash
  ) then
    raise exception 'The payout calculation snapshot is missing or inconsistent. Refresh the page and try again.';
  end if;

  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id in (
      select (item->>'workforce_id')::uuid
      from jsonb_array_elements(p_items) item
    )
  order by workforce.id
  for update;

  -- This lock is also acquired by every dependency and advance-state trigger.
  -- It closes the interval between revision validation and transaction commit.
  perform public.lock_workforce_payment_allocation_company(p_company_id);
  v_current_snapshot_hash := public.workforce_advance_recovery_snapshot_hash(
    p_company_id,
    p_period_start,
    p_period_end
  );
  if v_current_snapshot_hash is distinct from v_expected_snapshot_hash then
    raise exception 'Payout inputs changed while advances were being prepared. Refresh the page and try again.';
  end if;

  select head.* into v_head
  from public.workforce_deduction_heads head
  where head.company_id = p_company_id
    and upper(btrim(head.code)) = 'ADVANCE'
    and head.is_active = true
    and head.calculation_type = 'manual'
    and head.is_system = true;
  if not found then
    raise exception 'The system-managed ADVANCE deduction head is unavailable.';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_workforce_id := nullif(v_item->>'workforce_id', '')::uuid;
    v_station_id := nullif(v_item->>'station_id', '')::uuid;
    v_max_amount := round(coalesce(nullif(v_item->>'max_amount', '')::numeric, 0), 2);

    if v_workforce_id is null or v_station_id is null or v_max_amount < 0 then
      raise exception 'Every recovery item requires Workforce, location, and a non-negative available amount.';
    end if;
    perform 1 from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id = v_workforce_id
      and workforce.deleted_at is null
      and workforce.migration_state is distinct from 'reclassified'
    for update;
    if not found then raise exception 'A selected Workforce member no longer exists.'; end if;
    if not exists (
      select 1 from public.stations station
      where station.company_id = p_company_id and station.id = v_station_id
    ) then
      raise exception 'A selected payout location no longer exists.';
    end if;
    if p_allowed_location_ids is not null and not (v_station_id = any(p_allowed_location_ids)) then
      raise exception 'A selected payout is outside your location scope.';
    end if;
    if not public.workforce_additional_payment_location_is_authorized(
      p_company_id, v_workforce_id, v_station_id, p_period_start, p_period_end
    ) then
      raise exception 'The selected payout location is not valid for this Workforce member and period.';
    end if;

    v_existing_deduction_id := null;
    v_existing_source := null;
    v_existing_amount := null;
    v_existing_station_id := null;
    select value.id, value.source_type, value.amount, value.station_id
      into v_existing_deduction_id, v_existing_source, v_existing_amount, v_existing_station_id
    from public.workforce_payout_deduction_values value
    where value.company_id = p_company_id
      and value.deduction_head_id = v_head.id
      and value.workforce_id = v_workforce_id
      and value.effective_from = p_period_start
      and value.effective_to = p_period_end
    for update;
    if found and v_existing_source <> 'advance_register' then
      raise exception 'The ADVANCE deduction for this Workforce member and period was created outside the advance register and cannot be replaced.';
    end if;

    perform 1
    from public.workforce_advances advance
    where advance.company_id = p_company_id
      and advance.workforce_id = v_workforce_id
      and advance.advance_date <= p_period_end
    order by advance.advance_date, advance.created_at, advance.id
    for update;

    perform 1
    from public.workforce_advance_recoveries recovery
    where recovery.company_id = p_company_id
      and recovery.workforce_id = v_workforce_id
      and recovery.status = 'deducted'
    order by recovery.period_start, recovery.period_end, recovery.id
    for update;

    -- Reconstruct this period from balances as they stood immediately before
    -- it. Later recoveries are intentionally excluded so an identical retry is
    -- a true no-op and a changed historical period can be rejected safely.
    with fifo as (
      select
        advance.id,
        advance.advance_date,
        advance.created_at,
        greatest(
          advance.amount - coalesce(sum(recovery.amount) filter (
            where recovery.status = 'deducted'
              and recovery.period_end < p_period_start
          ), 0),
          0
        )::numeric(18,2) as pending_amount
      from public.workforce_advances advance
      left join public.workforce_advance_recoveries recovery
        on recovery.company_id = advance.company_id
       and recovery.advance_id = advance.id
      where advance.company_id = p_company_id
        and advance.workforce_id = v_workforce_id
        and advance.advance_date <= p_period_end
      group by advance.id, advance.advance_date, advance.created_at, advance.amount
    ), planned as (
      select
        fifo.*,
        least(
          fifo.pending_amount,
          greatest(
            v_max_amount - coalesce(sum(fifo.pending_amount) over (
              order by fifo.advance_date, fifo.created_at, fifo.id
              rows between unbounded preceding and 1 preceding
            ), 0),
            0
          )
        )::numeric(18,2) as recovery_amount
      from fifo
    )
    select
      coalesce(jsonb_agg(
        jsonb_build_object(
          'advance_id', planned.id::text,
          'amount', planned.recovery_amount
        ) order by planned.advance_date, planned.created_at, planned.id
      ) filter (where planned.recovery_amount > 0), '[]'::jsonb),
      coalesce(sum(planned.recovery_amount) filter (where planned.recovery_amount > 0), 0)::numeric(18,2)
      into v_desired_plan, v_recovered
    from planned;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'advance_id', recovery.advance_id::text,
        'amount', recovery.amount
      ) order by advance.advance_date, advance.created_at, advance.id, recovery.id
    ), '[]'::jsonb)
      into v_existing_plan
    from public.workforce_advance_recoveries recovery
    join public.workforce_advances advance
      on advance.company_id = recovery.company_id
     and advance.id = recovery.advance_id
    where recovery.company_id = p_company_id
      and recovery.workforce_id = v_workforce_id
      and recovery.recovery_type = 'payout'
      and recovery.period_start = p_period_start
      and recovery.period_end = p_period_end
      and recovery.status = 'deducted';

    v_plan_is_identical := v_existing_plan = v_desired_plan
      and (
        (
          v_recovered > 0
          and v_existing_deduction_id is not null
          and v_existing_source = 'advance_register'
          and v_existing_amount = v_recovered
          and v_existing_station_id = v_station_id
          and not exists (
            select 1
            from public.workforce_advance_recoveries recovery
            where recovery.company_id = p_company_id
              and recovery.workforce_id = v_workforce_id
              and recovery.recovery_type = 'payout'
              and recovery.period_start = p_period_start
              and recovery.period_end = p_period_end
              and recovery.status = 'deducted'
              and (
                recovery.station_id is distinct from v_station_id
                or recovery.deduction_value_id is distinct from v_existing_deduction_id
              )
          )
        )
        or (
          v_recovered = 0
          and v_existing_deduction_id is null
          and v_existing_plan = '[]'::jsonb
        )
      );

    if v_plan_is_identical then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'workforce_id', v_workforce_id,
        'station_id', v_station_id,
        'deducted', v_recovered
      ));
      continue;
    end if;

    if exists (
      select 1
      from public.workforce_advance_recoveries recovery
      where recovery.company_id = p_company_id
        and recovery.workforce_id = v_workforce_id
        and recovery.recovery_type = 'payout'
        and recovery.status = 'deducted'
        and (recovery.period_start, recovery.period_end)
          > (p_period_start, p_period_end)
    ) then
      raise exception 'Later ADVANCE deductions already exist for this Workforce member. Reverse the later payout deductions before recalculating this earlier period.';
    end if;

    update public.workforce_advance_recoveries recovery
    set status = 'reversed',
        reversed_by = p_actor_user_id,
        reversed_at = clock_timestamp(),
        reversal_reason = 'Recalculated for the same Workforce payout period'
    where recovery.company_id = p_company_id
      and recovery.workforce_id = v_workforce_id
      and recovery.recovery_type = 'payout'
      and recovery.period_start = p_period_start
      and recovery.period_end = p_period_end
      and recovery.status = 'deducted';

    for v_plan_item in select value from jsonb_array_elements(v_desired_plan)
    loop
      insert into public.workforce_advance_recoveries(
        company_id, advance_id, workforce_id, station_id,
        period_start, period_end, amount, recovery_type, status,
        idempotency_key, created_by
      ) values (
        p_company_id, (v_plan_item->>'advance_id')::uuid, v_workforce_id, v_station_id,
        p_period_start, p_period_end, (v_plan_item->>'amount')::numeric, 'payout', 'deducted',
        (v_plan_item->>'advance_id') || ':' || p_period_start::text || ':' || p_period_end::text,
        p_actor_user_id
      );
    end loop;

    if v_recovered > 0 then
      insert into public.workforce_payout_deduction_values(
        company_id, deduction_head_id, workforce_id, station_id,
        head_code_snapshot, head_name_snapshot, effective_from, effective_to,
        amount, source_type, source_batch_id, source_row_id, import_metadata,
        created_by, updated_by
      ) values (
        p_company_id, v_head.id, v_workforce_id, v_station_id,
        v_head.code, v_head.name, p_period_start, p_period_end,
        v_recovered, 'advance_register', null, null,
        jsonb_build_object('source', 'workforce_advance_register'),
        p_actor_user_id, p_actor_user_id
      )
      on conflict (company_id, deduction_head_id, workforce_id, effective_from, effective_to)
      do update set
        station_id = excluded.station_id,
        amount = excluded.amount,
        source_type = 'advance_register',
        source_batch_id = null,
        source_row_id = null,
        import_metadata = excluded.import_metadata,
        updated_by = excluded.updated_by,
        updated_at = clock_timestamp()
      returning id into v_deduction_value_id;

      update public.workforce_advance_recoveries recovery
      set deduction_value_id = v_deduction_value_id
      where recovery.company_id = p_company_id
        and recovery.workforce_id = v_workforce_id
        and recovery.recovery_type = 'payout'
        and recovery.period_start = p_period_start
        and recovery.period_end = p_period_end
        and recovery.status = 'deducted';
    else
      delete from public.workforce_payout_deduction_values value
      where value.company_id = p_company_id
        and value.deduction_head_id = v_head.id
        and value.workforce_id = v_workforce_id
        and value.effective_from = p_period_start
        and value.effective_to = p_period_end
        and value.source_type = 'advance_register';
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'workforce_id', v_workforce_id,
      'station_id', v_station_id,
      'deducted', v_recovered
    ));
  end loop;

  -- Own ADVANCE/recovery writes are version-neutral.  Any cap-affecting write
  -- must bump under this same lock, so a mismatch here aborts the transaction.
  v_current_snapshot_hash := public.workforce_advance_recovery_snapshot_hash(
    p_company_id,
    p_period_start,
    p_period_end
  );
  if v_current_snapshot_hash is distinct from v_expected_snapshot_hash then
    raise exception 'Payout inputs changed while advances were being applied. No deductions were saved; refresh the page and try again.';
  end if;

  return v_results;
end;
$function$;

comment on table public.workforce_payout_dependency_revisions is
  'Monotonic company version for every database dependency consumed by Workforce payout calculation.';
comment on function public.workforce_apply_advance_recoveries(uuid, uuid, date, date, jsonb, uuid[]) is
  'Applies FIFO advance deductions under a company dependency lock, preserves identical retries, and blocks unsafe historical recalculation.';

revoke all on function public.workforce_bump_payout_dependency_revision(uuid, boolean),
  public.workforce_touch_payout_dependency_from_new_rows(),
  public.workforce_touch_payout_dependency_from_old_rows(),
  public.workforce_touch_payout_dependency_from_changed_rows(),
  public.workforce_touch_payout_dependency_from_deductions(),
  public.workforce_lock_advance_state_from_new_rows(),
  public.workforce_lock_advance_state_from_old_rows(),
  public.workforce_lock_advance_state_from_changed_rows(),
  public.workforce_touch_all_payout_dependency_revisions(),
  public.workforce_lock_all_advance_state(),
  public.workforce_advance_recovery_snapshot_hash(uuid, date, date),
  public.workforce_apply_advance_recoveries(uuid, uuid, date, date, jsonb, uuid[])
from public, anon, authenticated;
grant execute on function public.workforce_advance_recovery_snapshot_hash(uuid, date, date),
  public.workforce_apply_advance_recoveries(uuid, uuid, date, date, jsonb, uuid[])
to service_role;

notify pgrst, 'reload schema';
commit;
