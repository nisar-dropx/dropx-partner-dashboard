begin;

create extension if not exists btree_gist;

-- Composite references make every allocation tenant-safe even for privileged
-- service writes. Helper IDs are globally unique today, but the tenant key is
-- intentionally part of every business foreign key.
create unique index if not exists helpers_company_id_id_uidx
  on public.helpers (company_id, id);
create unique index if not exists stations_company_id_id_uidx
  on public.stations (company_id, id);
create unique index if not exists designations_company_id_id_uidx
  on public.designations (company_id, id);
create unique index if not exists payment_methods_company_id_id_uidx
  on public.payment_methods (company_id, id);

create table public.helper_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  helper_id uuid not null,
  station_id uuid not null,
  station_code_snapshot text not null,
  designation_id uuid not null,
  designation_code_snapshot text not null,
  designation_name_snapshot text not null,
  payment_method_id uuid not null,
  payment_values jsonb not null default '{}'::jsonb,
  payment_components jsonb not null default '[]'::jsonb,
  effective_from date not null,
  effective_to date,
  status text not null default 'active',
  change_reason text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint helper_payment_allocations_helper_company_fk
    foreign key (company_id, helper_id)
    references public.helpers (company_id, id)
    on delete restrict,
  constraint helper_payment_allocations_station_company_fk
    foreign key (company_id, station_id)
    references public.stations (company_id, id)
    on delete restrict,
  constraint helper_payment_allocations_designation_company_fk
    foreign key (company_id, designation_id)
    references public.designations (company_id, id)
    on delete restrict,
  constraint helper_payment_allocations_method_company_fk
    foreign key (company_id, payment_method_id)
    references public.payment_methods (company_id, id)
    on delete restrict,
  constraint helper_payment_allocations_date_order_check
    check (effective_to is null or effective_to >= effective_from),
  constraint helper_payment_allocations_status_check
    check (status in ('active', 'closed', 'cancelled')),
  constraint helper_payment_allocations_values_object_check
    check (jsonb_typeof(payment_values) = 'object'),
  constraint helper_payment_allocations_components_array_check
    check (jsonb_typeof(payment_components) = 'array')
);

create index helper_payment_allocations_company_period_idx
  on public.helper_payment_allocations (company_id, effective_from, effective_to);

create index helper_payment_allocations_helper_period_idx
  on public.helper_payment_allocations (company_id, helper_id, effective_from desc, effective_to);

create index helper_payment_allocations_station_idx
  on public.helper_payment_allocations (company_id, station_id, effective_from desc);

create index helper_payment_allocations_designation_idx
  on public.helper_payment_allocations (company_id, designation_id, effective_from desc);

create index helper_payment_allocations_method_idx
  on public.helper_payment_allocations (company_id, payment_method_id, effective_from desc);

create index helper_payment_allocations_created_by_idx
  on public.helper_payment_allocations (created_by)
  where created_by is not null;

create index helper_payment_allocations_updated_by_idx
  on public.helper_payment_allocations (updated_by)
  where updated_by is not null;

create unique index helper_payment_allocations_one_current_idx
  on public.helper_payment_allocations (company_id, helper_id)
  where status = 'active' and effective_to is null;

alter table public.helper_payment_allocations
  add constraint helper_payment_allocations_no_overlap
  exclude using gist (
    company_id with =,
    helper_id with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
  )
  where (status <> 'cancelled');

comment on table public.helper_payment_allocations is
  'Effective-dated payment allocation history for people in the current Helpers master. Helper payment never depends on provider ID mapping.';
comment on column public.helper_payment_allocations.payment_values is
  'Configured payment-field values keyed by the frozen payment component code.';
comment on column public.helper_payment_allocations.payment_components is
  'Immutable component snapshot, including calculation_source, used after payment-method master changes.';
comment on column public.helper_payment_allocations.station_code_snapshot is
  'Station code copied when the allocation version is saved.';
comment on column public.helper_payment_allocations.designation_code_snapshot is
  'Designation code copied when the allocation version is saved.';
comment on column public.helper_payment_allocations.designation_name_snapshot is
  'Designation name copied when the allocation version is saved.';

create or replace function public.save_helper_payment_allocation(
  p_company_id uuid,
  p_helper_id uuid,
  p_payment_method_id uuid,
  p_payment_values jsonb,
  p_effective_from date,
  p_effective_to date default null,
  p_change_reason text default null,
  p_actor_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.helper_payment_allocations%rowtype;
  v_current_found boolean := false;
  v_location_id uuid;
  v_helper_designation text;
  v_station_code text;
  v_designation_id uuid;
  v_designation_code text;
  v_designation_name text;
  v_next_from date;
  v_effective_to date;
  v_component record;
  v_component_count integer := 0;
  v_payment_components jsonb := '[]'::jsonb;
  v_result_id uuid;
begin
  if p_company_id is null or p_helper_id is null then
    raise exception 'Company and Helper are required.';
  end if;
  if p_payment_method_id is null then
    raise exception 'Payment method is required.';
  end if;
  if p_effective_from is null then
    raise exception 'Effective from date is required.';
  end if;
  if p_effective_to is not null and p_effective_to < p_effective_from then
    raise exception 'Effective to date cannot be before effective from date.';
  end if;
  if p_payment_values is null or jsonb_typeof(p_payment_values) <> 'object' then
    raise exception 'Payment values must be a JSON object.';
  end if;

  -- Payment fields and method components use this company mutex for master
  -- changes. Take it before reading them so the frozen snapshot represents one
  -- serial point in the same order as Workforce direct-payment saves.
  perform pg_advisory_xact_lock(hashtextextended(
    'workforce-payment-basis:' || p_company_id::text,
    0
  ));

  -- Lock the Helper row before its per-Helper advisory lock. Every call uses
  -- this order, which serializes concurrent saves for one Helper.
  perform 1
  from public.helpers helper
  where helper.company_id = p_company_id
    and helper.id = p_helper_id
  for update;

  if not found then
    raise exception 'Helper does not belong to this company.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'helper-payment:' || p_company_id::text || ':' || p_helper_id::text,
    0
  ));

  -- Helpers are their own master population. A provider mapping is neither
  -- joined nor required. Re-read mutable Helper ownership after the row lock,
  -- then share-lock each selected master so a concurrent deactivation or
  -- rename is ordered before or after this allocation save.
  select
    helper.location_id,
    helper.designation
  into
    v_location_id,
    v_helper_designation
  from public.helpers helper
  where helper.company_id = p_company_id
    and helper.id = p_helper_id
    and helper.is_active = true
    and lower(coalesce(helper.onboarding_status, '')) = 'active';

  if not found then
    raise exception 'Helper must be active and fully onboarded.';
  end if;

  select station.station_code
  into v_station_code
  from public.stations station
  where station.company_id = p_company_id
    and station.id = v_location_id
    and station.is_active = true
  for share;

  if not found then
    raise exception 'Helper must have an active company location.';
  end if;

  select candidate.id, candidate.code, candidate.name
  into v_designation_id, v_designation_code, v_designation_name
  from public.designations candidate
  where candidate.company_id = p_company_id
    and candidate.is_active = true
    and lower(btrim(coalesce(v_helper_designation, ''))) in (
      lower(btrim(candidate.code)),
      lower(btrim(candidate.name))
    )
  order by
    (lower(btrim(coalesce(v_helper_designation, ''))) = lower(btrim(candidate.name))) desc,
    candidate.id
  limit 1
  for share;

  if not found then
    raise exception 'Helper must have an active company designation.';
  end if;

  perform 1
  from public.payment_methods method
  where method.company_id = p_company_id
    and method.id = p_payment_method_id
    and method.is_active = true
  for share;

  if not found then
    raise exception 'Payment method is not active for this company.';
  end if;

  for v_component in
    select
      component.component_code,
      component.component_type,
      coalesce(field.label, component.label) as label,
      coalesce(field.pay_schedule, component.pay_schedule) as pay_schedule,
      field.calculation_type,
      field.calculation_source,
      component.sort_order
    from public.payment_method_components component
    left join public.payment_fields field
      on field.company_id = p_company_id
     and field.id = component.payment_field_id
    where component.company_id = p_company_id
      and component.payment_method_id = p_payment_method_id
      and component.is_active = true
    order by component.sort_order, component.component_code
  loop
    if v_component.component_type = 'production' then
      raise exception 'Helper payment allocation cannot use a payment method with production components.';
    end if;
    if v_component.component_type <> 'amount'
      or v_component.pay_schedule is null
      or v_component.pay_schedule not in ('per_hour', 'per_day', 'per_month') then
      raise exception 'Every Helper payment amount requires a per-hour, per-day or per-month schedule.';
    end if;

    v_component_count := v_component_count + 1;
    v_payment_components := v_payment_components || jsonb_build_array(jsonb_build_object(
      'component_code', v_component.component_code,
      'component_type', v_component.component_type,
      'label', v_component.label,
      'pay_schedule', v_component.pay_schedule,
      'calculation_type', v_component.calculation_type,
      'calculation_source', v_component.calculation_source,
      'sort_order', v_component.sort_order
    ));

    if not (p_payment_values ? v_component.component_code) then
      raise exception 'A value is required for payment component %.', v_component.component_code;
    end if;
    if jsonb_typeof(p_payment_values -> v_component.component_code) <> 'number'
      or (p_payment_values ->> v_component.component_code)::numeric < 0 then
      raise exception 'Payment component % must be a non-negative number.', v_component.component_code;
    end if;
  end loop;

  if v_component_count = 0 then
    raise exception 'Helper payment allocation requires at least one active amount component.';
  end if;

  if exists (
    select 1
    from jsonb_object_keys(p_payment_values) supplied(component_code)
    where not exists (
      select 1
      from public.payment_method_components component
      where component.company_id = p_company_id
        and component.payment_method_id = p_payment_method_id
        and component.is_active = true
        and component.component_type = 'amount'
        and component.component_code = supplied.component_code
    )
  ) then
    raise exception 'Payment values contain a field that is not part of the selected payment method.';
  end if;

  select allocation.*
  into v_current
  from public.helper_payment_allocations allocation
  where allocation.company_id = p_company_id
    and allocation.helper_id = p_helper_id
    and allocation.status <> 'cancelled'
    and allocation.effective_from <= p_effective_from
    and (allocation.effective_to is null or allocation.effective_to >= p_effective_from)
  order by allocation.effective_from desc, allocation.created_at desc
  limit 1
  for update;

  v_current_found := found;

  select allocation.effective_from
  into v_next_from
  from public.helper_payment_allocations allocation
  where allocation.company_id = p_company_id
    and allocation.helper_id = p_helper_id
    and allocation.status <> 'cancelled'
    and allocation.effective_from > p_effective_from
  order by allocation.effective_from, allocation.created_at, allocation.id
  limit 1
  for update;

  v_effective_to := case
    when p_effective_to is not null then p_effective_to
    when v_next_from is not null then v_next_from - 1
    else null
  end;

  if v_next_from is not null and v_effective_to >= v_next_from then
    raise exception 'Effective to date must be before the next Helper payment allocation on %.', v_next_from;
  end if;

  if v_current_found and p_effective_from = v_current.effective_from then
    update public.helper_payment_allocations allocation
    set station_id = v_location_id,
        station_code_snapshot = v_station_code,
        designation_id = v_designation_id,
        designation_code_snapshot = v_designation_code,
        designation_name_snapshot = v_designation_name,
        payment_method_id = p_payment_method_id,
        payment_values = p_payment_values,
        payment_components = v_payment_components,
        effective_to = v_effective_to,
        status = case when v_effective_to is null then 'active' else 'closed' end,
        change_reason = nullif(btrim(p_change_reason), ''),
        updated_by = p_actor_user_id,
        updated_at = now()
    where allocation.id = v_current.id
    returning allocation.id into v_result_id;

    return v_result_id;
  end if;

  if v_current_found then
    update public.helper_payment_allocations allocation
    set effective_to = p_effective_from - 1,
        status = 'closed',
        updated_by = p_actor_user_id,
        updated_at = now()
    where allocation.id = v_current.id;
  end if;

  insert into public.helper_payment_allocations (
    company_id,
    helper_id,
    station_id,
    station_code_snapshot,
    designation_id,
    designation_code_snapshot,
    designation_name_snapshot,
    payment_method_id,
    payment_values,
    payment_components,
    effective_from,
    effective_to,
    status,
    change_reason,
    created_by,
    updated_by
  ) values (
    p_company_id,
    p_helper_id,
    v_location_id,
    v_station_code,
    v_designation_id,
    v_designation_code,
    v_designation_name,
    p_payment_method_id,
    p_payment_values,
    v_payment_components,
    p_effective_from,
    v_effective_to,
    case when v_effective_to is null then 'active' else 'closed' end,
    nullif(btrim(p_change_reason), ''),
    p_actor_user_id,
    p_actor_user_id
  )
  returning id into v_result_id;

  return v_result_id;
end;
$$;

create or replace function public.reconcile_helper_payment_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_offboarding boolean := false;
  v_assignment_changed boolean := false;
  v_station_code text;
  v_designation_id uuid;
  v_designation_code text;
  v_designation_name text;
  v_current public.helper_payment_allocations%rowtype;
begin
  -- A Helper UPDATE already owns the Helper row. Take the same second lock as
  -- the save RPC so allocation writes and master transitions remain ordered.
  perform pg_advisory_xact_lock(hashtextextended(
    'helper-payment:' || new.company_id::text || ':' || new.id::text,
    0
  ));

  v_offboarding := new.is_active is not true
    or lower(coalesce(new.onboarding_status, '')) <> 'active';

  if v_offboarding then
    update public.helper_payment_allocations allocation
    set status = 'cancelled',
        change_reason = concat_ws(
          ' | ',
          nullif(btrim(allocation.change_reason), ''),
          'Automatically cancelled after the Helper became inactive.'
        ),
        updated_at = now()
    where allocation.company_id = new.company_id
      and allocation.helper_id = new.id
      and allocation.status <> 'cancelled'
      and allocation.effective_from > v_today;

    update public.helper_payment_allocations allocation
    set effective_to = v_today,
        status = 'closed',
        change_reason = concat_ws(
          ' | ',
          nullif(btrim(allocation.change_reason), ''),
          'Automatically closed when the Helper became inactive.'
        ),
        updated_at = now()
    where allocation.company_id = new.company_id
      and allocation.helper_id = new.id
      and allocation.status <> 'cancelled'
      and allocation.effective_from <= v_today
      and (allocation.effective_to is null or allocation.effective_to > v_today);

    return new;
  end if;

  v_assignment_changed := new.location_id is distinct from old.location_id
    or new.designation is distinct from old.designation;

  if not v_assignment_changed or not exists (
    select 1
    from public.helper_payment_allocations allocation
    where allocation.company_id = new.company_id
      and allocation.helper_id = new.id
      and allocation.status <> 'cancelled'
      and (allocation.effective_to is null or allocation.effective_to >= v_today)
  ) then
    return new;
  end if;

  select station.station_code
  into v_station_code
  from public.stations station
  where station.company_id = new.company_id
    and station.id = new.location_id
    and station.is_active = true
  for share;

  if not found then
    raise exception 'An active company location is required before changing a Helper with payment allocations.';
  end if;

  select designation.id, designation.code, designation.name
  into v_designation_id, v_designation_code, v_designation_name
  from public.designations designation
  where designation.company_id = new.company_id
    and designation.is_active = true
    and lower(btrim(coalesce(new.designation, ''))) in (
      lower(btrim(designation.code)),
      lower(btrim(designation.name))
    )
  order by
    (lower(btrim(coalesce(new.designation, ''))) = lower(btrim(designation.name))) desc,
    designation.id
  limit 1
  for share;

  if not found then
    raise exception 'An active company designation is required before changing a Helper with payment allocations.';
  end if;

  -- Future payment terms remain scheduled, but their ownership snapshots must
  -- follow the current Helper assignment. They have not taken effect yet, so
  -- updating only these snapshots does not rewrite historical payroll facts.
  update public.helper_payment_allocations allocation
  set station_id = new.location_id,
      station_code_snapshot = v_station_code,
      designation_id = v_designation_id,
      designation_code_snapshot = v_designation_code,
      designation_name_snapshot = v_designation_name,
      change_reason = concat_ws(
        ' | ',
        nullif(btrim(allocation.change_reason), ''),
        'Automatically aligned with the Helper assignment before this version took effect.'
      ),
      updated_at = now()
  where allocation.company_id = new.company_id
    and allocation.helper_id = new.id
    and allocation.status <> 'cancelled'
    and allocation.effective_from > v_today
    and (
      allocation.station_id is distinct from new.location_id
      or allocation.station_code_snapshot is distinct from v_station_code
      or allocation.designation_id is distinct from v_designation_id
      or allocation.designation_code_snapshot is distinct from v_designation_code
      or allocation.designation_name_snapshot is distinct from v_designation_name
    );

  select allocation.*
  into v_current
  from public.helper_payment_allocations allocation
  where allocation.company_id = new.company_id
    and allocation.helper_id = new.id
    and allocation.status <> 'cancelled'
    and allocation.effective_from <= v_today
    and (allocation.effective_to is null or allocation.effective_to >= v_today)
  order by allocation.effective_from desc, allocation.created_at desc, allocation.id
  limit 1
  for update;

  if not found then
    return new;
  end if;

  if v_current.station_id is not distinct from new.location_id
    and v_current.station_code_snapshot is not distinct from v_station_code
    and v_current.designation_id is not distinct from v_designation_id
    and v_current.designation_code_snapshot is not distinct from v_designation_code
    and v_current.designation_name_snapshot is not distinct from v_designation_name then
    return new;
  end if;

  if v_current.effective_from = v_today then
    update public.helper_payment_allocations allocation
    set station_id = new.location_id,
        station_code_snapshot = v_station_code,
        designation_id = v_designation_id,
        designation_code_snapshot = v_designation_code,
        designation_name_snapshot = v_designation_name,
        change_reason = concat_ws(
          ' | ',
          nullif(btrim(allocation.change_reason), ''),
          'Automatically aligned with the Helper location or designation change.'
        ),
        updated_at = now()
    where allocation.id = v_current.id;
    return new;
  end if;

  update public.helper_payment_allocations allocation
  set effective_to = v_today - 1,
      status = 'closed',
      change_reason = concat_ws(
        ' | ',
        nullif(btrim(allocation.change_reason), ''),
        'Automatically closed before the Helper location or designation change.'
      ),
      updated_at = now()
  where allocation.id = v_current.id;

  insert into public.helper_payment_allocations (
    company_id,
    helper_id,
    station_id,
    station_code_snapshot,
    designation_id,
    designation_code_snapshot,
    designation_name_snapshot,
    payment_method_id,
    payment_values,
    payment_components,
    effective_from,
    effective_to,
    status,
    change_reason,
    created_by,
    updated_by
  ) values (
    v_current.company_id,
    v_current.helper_id,
    new.location_id,
    v_station_code,
    v_designation_id,
    v_designation_code,
    v_designation_name,
    v_current.payment_method_id,
    v_current.payment_values,
    v_current.payment_components,
    v_today,
    v_current.effective_to,
    case when v_current.effective_to is null then 'active' else 'closed' end,
    'Automatically created after the Helper location or designation change.',
    v_current.created_by,
    v_current.updated_by
  );

  return new;
end;
$$;

create trigger helper_payment_allocation_transition_integrity
before update of location_id, designation, is_active, onboarding_status
on public.helpers
for each row execute function public.reconcile_helper_payment_transition();

create or replace function public.guard_helper_payment_designation_master()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if new.is_active is not true
    or new.code is distinct from old.code
    or new.name is distinct from old.name then
    if exists (
      select 1
      from public.helper_payment_allocations allocation
      join public.helpers helper
        on helper.company_id = allocation.company_id
       and helper.id = allocation.helper_id
      where allocation.company_id = old.company_id
        and allocation.designation_id = old.id
        and allocation.status <> 'cancelled'
        and (allocation.effective_to is null or allocation.effective_to > v_today)
        and (
          new.is_active is not true
          or lower(btrim(coalesce(helper.designation, ''))) not in (
            lower(btrim(new.code)),
            lower(btrim(new.name))
          )
        )
    ) then
      raise exception 'Close or realign active Helper payment allocations before deactivating or renaming this designation.';
    end if;
  end if;
  return new;
end;
$$;

create trigger designations_helper_payment_allocation_guard
before update of code, name, is_active
on public.designations
for each row execute function public.guard_helper_payment_designation_master();

create or replace function public.guard_helper_payment_station_master()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if old.is_active is true and new.is_active is not true and exists (
    select 1
    from public.helper_payment_allocations allocation
    where allocation.company_id = old.company_id
      and allocation.station_id = old.id
      and allocation.status <> 'cancelled'
      and (allocation.effective_to is null or allocation.effective_to > v_today)
  ) then
    raise exception 'Move or close active Helper payment allocations before deactivating this station.';
  end if;
  return new;
end;
$$;

create trigger stations_helper_payment_allocation_guard
before update of is_active
on public.stations
for each row execute function public.guard_helper_payment_station_master();

create or replace function public.guard_helper_payment_method_master()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if old.is_active is true and new.is_active is not true and exists (
    select 1
    from public.helper_payment_allocations allocation
    where allocation.company_id = old.company_id
      and allocation.payment_method_id = old.id
      and allocation.status <> 'cancelled'
      and (allocation.effective_to is null or allocation.effective_to > v_today)
  ) then
    raise exception 'Close active Helper payment allocations before deactivating this payment method.';
  end if;
  return new;
end;
$$;

create trigger payment_methods_helper_payment_allocation_guard
before update of is_active
on public.payment_methods
for each row execute function public.guard_helper_payment_method_master();

alter table public.helper_payment_allocations enable row level security;

revoke all on table public.helper_payment_allocations
  from public, anon, authenticated, service_role;
grant select on table public.helper_payment_allocations to service_role;

create policy helper_payment_allocations_service_role_select
  on public.helper_payment_allocations
  for select
  to service_role
  using (true);

revoke all on function public.save_helper_payment_allocation(
  uuid, uuid, uuid, jsonb, date, date, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.save_helper_payment_allocation(
  uuid, uuid, uuid, jsonb, date, date, text, uuid
) to service_role;

revoke all on function public.reconcile_helper_payment_transition(),
  public.guard_helper_payment_designation_master(),
  public.guard_helper_payment_station_master(),
  public.guard_helper_payment_method_master()
  from public, anon, authenticated, service_role;

comment on function public.save_helper_payment_allocation(
  uuid, uuid, uuid, jsonb, date, date, text, uuid
) is
  'Validates and versions a Helper payment allocation while freezing the payment calculation basis. Provider mapping is not used.';

notify pgrst, 'reload schema';

commit;
