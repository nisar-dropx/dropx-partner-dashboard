-- Ensure recruitment/telecaller onboarding always uses the active configured
-- DropX ID series. The normal Ops onboarding flow already generates its ID
-- before insertion, so this trigger is deliberately limited to telecaller rows.

create or replace function public.assign_telecaller_configured_dropx_id()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_designation_id uuid;
  v_generated_id text;
begin
  if coalesce(new.onboarding_application_source, '') <> 'telecaller' then
    return new;
  end if;

  -- Preserve the legacy recruitment behavior unless this company has enabled
  -- Multi Designation Wise generation.
  if not exists (
    select 1
    from public.dropx_id_generation_settings settings
    where settings.company_id = new.company_id
      and settings.setting_type = 'dropx_id'
      and settings.is_active = true
      and settings.scope_type = 'multi_designation'
  ) then
    return new;
  end if;

  select designation.id
    into v_designation_id
  from public.designations designation
  where designation.company_id = new.company_id
    and designation.is_active = true
    and (
      lower(btrim(designation.name)) = lower(btrim(new.designation))
      or lower(btrim(designation.code)) = lower(btrim(new.designation))
    )
  order by
    case when lower(btrim(designation.name)) = lower(btrim(new.designation)) then 0 else 1 end,
    designation.created_at
  limit 1;

  if v_designation_id is null then
    raise exception using
      errcode = '23514',
      message = format('Cannot generate DropX ID: designation "%s" was not found.', coalesce(new.designation, ''));
  end if;

  v_generated_id := public.generate_dropx_worker_id(
    new.company_id,
    'field_executives',
    new.location_id,
    null,
    v_designation_id
  );

  if nullif(btrim(v_generated_id), '') is null then
    raise exception using
      errcode = '23514',
      message = format('Cannot add this person: designation "%s" is not mapped to a DropX ID series.', new.designation);
  end if;

  new.dropx_id := v_generated_id;
  return new;
end;
$$;

drop trigger if exists field_executives_telecaller_configured_dropx_id
  on public.field_executives;

create trigger field_executives_telecaller_configured_dropx_id
before insert on public.field_executives
for each row
execute function public.assign_telecaller_configured_dropx_id();

