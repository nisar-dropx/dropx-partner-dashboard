begin;

-- Designation Category is the source of truth for the People/Workforce split.
-- People roles may use either Employees or Independent Contractors according to
-- the designation's enabled onboarding categories. Delivery-network roles must
-- use Workforce, Vendors or Workers and can never remain active in Contractors.
create or replace function public.enforce_designation_workspace_register_boundary()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  people_module_value text;
  target_table_value text;
begin
  select category.people_module
  into people_module_value
  from public.designations designation
  join public.designation_categories category
    on category.id = designation.designation_category_id
   and category.company_id = designation.company_id
  where designation.id = new.designation_id
    and designation.company_id = new.company_id;

  select register.table_name
  into target_table_value
  from public.workforce_register_master register
  where register.id = new.register_id
    and register.company_id = new.company_id;

  if new.register_id is null then
    return new;
  end if;

  if lower(coalesce(people_module_value, '')) like 'people%'
     and target_table_value not in ('employees', 'contractors') then
    raise exception 'People designations may be routed only to Employees or Independent Contractors.';
  end if;

  if lower(coalesce(people_module_value, '')) not like 'people%'
     and target_table_value in ('employees', 'contractors') then
    raise exception 'Workforce designations cannot be routed to Employees or Independent Contractors.';
  end if;

  return new;
end;
$$;

drop trigger if exists designation_routes_enforce_workspace_boundary
  on public.designation_register_routes;
create trigger designation_routes_enforce_workspace_boundary
before insert or update of register_id, registration_enabled
on public.designation_register_routes
for each row execute function public.enforce_designation_workspace_register_boundary();

-- Registration enforcement follows the same master boundary. A People
-- designation can deliberately support both employment forms without being
-- forced into a single physical register route.
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
  people_module_value text;
  onboarding_categories_value text[];
  expected_onboarding_category text;
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

  select designation.id, designation.onboarding_categories, category.people_module
  into designation_id_value, onboarding_categories_value, people_module_value
  from public.designations designation
  join public.designation_categories category
    on category.id = designation.designation_category_id
   and category.company_id = designation.company_id
  where designation.company_id = new.company_id
    and designation.is_active
    and (
      (designation_id_value is not null and designation.id = designation_id_value)
      or (
        designation_id_value is null
        and nullif(btrim(designation_value), '') is not null
        and (
          upper(designation.code) = upper(btrim(designation_value))
          or lower(btrim(designation.name)) = lower(btrim(designation_value))
        )
      )
    )
  order by case when lower(btrim(designation.name)) = lower(btrim(designation_value)) then 0 else 1 end
  limit 1;

  if designation_id_value is null then
    raise exception 'This designation is not configured in Designation Master.';
  end if;

  if lower(coalesce(people_module_value, '')) like 'people%' then
    expected_onboarding_category := case tg_table_name
      when 'employees' then 'employees'
      when 'contractors' then 'contractors'
      else null
    end;
    if expected_onboarding_category is null then
      raise exception 'People designations may be registered only as Employees or Independent Contractors.';
    end if;
    if not expected_onboarding_category = any(coalesce(onboarding_categories_value, '{}'::text[])) then
      raise exception 'This People designation is not enabled for the % register.', expected_onboarding_category;
    end if;
    return new;
  end if;

  if tg_table_name in ('employees', 'contractors') then
    raise exception 'Workforce designations cannot be registered as Employees or Independent Contractors.';
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
  if tg_table_name = 'field_executives' and route_value.table_name = 'workforce' then
    return new;
  end if;
  raise exception 'Designation is routed to %, not %.', route_value.table_name, tg_table_name;
end;
$$;

-- Reconcile every designation owned by the Workforce master category. Existing
-- register choices (Workforce, Vendors or Workers) are preserved; the migration
-- only removes legacy Contractor placement and fills missing compatibility links.
do $$
declare
  designation_row record;
  reconciliation jsonb;
begin
  for designation_row in
    select designation.id, designation.company_id, designation.code,
           route.register_id, register.table_name
    from public.designations designation
    join public.designation_categories category
      on category.id = designation.designation_category_id
     and category.company_id = designation.company_id
    left join public.designation_register_routes route
      on route.designation_id = designation.id
     and route.company_id = designation.company_id
    left join public.workforce_register_master register
      on register.id = route.register_id
     and register.company_id = route.company_id
     and register.is_active
    where designation.is_active
      and lower(coalesce(category.people_module, '')) not like 'people%'
    order by designation.company_id, designation.code
  loop
    if designation_row.register_id is null
       or designation_row.table_name in ('employees', 'contractors') then
      raise exception 'Workforce designation % does not have a valid non-People register.', designation_row.code;
    end if;

    reconciliation := public.set_designation_register_route(
      designation_row.company_id,
      designation_row.id,
      designation_row.register_id,
      true,
      null,
      true
    );

    if coalesce(reconciliation ->> 'status', '') <> 'complete'
       or coalesce((reconciliation #>> '{reconciliation,failed}')::integer, 0) <> 0 then
      raise exception 'Workforce reconciliation failed for designation %: %',
        designation_row.code,
        reconciliation;
    end if;
  end loop;
end;
$$;

-- Guard both the active state and the historical compatibility trail.
do $$
begin
  if exists (
    select 1
    from public.contractors contractor
    join public.designations designation
      on designation.company_id = contractor.company_id
     and designation.is_active
     and (
       upper(designation.code) = upper(btrim(contractor.designation))
       or lower(btrim(designation.name)) = lower(btrim(contractor.designation))
     )
    join public.designation_categories category
      on category.id = designation.designation_category_id
     and category.company_id = designation.company_id
    where lower(coalesce(category.people_module, '')) not like 'people%'
      and contractor.is_active
  ) then
    raise exception 'An active Workforce designation still exists in Independent Contractors.';
  end if;

  if exists (
    select 1
    from public.contractors contractor
    join public.designations designation
      on designation.company_id = contractor.company_id
     and designation.is_active
     and (
       upper(designation.code) = upper(btrim(contractor.designation))
       or lower(btrim(designation.name)) = lower(btrim(contractor.designation))
     )
    join public.designation_categories category
      on category.id = designation.designation_category_id
     and category.company_id = designation.company_id
    left join public.person_register_links link
      on link.company_id = contractor.company_id
     and link.source_register = 'contractors'
     and link.source_profile_id = contractor.id
     and link.target_register in ('workforce', 'vendors', 'workers')
    where lower(coalesce(category.people_module, '')) not like 'people%'
      and link.id is null
  ) then
    raise exception 'A historical Workforce contractor is missing its canonical register link.';
  end if;
end;
$$;

revoke all on function public.enforce_designation_workspace_register_boundary()
  from public, anon, authenticated;
revoke all on function public.enforce_designation_register_route()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
