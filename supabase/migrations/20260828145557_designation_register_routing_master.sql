-- Workforce Register Master and designation-to-register routing.
-- Business routing is stored in tables. The table-name checks below are only a
-- security boundary around the physical profile tables that this release knows
-- how to reconcile.

create table if not exists public.workforce_register_master (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null,
  name text not null,
  table_name text not null,
  profile_type text not null,
  description text,
  is_system boolean not null default true,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_register_master_company_code_unique unique (company_id, code),
  constraint workforce_register_master_company_table_unique unique (company_id, table_name),
  constraint workforce_register_master_code_check check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint workforce_register_master_table_check check (table_name in ('employees', 'contractors', 'workforce', 'vendors', 'workers'))
);

create table if not exists public.designation_register_routes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  designation_id uuid not null references public.designations(id) on delete cascade,
  register_id uuid references public.workforce_register_master(id) on delete restrict,
  registration_enabled boolean not null default false,
  mapping_source text not null default 'manual',
  reconciliation_status text not null default 'unmapped',
  last_reconciled_at timestamptz,
  last_reconciliation jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint designation_register_routes_designation_unique unique (designation_id),
  constraint designation_register_routes_company_designation_unique unique (company_id, designation_id),
  constraint designation_register_routes_mapping_source_check check (mapping_source in ('seeded', 'manual')),
  constraint designation_register_routes_status_check check (reconciliation_status in ('unmapped', 'pending', 'complete', 'needs_review', 'failed'))
);

create table if not exists public.designation_register_route_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  designation_id uuid not null references public.designations(id) on delete cascade,
  route_id uuid references public.designation_register_routes(id) on delete set null,
  event_code text not null,
  before_value jsonb,
  after_value jsonb,
  reconciliation_result jsonb,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.person_register_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  designation_id uuid not null references public.designations(id) on delete restrict,
  source_register text not null,
  source_profile_id uuid not null,
  target_register text not null,
  target_profile_id uuid not null,
  compatibility_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint person_register_links_source_unique unique (company_id, source_register, source_profile_id),
  constraint person_register_links_source_check check (source_register in ('employees', 'contractors', 'workforce', 'vendors', 'workers', 'field_executives')),
  constraint person_register_links_target_check check (target_register in ('employees', 'contractors', 'workforce', 'vendors', 'workers'))
);

create index if not exists designation_register_routes_company_register_idx
  on public.designation_register_routes(company_id, register_id);
create index if not exists designation_register_route_events_company_created_idx
  on public.designation_register_route_events(company_id, created_at desc);
create index if not exists person_register_links_target_idx
  on public.person_register_links(company_id, target_register, target_profile_id);

alter table public.workforce_register_master enable row level security;
alter table public.designation_register_routes enable row level security;
alter table public.designation_register_route_events enable row level security;
alter table public.person_register_links enable row level security;

revoke all on public.workforce_register_master from anon, authenticated;
revoke all on public.designation_register_routes from anon, authenticated;
revoke all on public.designation_register_route_events from anon, authenticated;
revoke all on public.person_register_links from anon, authenticated;
grant all on public.workforce_register_master to service_role;
grant all on public.designation_register_routes to service_role;
grant all on public.designation_register_route_events to service_role;
grant all on public.person_register_links to service_role;

insert into public.workforce_register_master (
  company_id, code, name, table_name, profile_type, description, sort_order
)
select company.id, seed.code, seed.name, seed.table_name, seed.profile_type, seed.description, seed.sort_order
from public.companies company
cross join (values
  ('employees', 'Employees', 'employees', 'employee', 'Payroll employees managed by People.', 10),
  ('contractors', 'Independent Contractors', 'contractors', 'contractor', 'Independent contractors that remain outside the canonical Workforce register.', 20),
  ('workforce', 'Workforce', 'workforce', 'workforce', 'Canonical operational workforce register, including field onboarding.', 30),
  ('vendors', 'Vendors', 'vendors', 'vendor', 'Vendor and vendor-owned profiles.', 40),
  ('workers', 'Helpers / Workers', 'workers', 'worker', 'Helper and worker profiles.', 50)
) as seed(code, name, table_name, profile_type, description, sort_order)
where company.is_active
on conflict (company_id, code) do update
set name = excluded.name,
    table_name = excluded.table_name,
    profile_type = excluded.profile_type,
    description = excluded.description,
    sort_order = excluded.sort_order,
    is_system = true,
    updated_at = now();

-- Create one routing row per designation. Only deterministic legacy mappings
-- are seeded. Multi-category HR designations intentionally remain unmapped.
insert into public.designation_register_routes (
  company_id,
  designation_id,
  register_id,
  registration_enabled,
  mapping_source,
  reconciliation_status
)
select
  designation.company_id,
  designation.id,
  target.id,
  target.id is not null,
  'seeded',
  case when target.id is null then 'unmapped' else 'pending' end
from public.designations designation
left join public.designation_categories category
  on category.id = designation.designation_category_id
 and category.company_id = designation.company_id
left join public.workforce_register_master target
  on target.company_id = designation.company_id
 and target.code = case
   when coalesce(cardinality(designation.onboarding_categories), 0) = 1
     and designation.onboarding_categories[1] = 'vendors' then 'vendors'
   when category.code = 'workforce' then 'workforce'
   when coalesce(cardinality(designation.onboarding_categories), 0) = 1
     and designation.onboarding_categories[1] = 'employees' then 'employees'
   when coalesce(cardinality(designation.onboarding_categories), 0) = 1
     and designation.onboarding_categories[1] = 'contractors' then 'contractors'
   when coalesce(cardinality(designation.onboarding_categories), 0) = 1
     and designation.onboarding_categories[1] = 'workers' then 'workers'
   when coalesce(cardinality(designation.onboarding_categories), 0) = 1
     and designation.onboarding_categories[1] = 'field_executives' then 'workforce'
   else null
 end
on conflict (designation_id) do nothing;

create or replace function public.seed_designation_register_route()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  category_code_value text;
  target_code_value text;
  target_id_value uuid;
begin
  if exists (
    select 1 from public.designation_register_routes route
    where route.designation_id = new.id
  ) then
    return new;
  end if;

  select category.code into category_code_value
  from public.designation_categories category
  where category.id = new.designation_category_id
    and category.company_id = new.company_id;

  target_code_value := case
    when coalesce(cardinality(new.onboarding_categories), 0) = 1
      and new.onboarding_categories[1] = 'vendors' then 'vendors'
    when category_code_value = 'workforce' then 'workforce'
    when coalesce(cardinality(new.onboarding_categories), 0) = 1
      and new.onboarding_categories[1] = 'employees' then 'employees'
    when coalesce(cardinality(new.onboarding_categories), 0) = 1
      and new.onboarding_categories[1] = 'contractors' then 'contractors'
    when coalesce(cardinality(new.onboarding_categories), 0) = 1
      and new.onboarding_categories[1] = 'workers' then 'workers'
    when coalesce(cardinality(new.onboarding_categories), 0) = 1
      and new.onboarding_categories[1] = 'field_executives' then 'workforce'
    else null
  end;

  select register.id into target_id_value
  from public.workforce_register_master register
  where register.company_id = new.company_id
    and register.code = target_code_value
    and register.is_active;

  insert into public.designation_register_routes (
    company_id, designation_id, register_id, registration_enabled,
    mapping_source, reconciliation_status
  ) values (
    new.company_id, new.id, target_id_value, target_id_value is not null,
    'seeded', case when target_id_value is null then 'unmapped' else 'pending' end
  )
  on conflict (designation_id) do nothing;

  return new;
end;
$$;

drop trigger if exists designations_seed_register_route on public.designations;
create trigger designations_seed_register_route
after insert on public.designations
for each row execute function public.seed_designation_register_route();

create or replace function public.resolve_designation_register(
  p_company_id uuid,
  p_designation_id uuid default null,
  p_designation_value text default null
)
returns table (
  designation_id uuid,
  register_id uuid,
  register_code text,
  table_name text,
  profile_type text,
  registration_enabled boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    designation.id,
    register.id,
    register.code,
    register.table_name,
    register.profile_type,
    route.registration_enabled and register.is_active
  from public.designations designation
  join public.designation_register_routes route
    on route.designation_id = designation.id
   and route.company_id = designation.company_id
  join public.workforce_register_master register
    on register.id = route.register_id
   and register.company_id = route.company_id
  where designation.company_id = p_company_id
    and designation.is_active
    and (
      (p_designation_id is not null and designation.id = p_designation_id)
      or (
        p_designation_id is null
        and nullif(btrim(p_designation_value), '') is not null
        and (
          upper(designation.code) = upper(btrim(p_designation_value))
          or lower(btrim(designation.name)) = lower(btrim(p_designation_value))
        )
      )
    )
  order by case when lower(btrim(designation.name)) = lower(btrim(p_designation_value)) then 0 else 1 end
  limit 1;
$$;

-- Allow canonical rows and safe reconciliation sources in the Workforce table.
alter table public.workforce drop constraint if exists workforce_source_profile_type_check;
alter table public.workforce add constraint workforce_source_profile_type_check
  check (source_profile_type in ('field_executive', 'contractor', 'employee', 'vendor', 'worker', 'canonical'));

-- Apply defaults for omitted JSON properties instead of turning every omitted
-- property into NULL. Existing callers keep the same function signature.
create or replace function public.upsert_record_from_json(p_target_table regclass, p_record jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  column_list text;
  assignment_list text;
  target_id uuid;
begin
  if p_target_table not in (
    'public.employees'::regclass,
    'public.contractors'::regclass,
    'public.workforce'::regclass,
    'public.vendors'::regclass,
    'public.workers'::regclass,
    'public.field_executives'::regclass
  ) then
    raise exception 'Unsupported profile table: %', p_target_table;
  end if;

  select
    string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
    string_agg(
      format('%1$I = excluded.%1$I', attribute.attname),
      ', ' order by attribute.attnum
    ) filter (where attribute.attname <> 'id')
  into column_list, assignment_list
  from pg_catalog.pg_attribute attribute
  where attribute.attrelid = p_target_table
    and attribute.attnum > 0
    and not attribute.attisdropped
    and attribute.attgenerated = ''
    and p_record ? attribute.attname;

  if column_list is null or not (p_record ? 'id') then
    raise exception 'Profile payload must contain an id for %', p_target_table;
  end if;

  execute format(
    'insert into %1$s (%2$s) select %2$s from jsonb_populate_record(null::%1$s, $1) '
      'on conflict (id) do update set %3$s returning id',
    p_target_table,
    column_list,
    assignment_list
  )
  into target_id
  using p_record;

  return target_id;
end;
$$;

create or replace function public.route_profile_record(
  p_source_register text,
  p_record jsonb,
  p_designation_id uuid,
  p_target_register text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  company_id_value uuid := nullif(p_record ->> 'company_id', '')::uuid;
  source_id_value uuid := nullif(p_record ->> 'id', '')::uuid;
  designation_name_value text;
  target_id_value uuid;
  payload_value jsonb;
  target_table_value regclass;
  source_profile_type_value text;
begin
  if p_source_register not in ('employees', 'contractors', 'workforce', 'vendors', 'workers', 'field_executives') then
    raise exception 'Unsupported source register: %', p_source_register;
  end if;
  if p_target_register not in ('employees', 'contractors', 'workforce', 'vendors', 'workers') then
    raise exception 'Unsupported target register: %', p_target_register;
  end if;
  if company_id_value is null or source_id_value is null or p_designation_id is null then
    raise exception 'Company, profile id, and designation are required for reconciliation.';
  end if;

  select designation.name into designation_name_value
  from public.designations designation
  where designation.id = p_designation_id
    and designation.company_id = company_id_value;
  if designation_name_value is null then
    raise exception 'Designation is not available for this company.';
  end if;

  if p_source_register = p_target_register then
    target_id_value := source_id_value;
  else
    payload_value := p_record || jsonb_build_object(
      'id', source_id_value,
      'company_id', company_id_value,
      'designation', designation_name_value,
      'designation_id', p_designation_id,
      'updated_at', now()
    );

    if p_target_register = 'employees' then
      payload_value := payload_value || jsonb_build_object(
        'employee_code', coalesce(nullif(p_record ->> 'employee_code', ''), nullif(p_record ->> 'dropx_id', '')),
        'profile_completion_status', coalesce(nullif(p_record ->> 'profile_completion_status', ''), nullif(p_record ->> 'onboarding_status', ''), 'pending')
      );
      target_table_value := 'public.employees'::regclass;
    elsif p_target_register = 'workforce' then
      source_profile_type_value := case p_source_register
        when 'employees' then 'employee'
        when 'vendors' then 'vendor'
        when 'workers' then 'worker'
        when 'workforce' then 'canonical'
        when 'field_executives' then 'field_executive'
        else 'contractor'
      end;
      payload_value := payload_value || jsonb_build_object(
        'source_profile_type', source_profile_type_value,
        'source_profile_id', source_id_value,
        'approval_required', coalesce((p_record ->> 'approval_required')::boolean, true),
        'provider_id_status', coalesce(nullif(p_record ->> 'provider_id_status', ''), 'pending'),
        'compatibility_mode', p_source_register <> 'workforce',
        'migration_state', case when p_source_register = 'workforce' then 'canonical' else 'mirrored' end,
        'synced_at', now()
      );
      target_table_value := 'public.workforce'::regclass;
    elsif p_target_register = 'contractors' then
      payload_value := payload_value || jsonb_build_object(
        'dropx_id', coalesce(nullif(p_record ->> 'dropx_id', ''), nullif(p_record ->> 'employee_code', '')),
        'onboarding_status', coalesce(nullif(p_record ->> 'onboarding_status', ''), nullif(p_record ->> 'profile_completion_status', ''), 'pending')
      );
      target_table_value := 'public.contractors'::regclass;
    elsif p_target_register = 'vendors' then
      payload_value := payload_value || jsonb_build_object(
        'dropx_id', coalesce(nullif(p_record ->> 'dropx_id', ''), nullif(p_record ->> 'employee_code', '')),
        'onboarding_status', coalesce(nullif(p_record ->> 'onboarding_status', ''), nullif(p_record ->> 'profile_completion_status', ''), 'pending')
      );
      target_table_value := 'public.vendors'::regclass;
    else
      payload_value := payload_value || jsonb_build_object(
        'dropx_id', coalesce(nullif(p_record ->> 'dropx_id', ''), nullif(p_record ->> 'employee_code', '')),
        'onboarding_status', coalesce(nullif(p_record ->> 'onboarding_status', ''), nullif(p_record ->> 'profile_completion_status', ''), 'pending')
      );
      target_table_value := 'public.workers'::regclass;
    end if;

    target_id_value := public.upsert_record_from_json(target_table_value, payload_value);

    perform set_config('dropx.routing_skip_sync', 'on', true);
    execute format(
      'update public.%I set is_active = false, updated_at = now() where id = $1 and company_id = $2',
      p_source_register
    ) using source_id_value, company_id_value;
    perform set_config('dropx.routing_skip_sync', 'off', true);
  end if;

  insert into public.person_register_links (
    company_id, designation_id, source_register, source_profile_id,
    target_register, target_profile_id, compatibility_active, updated_at
  ) values (
    company_id_value, p_designation_id, p_source_register, source_id_value,
    p_target_register, target_id_value, p_source_register <> p_target_register, now()
  )
  on conflict (company_id, source_register, source_profile_id) do update
  set designation_id = excluded.designation_id,
      target_register = excluded.target_register,
      target_profile_id = excluded.target_profile_id,
      compatibility_active = excluded.compatibility_active,
      updated_at = now();

  return target_id_value;
end;
$$;

create or replace function public.sync_workforce_legacy_payload(p_source_profile_type text, p_record jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  company_id_value uuid := nullif(p_record ->> 'company_id', '')::uuid;
  source_id_value uuid := nullif(p_record ->> 'id', '')::uuid;
  route_value record;
  source_register_value text;
  target_id_value uuid;
  delivery_associate_id_value uuid;
begin
  if current_setting('dropx.routing_skip_sync', true) = 'on' then
    return source_id_value;
  end if;
  if p_source_profile_type not in ('field_executive', 'contractor') then
    raise exception 'Unsupported legacy Workforce source: %', p_source_profile_type;
  end if;
  if company_id_value is null or source_id_value is null then
    return null;
  end if;

  select * into route_value
  from public.resolve_designation_register(
    company_id_value,
    null,
    p_record ->> 'designation'
  );
  if route_value.designation_id is null or not route_value.registration_enabled then
    return null;
  end if;

  source_register_value := case p_source_profile_type
    when 'field_executive' then 'field_executives'
    else 'contractors'
  end;
  target_id_value := public.route_profile_record(
    source_register_value,
    p_record,
    route_value.designation_id,
    route_value.table_name
  );

  if route_value.table_name <> 'workforce' then
    update public.workforce
    set migration_state = case when route_value.table_name = 'vendors' then 'moved_to_vendor' else 'reclassified' end,
        compatibility_mode = false,
        is_active = false,
        synced_at = now(),
        updated_at = now()
    where company_id = company_id_value
      and source_profile_type = p_source_profile_type
      and source_profile_id = source_id_value;
  end if;

  select associate.id into delivery_associate_id_value
  from public.delivery_associates associate
  where nullif(p_record ->> 'dropx_id', '') is not null
    and upper(associate.dropx_id) = upper(p_record ->> 'dropx_id')
  limit 1;

  if route_value.table_name in ('workforce', 'vendors') then
    insert into public.workforce_identity_links (
      company_id, target_profile_type, target_profile_id,
      legacy_profile_type, legacy_profile_id, delivery_associate_id,
      compatibility_active, updated_at
    ) values (
      company_id_value,
      case when route_value.table_name = 'vendors' then 'vendor' else 'workforce' end,
      target_id_value,
      p_source_profile_type,
      source_id_value,
      delivery_associate_id_value,
      true,
      now()
    )
    on conflict (company_id, legacy_profile_type, legacy_profile_id) do update
    set target_profile_type = excluded.target_profile_type,
        target_profile_id = excluded.target_profile_id,
        delivery_associate_id = excluded.delivery_associate_id,
        compatibility_active = true,
        updated_at = now();
  else
    update public.workforce_identity_links
    set compatibility_active = false, updated_at = now()
    where company_id = company_id_value
      and legacy_profile_type = p_source_profile_type
      and legacy_profile_id = source_id_value;
  end if;

  return target_id_value;
end;
$$;

create or replace function public.reconcile_designation_register_route(
  p_company_id uuid,
  p_designation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  route_value record;
  designation_value record;
  source_register_value text;
  source_record_value jsonb;
  moved_count integer := 0;
  retained_count integer := 0;
  failed_count integer := 0;
  failure_samples jsonb := '[]'::jsonb;
begin
  select * into route_value
  from public.resolve_designation_register(p_company_id, p_designation_id, null);
  if route_value.designation_id is null then
    raise exception 'Map this designation to an active register before reconciling.';
  end if;

  select id, code, name into designation_value
  from public.designations
  where id = p_designation_id and company_id = p_company_id;

  foreach source_register_value in array array['employees', 'contractors', 'vendors', 'workers', 'workforce', 'field_executives'] loop
    for source_record_value in execute case
      when source_register_value in ('employees', 'workforce') then format(
        'select to_jsonb(profile) from public.%I profile where profile.company_id = $1 and profile.designation_id = $2',
        source_register_value
      )
      else format(
        'select to_jsonb(profile) from public.%I profile where profile.company_id = $1 and (upper(profile.designation) = upper($3) or lower(btrim(profile.designation)) = lower(btrim($4)))',
        source_register_value
      )
    end using p_company_id, p_designation_id, designation_value.code, designation_value.name
    loop
      begin
        perform public.route_profile_record(
          source_register_value,
          source_record_value,
          p_designation_id,
          route_value.table_name
        );
        if source_register_value = route_value.table_name then
          retained_count := retained_count + 1;
        else
          moved_count := moved_count + 1;
        end if;
      exception when others then
        failed_count := failed_count + 1;
        if jsonb_array_length(failure_samples) < 10 then
          failure_samples := failure_samples || jsonb_build_array(jsonb_build_object(
            'source_register', source_register_value,
            'source_profile_id', source_record_value ->> 'id',
            'error', sqlerrm
          ));
        end if;
      end;
    end loop;
  end loop;

  return jsonb_build_object(
    'target_register', route_value.table_name,
    'moved', moved_count,
    'retained', retained_count,
    'failed', failed_count,
    'failure_samples', failure_samples,
    'completed_at', now()
  );
end;
$$;

create or replace function public.set_designation_register_route(
  p_company_id uuid,
  p_designation_id uuid,
  p_register_id uuid,
  p_registration_enabled boolean,
  p_actor_user_id uuid default null,
  p_reconcile boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_value jsonb;
  route_id_value uuid;
  result_value jsonb := '{}'::jsonb;
  status_value text;
begin
  if not exists (
    select 1 from public.designations designation
    where designation.id = p_designation_id
      and designation.company_id = p_company_id
  ) then
    raise exception 'Designation is not available for this company.';
  end if;
  if p_register_id is not null and not exists (
    select 1 from public.workforce_register_master register
    where register.id = p_register_id
      and register.company_id = p_company_id
      and register.is_active
  ) then
    raise exception 'Target register is not active for this company.';
  end if;

  select to_jsonb(route) into existing_value
  from public.designation_register_routes route
  where route.designation_id = p_designation_id
    and route.company_id = p_company_id;

  insert into public.designation_register_routes (
    company_id, designation_id, register_id, registration_enabled,
    mapping_source, reconciliation_status, created_by, updated_by, updated_at
  ) values (
    p_company_id, p_designation_id, p_register_id,
    p_registration_enabled and p_register_id is not null,
    'manual', case when p_register_id is null then 'unmapped' else 'pending' end,
    p_actor_user_id, p_actor_user_id, now()
  )
  on conflict (designation_id) do update
  set register_id = excluded.register_id,
      registration_enabled = excluded.registration_enabled,
      mapping_source = 'manual',
      reconciliation_status = excluded.reconciliation_status,
      updated_by = excluded.updated_by,
      updated_at = now()
  returning id into route_id_value;

  if p_register_id is not null and p_reconcile then
    begin
      result_value := public.reconcile_designation_register_route(p_company_id, p_designation_id);
      status_value := case when coalesce((result_value ->> 'failed')::integer, 0) > 0 then 'needs_review' else 'complete' end;
    exception when others then
      result_value := jsonb_build_object('failed', 1, 'error', sqlerrm, 'completed_at', now());
      status_value := 'failed';
    end;

    update public.designation_register_routes
    set reconciliation_status = status_value,
        last_reconciled_at = now(),
        last_reconciliation = result_value,
        updated_at = now()
    where id = route_id_value;
  elsif p_register_id is null then
    status_value := 'unmapped';
  else
    status_value := 'pending';
  end if;

  insert into public.designation_register_route_events (
    company_id, designation_id, route_id, event_code,
    before_value, after_value, reconciliation_result, actor_user_id
  )
  select
    p_company_id,
    p_designation_id,
    route.id,
    case when p_register_id is null then 'designation_route_unmapped' else 'designation_route_saved' end,
    existing_value,
    to_jsonb(route),
    result_value,
    p_actor_user_id
  from public.designation_register_routes route
  where route.id = route_id_value;

  return jsonb_build_object(
    'route_id', route_id_value,
    'status', status_value,
    'reconciliation', result_value
  );
end;
$$;

create or replace function public.designation_register_counts(p_company_id uuid)
returns table (
  designation_id uuid,
  table_name text,
  total_count bigint,
  active_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  register_value text;
begin
  foreach register_value in array array['employees', 'contractors', 'workforce', 'vendors', 'workers'] loop
    if register_value in ('employees', 'workforce') then
      return query execute format(
        'select designation.id, %L::text, count(profile.id), count(profile.id) filter (where profile.is_active) '
          'from public.designations designation '
          'left join public.%I profile on profile.company_id = designation.company_id and profile.designation_id = designation.id '
          'where designation.company_id = $1 group by designation.id',
        register_value,
        register_value
      ) using p_company_id;
    else
      return query execute format(
        'select designation.id, %L::text, count(profile.id), count(profile.id) filter (where profile.is_active) '
          'from public.designations designation '
          'left join public.%I profile on profile.company_id = designation.company_id '
          'and (upper(profile.designation) = upper(designation.code) or lower(btrim(profile.designation)) = lower(btrim(designation.name))) '
          'where designation.company_id = $1 group by designation.id',
        register_value,
        register_value
      ) using p_company_id;
    end if;
  end loop;
end;
$$;

create or replace function public.enforce_designation_register_route()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  route_value record;
  designation_id_value uuid;
  designation_value text;
begin
  if tg_op = 'UPDATE' then
    if tg_table_name in ('employees', 'workforce') and new.designation_id is not distinct from old.designation_id then
      return new;
    elsif tg_table_name not in ('employees', 'workforce') and new.designation is not distinct from old.designation then
      return new;
    end if;
  end if;

  if tg_table_name in ('employees', 'workforce') then
    designation_id_value := new.designation_id;
  else
    designation_value := new.designation;
  end if;

  select * into route_value
  from public.resolve_designation_register(new.company_id, designation_id_value, designation_value);
  if route_value.designation_id is null then
    raise exception 'This designation is not mapped in Workforce Master. Map it before registration.';
  end if;
  if not route_value.registration_enabled then
    raise exception 'Registration is disabled for this designation in Workforce Master.';
  end if;
  if route_value.table_name = tg_table_name then
    return new;
  end if;
  if tg_table_name in ('contractors', 'field_executives') and route_value.table_name = 'workforce' then
    return new;
  end if;
  raise exception 'Designation is routed to %, not %.', route_value.table_name, tg_table_name;
end;
$$;

drop trigger if exists employees_enforce_designation_register on public.employees;
create trigger employees_enforce_designation_register
before insert or update of designation_id on public.employees
for each row execute function public.enforce_designation_register_route();

drop trigger if exists contractors_enforce_designation_register on public.contractors;
create trigger contractors_enforce_designation_register
before insert or update of designation on public.contractors
for each row execute function public.enforce_designation_register_route();

drop trigger if exists vendors_enforce_designation_register on public.vendors;
create trigger vendors_enforce_designation_register
before insert or update of designation on public.vendors
for each row execute function public.enforce_designation_register_route();

drop trigger if exists workers_enforce_designation_register on public.workers;
create trigger workers_enforce_designation_register
before insert or update of designation on public.workers
for each row execute function public.enforce_designation_register_route();

drop trigger if exists workforce_enforce_designation_register on public.workforce;
create trigger workforce_enforce_designation_register
before insert or update of designation_id on public.workforce
for each row execute function public.enforce_designation_register_route();

drop trigger if exists field_executives_enforce_designation_register on public.field_executives;
create trigger field_executives_enforce_designation_register
before insert or update of designation on public.field_executives
for each row execute function public.enforce_designation_register_route();

revoke all on function public.seed_designation_register_route() from public, anon, authenticated;
revoke all on function public.resolve_designation_register(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.upsert_record_from_json(regclass, jsonb) from public, anon, authenticated;
revoke all on function public.route_profile_record(text, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.sync_workforce_legacy_payload(text, jsonb) from public, anon, authenticated;
revoke all on function public.reconcile_designation_register_route(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_designation_register_route(uuid, uuid, uuid, boolean, uuid, boolean) from public, anon, authenticated;
revoke all on function public.designation_register_counts(uuid) from public, anon, authenticated;
revoke all on function public.enforce_designation_register_route() from public, anon, authenticated;

grant execute on function public.resolve_designation_register(uuid, uuid, text) to service_role;
grant execute on function public.reconcile_designation_register_route(uuid, uuid) to service_role;
grant execute on function public.set_designation_register_route(uuid, uuid, uuid, boolean, uuid, boolean) to service_role;
grant execute on function public.designation_register_counts(uuid) to service_role;
