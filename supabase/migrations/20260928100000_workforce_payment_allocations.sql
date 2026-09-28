begin;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create table if not exists public.workforce_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  workforce_id uuid not null references public.workforce(id) on delete restrict,
  station_id uuid references public.stations(id) on delete restrict,
  station_code_snapshot text,
  designation_id uuid references public.designations(id) on delete restrict,
  designation_code_snapshot text,
  designation_name_snapshot text,
  payment_method_id uuid not null references public.payment_methods(id) on delete restrict,
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
  constraint workforce_payment_allocations_date_order_check
    check (effective_to is null or effective_to >= effective_from),
  constraint workforce_payment_allocations_status_check
    check (status in ('active', 'closed', 'cancelled')),
  constraint workforce_payment_allocations_values_object_check
    check (jsonb_typeof(payment_values) = 'object'),
  constraint workforce_payment_allocations_components_array_check
    check (jsonb_typeof(payment_components) = 'array')
);

alter table public.workforce_payment_allocations
  add column if not exists payment_components jsonb not null default '[]'::jsonb;

update public.workforce_payment_allocations allocation
set payment_components = coalesce((
  select jsonb_agg(
    jsonb_build_object(
      'component_code', component.component_code,
      'component_type', component.component_type,
      'label', coalesce(field.label, component.label),
      'pay_schedule', coalesce(field.pay_schedule, component.pay_schedule),
      'calculation_type', field.calculation_type,
      'sort_order', component.sort_order
    )
    order by component.sort_order, component.component_code
  )
  from public.payment_method_components component
  left join public.payment_fields field
    on field.id = component.payment_field_id
   and field.company_id = allocation.company_id
  where component.payment_method_id = allocation.payment_method_id
    and component.company_id = allocation.company_id
    and component.is_active = true
    and component.component_type = 'amount'
), '[]'::jsonb)
where jsonb_typeof(allocation.payment_components) <> 'array'
   or jsonb_array_length(allocation.payment_components) = 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.workforce_payment_allocations'::regclass
      and conname = 'workforce_payment_allocations_components_array_check'
  ) then
    alter table public.workforce_payment_allocations
      add constraint workforce_payment_allocations_components_array_check
      check (jsonb_typeof(payment_components) = 'array');
  end if;
end
$$;

create index if not exists workforce_payment_allocations_company_period_idx
  on public.workforce_payment_allocations (company_id, effective_from, effective_to);

create index if not exists workforce_payment_allocations_workforce_period_idx
  on public.workforce_payment_allocations (workforce_id, effective_from desc, effective_to);

create index if not exists workforce_payment_allocations_station_idx
  on public.workforce_payment_allocations (company_id, station_id, effective_from desc);

create index if not exists workforce_payment_allocations_method_idx
  on public.workforce_payment_allocations (company_id, payment_method_id, effective_from desc);

create unique index if not exists workforce_payment_allocations_one_current_idx
  on public.workforce_payment_allocations (company_id, workforce_id)
  where status = 'active' and effective_to is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.workforce_payment_allocations'::regclass
      and conname = 'workforce_payment_allocations_no_overlap'
  ) then
    alter table public.workforce_payment_allocations
      add constraint workforce_payment_allocations_no_overlap
      exclude using gist (
        company_id with =,
        workforce_id with =,
        daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
      )
      where (status <> 'cancelled');
  end if;
end
$$;

comment on table public.workforce_payment_allocations is
  'Effective-dated, provider-independent payment allocation for Field Operations designations that do not require provider ID mapping.';
comment on column public.workforce_payment_allocations.payment_values is
  'Configured non-production payment-field values keyed by payment_method_components.component_code.';
comment on column public.workforce_payment_allocations.payment_components is
  'Immutable component definition snapshot used to calculate this allocation after its payment-method master changes.';
comment on column public.workforce_payment_allocations.station_code_snapshot is
  'Station code copied when this history row is created so historical payroll remains explainable after master-data edits.';
comment on column public.workforce_payment_allocations.designation_code_snapshot is
  'Designation code copied when this history row is created.';
comment on column public.workforce_payment_allocations.designation_name_snapshot is
  'Designation name copied when this history row is created.';

create or replace function public.reject_provider_and_direct_payment_overlap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cancelled' then
    return new;
  end if;

  -- Serialize both payment-allocation paths for the same canonical workforce
  -- identity so simultaneous provider/direct writes cannot pass reciprocal checks.
  perform pg_advisory_xact_lock(hashtextextended(
    new.company_id::text || ':' || new.workforce_id::text,
    0
  ));

  if exists (
    select 1
    from public.field_executive_provider_mappings provider_mapping
    where provider_mapping.company_id = new.company_id
      and (
        provider_mapping.workforce_id = new.workforce_id
        or provider_mapping.field_executive_id = new.workforce_id
        or exists (
          select 1
          from public.workforce canonical_workforce
          where canonical_workforce.company_id = new.company_id
            and canonical_workforce.id = new.workforce_id
            and (
              (canonical_workforce.source_profile_type = 'employee' and provider_mapping.employee_id = canonical_workforce.source_profile_id)
              or (canonical_workforce.source_profile_type = 'contractor' and provider_mapping.contractor_id = canonical_workforce.source_profile_id)
              or (canonical_workforce.source_profile_type = 'field_executive' and provider_mapping.field_executive_id = canonical_workforce.source_profile_id)
            )
        )
      )
      and provider_mapping.status <> 'cancelled'
      and daterange(
        provider_mapping.effective_from,
        coalesce(provider_mapping.effective_to, 'infinity'::date),
        '[]'
      ) && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
  ) then
    raise exception 'Direct payment allocation overlaps an existing provider payment mapping. Close the provider mapping first.';
  end if;

  return new;
end;
$$;

drop trigger if exists workforce_payment_allocations_provider_overlap
  on public.workforce_payment_allocations;
create trigger workforce_payment_allocations_provider_overlap
before insert or update of company_id, workforce_id, effective_from, effective_to, status
on public.workforce_payment_allocations
for each row execute function public.reject_provider_and_direct_payment_overlap();

create or replace function public.reject_direct_and_provider_payment_overlap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_canonical_workforce_id uuid;
begin
  if (new.workforce_id is null and new.employee_id is null and new.contractor_id is null and new.field_executive_id is null)
    or new.effective_from is null
    or new.status = 'cancelled' then
    return new;
  end if;

  select workforce.id
  into v_canonical_workforce_id
  from public.workforce workforce
  where workforce.company_id = new.company_id
    and (
      workforce.id = new.workforce_id
      or workforce.id = new.field_executive_id
      or (workforce.source_profile_type = 'employee' and workforce.source_profile_id = new.employee_id)
      or (workforce.source_profile_type = 'contractor' and workforce.source_profile_id = new.contractor_id)
      or (workforce.source_profile_type = 'field_executive' and workforce.source_profile_id = new.field_executive_id)
    )
  order by (workforce.id = new.workforce_id) desc,
    (workforce.source_profile_id is not null) desc,
    workforce.id
  limit 1;

  if v_canonical_workforce_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      new.company_id::text || ':' || v_canonical_workforce_id::text,
      0
    ));
  end if;

  if exists (
    select 1
    from public.workforce_payment_allocations direct_allocation
    where direct_allocation.company_id = new.company_id
      and (
        direct_allocation.workforce_id = new.workforce_id
        or direct_allocation.workforce_id = new.field_executive_id
        or exists (
          select 1
          from public.workforce canonical_workforce
          where canonical_workforce.company_id = new.company_id
            and canonical_workforce.id = direct_allocation.workforce_id
            and (
              (canonical_workforce.source_profile_type = 'employee' and canonical_workforce.source_profile_id = new.employee_id)
              or (canonical_workforce.source_profile_type = 'contractor' and canonical_workforce.source_profile_id = new.contractor_id)
              or (canonical_workforce.source_profile_type = 'field_executive' and canonical_workforce.source_profile_id = new.field_executive_id)
            )
        )
      )
      and direct_allocation.status <> 'cancelled'
      and daterange(
        direct_allocation.effective_from,
        coalesce(direct_allocation.effective_to, 'infinity'::date),
        '[]'
      ) && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
  ) then
    raise exception 'Provider payment mapping overlaps an existing direct payment allocation. Close the direct allocation first.';
  end if;

  return new;
end;
$$;

drop trigger if exists field_executive_provider_mappings_direct_overlap
  on public.field_executive_provider_mappings;
create trigger field_executive_provider_mappings_direct_overlap
before insert or update of company_id, workforce_id, employee_id, contractor_id, field_executive_id, effective_from, effective_to, status
on public.field_executive_provider_mappings
for each row execute function public.reject_direct_and_provider_payment_overlap();

create or replace function public.guard_designation_direct_payment_policy()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.provider_mapping_required = true and old.provider_mapping_required = false)
    or (new.is_field_operations = false and old.is_field_operations = true)
    or (new.is_active = false and old.is_active = true) then
    if exists (
      select 1
      from public.workforce_payment_allocations allocation
      join public.workforce workforce
        on workforce.id = allocation.workforce_id
       and workforce.company_id = allocation.company_id
      where workforce.company_id = new.company_id
        and (
          allocation.designation_id = new.id
          or workforce.designation_id = new.id
          or (workforce.designation_id is null and lower(btrim(workforce.designation)) in (lower(btrim(new.code)), lower(btrim(new.name))))
        )
        and allocation.status <> 'cancelled'
        and (allocation.effective_to is null or allocation.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
    ) then
      raise exception 'Close active direct payment allocations before requiring provider mapping, disabling Field Operations or deactivating this designation.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists designations_direct_payment_policy_guard on public.designations;
create trigger designations_direct_payment_policy_guard
before update of provider_mapping_required, is_field_operations, is_active
on public.designations
for each row execute function public.guard_designation_direct_payment_policy();

create or replace function public.save_workforce_payment_allocation(
  p_company_id uuid,
  p_workforce_id uuid,
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
set search_path = public, pg_temp
as $$
declare
  v_current public.workforce_payment_allocations%rowtype;
  v_location_id uuid;
  v_station_code text;
  v_designation_id uuid;
  v_designation_code text;
  v_designation_name text;
  v_component record;
  v_component_count integer := 0;
  v_payment_components jsonb := '[]'::jsonb;
  v_result_id uuid;
begin
  if p_effective_from is null then
    raise exception 'Effective from date is required.';
  end if;
  if p_effective_to is not null and p_effective_to < p_effective_from then
    raise exception 'Effective to date cannot be before effective from date.';
  end if;
  if p_payment_values is null or jsonb_typeof(p_payment_values) <> 'object' then
    raise exception 'Payment values must be a JSON object.';
  end if;

  select
    workforce.location_id,
    station.station_code,
    designation.id,
    designation.code,
    designation.name
  into
    v_location_id,
    v_station_code,
    v_designation_id,
    v_designation_code,
    v_designation_name
  from public.workforce workforce
  join lateral (
    select candidate.*
    from public.designations candidate
    where candidate.company_id = workforce.company_id
      and (
        candidate.id = workforce.designation_id
        or (workforce.designation_id is null and lower(btrim(workforce.designation)) in (lower(btrim(candidate.code)), lower(btrim(candidate.name))))
      )
    order by (candidate.id = workforce.designation_id) desc, candidate.id
    limit 1
  ) designation on true
  join public.stations station
    on station.id = workforce.location_id
   and station.company_id = workforce.company_id
   and station.is_active = true
  where workforce.id = p_workforce_id
    and workforce.company_id = p_company_id
    and workforce.is_active = true
    and workforce.deleted_at is null
    and designation.is_active = true
    and designation.is_field_operations = true
    and designation.provider_mapping_required = false;

  if not found then
    raise exception 'Workforce member must be active, have an active company location and use a designation enabled for direct payment allocation.';
  end if;

  if not exists (
    select 1
    from public.payment_methods method
    where method.id = p_payment_method_id
      and method.company_id = p_company_id
      and method.is_active = true
  ) then
    raise exception 'Payment method is not active for this company.';
  end if;

  for v_component in
    select
      component.component_code,
      component.component_type,
      coalesce(field.label, component.label) as label,
      coalesce(field.pay_schedule, component.pay_schedule) as pay_schedule,
      field.calculation_type,
      component.sort_order
    from public.payment_method_components component
    left join public.payment_fields field
      on field.id = component.payment_field_id
     and field.company_id = p_company_id
    where component.payment_method_id = p_payment_method_id
      and component.company_id = p_company_id
      and component.is_active = true
    order by component.sort_order, component.component_code
  loop
    if v_component.component_type = 'production' then
      raise exception 'Direct payment allocation cannot use a payment method with production components.';
    end if;
    if v_component.component_type <> 'amount'
      or v_component.pay_schedule is null
      or v_component.pay_schedule not in ('per_hour', 'per_day', 'per_month') then
      raise exception 'Every direct payment amount requires a per-hour, per-day or per-month schedule.';
    end if;
    v_component_count := v_component_count + 1;
    v_payment_components := v_payment_components || jsonb_build_array(jsonb_build_object(
      'component_code', v_component.component_code,
      'component_type', v_component.component_type,
      'label', v_component.label,
      'pay_schedule', v_component.pay_schedule,
      'calculation_type', v_component.calculation_type,
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
    raise exception 'Direct payment allocation requires at least one active amount component.';
  end if;

  if exists (
    select 1
    from jsonb_object_keys(p_payment_values) supplied(component_code)
    where not exists (
      select 1
      from public.payment_method_components component
      where component.payment_method_id = p_payment_method_id
        and component.company_id = p_company_id
        and component.is_active = true
        and component.component_type = 'amount'
        and component.component_code = supplied.component_code
    )
  ) then
    raise exception 'Payment values contain a field that is not part of the selected payment method.';
  end if;

  select allocation.*
  into v_current
  from public.workforce_payment_allocations allocation
  where allocation.company_id = p_company_id
    and allocation.workforce_id = p_workforce_id
    and allocation.status <> 'cancelled'
    and allocation.effective_from <= p_effective_from
    and (allocation.effective_to is null or allocation.effective_to >= p_effective_from)
  order by allocation.effective_from desc, allocation.created_at desc
  limit 1
  for update;

  if found and p_effective_from = v_current.effective_from then
    update public.workforce_payment_allocations
    set station_id = v_location_id,
        station_code_snapshot = v_station_code,
        designation_id = v_designation_id,
        designation_code_snapshot = v_designation_code,
        designation_name_snapshot = v_designation_name,
        payment_method_id = p_payment_method_id,
        payment_values = p_payment_values,
        payment_components = v_payment_components,
        effective_to = p_effective_to,
        status = case when p_effective_to is null then 'active' else 'closed' end,
        change_reason = nullif(btrim(p_change_reason), ''),
        updated_by = p_actor_user_id,
        updated_at = now()
    where id = v_current.id
    returning id into v_result_id;
    return v_result_id;
  end if;

  if found then
    update public.workforce_payment_allocations
    set effective_to = p_effective_from - 1,
        status = 'closed',
        updated_by = p_actor_user_id,
        updated_at = now()
    where id = v_current.id;
  end if;

  insert into public.workforce_payment_allocations (
    company_id,
    workforce_id,
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
    p_workforce_id,
    v_location_id,
    v_station_code,
    v_designation_id,
    v_designation_code,
    v_designation_name,
    p_payment_method_id,
    p_payment_values,
    v_payment_components,
    p_effective_from,
    p_effective_to,
    case when p_effective_to is null then 'active' else 'closed' end,
    nullif(btrim(p_change_reason), ''),
    p_actor_user_id,
    p_actor_user_id
  )
  returning id into v_result_id;

  return v_result_id;
end;
$$;

alter table public.workforce_payment_allocations enable row level security;
revoke all on table public.workforce_payment_allocations from public, anon, authenticated;
grant select, insert, update, delete on table public.workforce_payment_allocations to service_role;

drop policy if exists workforce_payment_allocations_service_role_policy
  on public.workforce_payment_allocations;
create policy workforce_payment_allocations_service_role_policy
  on public.workforce_payment_allocations
  for all
  to service_role
  using (true)
  with check (true);

revoke all on function public.save_workforce_payment_allocation(uuid, uuid, uuid, jsonb, date, date, text, uuid)
  from public, anon, authenticated;
grant execute on function public.save_workforce_payment_allocation(uuid, uuid, uuid, jsonb, date, date, text, uuid)
  to service_role;

commit;
