begin;

-- Workforce / employee inserts historically supplied designation text without
-- designation_id. The register-route trigger only looked up by designation_id
-- for those tables, so valid DA onboarding failed with
-- "This designation is not configured in Designation Master."
-- Resolve by id when present, otherwise fall back to designation name/code,
-- and backfill designation_id when the text match succeeds.
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
    if tg_table_name = 'employees' and new.designation_id is not distinct from old.designation_id then
      return new;
    elsif tg_table_name = 'workforce'
       and new.designation_id is not distinct from old.designation_id
       and new.designation is not distinct from old.designation then
      return new;
    elsif tg_table_name not in ('employees', 'workforce')
       and new.designation is not distinct from old.designation then
      return new;
    end if;
  end if;

  if tg_table_name = 'employees' then
    designation_id_value := new.designation_id;
  elsif tg_table_name = 'workforce' then
    designation_id_value := new.designation_id;
    designation_value := new.designation;
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
        and nullif(btrim(coalesce(designation_value, '')), '') is not null
        and (
          upper(designation.code) = upper(btrim(designation_value))
          or lower(btrim(designation.name)) = lower(btrim(designation_value))
        )
      )
    )
  order by
    case when designation_id_value is not null and designation.id = designation_id_value then 0 else 1 end,
    case when lower(btrim(designation.name)) = lower(btrim(coalesce(designation_value, ''))) then 0 else 1 end
  limit 1;

  if designation_id_value is null then
    raise exception 'This designation is not configured in Designation Master.';
  end if;

  if tg_table_name = 'workforce' and new.designation_id is null then
    new.designation_id := designation_id_value;
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

revoke all on function public.enforce_designation_register_route()
  from public, anon, authenticated;

drop trigger if exists workforce_enforce_designation_register on public.workforce;
create trigger workforce_enforce_designation_register
before insert or update of designation_id, designation on public.workforce
for each row execute function public.enforce_designation_register_route();

notify pgrst, 'reload schema';

commit;
