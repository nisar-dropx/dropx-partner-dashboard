-- One provider member may work at several stations at the same time, but each
-- station-specific mapping must resolve to the same canonical Workforce person.
-- The application exposes this only through an explicit "Keep all" confirmation.
begin;

drop index if exists public.field_executive_provider_mappings_one_current_member_idx;

create unique index if not exists field_executive_provider_mappings_one_current_member_station_idx
  on public.field_executive_provider_mappings (
    company_id,
    provider_id,
    coalesce(station_id, '00000000-0000-0000-0000-000000000000'::uuid),
    upper(btrim(provider_member_id))
  )
  where effective_to is null and status = 'active';

create index if not exists field_executive_provider_mappings_current_workforce_member_idx
  on public.field_executive_provider_mappings (
    company_id,
    workforce_id,
    provider_id,
    upper(btrim(provider_member_id)),
    station_id
  )
  where workforce_id is not null and effective_to is null and status = 'active';

create or replace function public.workforce_provider_member_owner_guard()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  new_person uuid;
begin
  if new.status <> 'active' or new.effective_to is not null then
    return new;
  end if;

  new_person := public.workforce_provider_mapping_person(
    new.company_id,
    new.workforce_id,
    new.field_executive_id,
    new.employee_id,
    new.contractor_id
  );

  if exists (
    select 1
    from public.field_executive_provider_mappings mapping
    where mapping.company_id = new.company_id
      and mapping.id is distinct from new.id
      and mapping.provider_id = new.provider_id
      and upper(btrim(mapping.provider_member_id)) = upper(btrim(new.provider_member_id))
      and mapping.status = 'active'
      and mapping.effective_to is null
      and public.workforce_provider_mapping_person(
        mapping.company_id,
        mapping.workforce_id,
        mapping.field_executive_id,
        mapping.employee_id,
        mapping.contractor_id
      ) is distinct from new_person
  ) then
    raise exception 'All simultaneous location mappings for a Provider ID must use the same DropX ID';
  end if;

  return new;
end
$function$;

drop trigger if exists field_executive_provider_mappings_02_multi_location_owner_guard
  on public.field_executive_provider_mappings;
create trigger field_executive_provider_mappings_02_multi_location_owner_guard
before insert or update on public.field_executive_provider_mappings
for each row execute function public.workforce_provider_member_owner_guard();

revoke all on function public.workforce_provider_member_owner_guard()
from public, anon, authenticated;
grant execute on function public.workforce_provider_member_owner_guard()
to service_role;

-- PostgREST cannot apply the expression-index identity rule through a normal
-- column filter. Keep the dashboard's active-mapping lookup on the same
-- trim/case-insensitive key enforced by the unique index and owner guard.
create or replace function public.workforce_active_provider_member_mappings(
  p_company uuid,
  p_provider uuid,
  p_provider_member_id text
)
returns table (
  id uuid,
  workforce_id uuid,
  employee_id uuid,
  contractor_id uuid,
  field_executive_id uuid,
  station_id uuid,
  provider_id uuid,
  provider_member_id text
)
language sql
stable
security invoker
set search_path to ''
as $function$
  select
    mapping.id,
    mapping.workforce_id,
    mapping.employee_id,
    mapping.contractor_id,
    mapping.field_executive_id,
    mapping.station_id,
    mapping.provider_id,
    mapping.provider_member_id
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and (p_provider is null or mapping.provider_id = p_provider)
    and upper(btrim(mapping.provider_member_id))
      = upper(btrim(p_provider_member_id))
    and mapping.effective_to is null
    and mapping.status = 'active'
  order by mapping.created_at desc, mapping.id desc
$function$;

revoke all on function public.workforce_active_provider_member_mappings(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.workforce_active_provider_member_mappings(
  uuid, uuid, text
) to service_role;

create or replace function public.workforce_keep_joining_mapping(
  p_company uuid,
  p_actor uuid,
  p_workforce uuid,
  p_expected_existing_mapping uuid,
  p_dropx text,
  p_payload jsonb,
  p_locations uuid[],
  p_actor_name text
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  person public.workforce;
  existing_mapping public.field_executive_provider_mappings;
  mapping_payload public.field_executive_provider_mappings;
  new_mapping_id uuid;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if p_actor is null or p_expected_existing_mapping is null then
    raise exception 'An authenticated reviewer and confirmed existing mapping are required';
  end if;

  mapping_payload := jsonb_populate_record(
    null::public.field_executive_provider_mappings,
    p_payload
  );
  mapping_payload.provider_member_id := btrim(mapping_payload.provider_member_id);
  if mapping_payload.status <> 'active'
    or mapping_payload.effective_to is not null
    or mapping_payload.provider_id is null
    or mapping_payload.station_id is null
    or nullif(btrim(mapping_payload.provider_member_id), '') is null
    or mapping_payload.payment_method_id is null
  then
    raise exception 'Keep all requires one complete, active, open-ended mapping';
  end if;

  select *
  into person
  from public.workforce
  where company_id = p_company
    and id = p_workforce
    and deleted_at is null
    and migration_state <> 'reclassified'
  for update;

  if person.id is null then
    raise exception 'The destination Workforce profile was not found';
  end if;
  if nullif(upper(btrim(p_dropx)), '') is null
    or nullif(upper(btrim(person.dropx_id)), '')
      is distinct from nullif(upper(btrim(p_dropx)), '')
  then
    raise exception 'The submitted DropX ID does not match the destination Workforce profile';
  end if;
  if person.last_working_date < today
    or coalesce(person.lifecycle_status, '') in (
      'offboarded', 'closed', 'exited', 'terminated', 'resigned', 'settled', 'inactive'
    )
  then
    raise exception 'This Workforce associate is inactive or no longer eligible for ID mapping';
  end if;
  if p_locations is not null
    and (
      person.location_id is null
      or not (person.location_id = any(p_locations))
      or not (mapping_payload.station_id = any(p_locations))
    )
  then
    raise exception 'The existing or destination mapping is outside your station scope';
  end if;
  if not exists (
    select 1
    from public.stations station
    where station.company_id = p_company
      and station.id = mapping_payload.station_id
      and station.provider_id = mapping_payload.provider_id
  ) then
    raise exception 'Provider and station do not match';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_company::text
        || mapping_payload.provider_id::text
        || upper(btrim(mapping_payload.provider_member_id)),
      0
    )
  );

  select *
  into existing_mapping
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.id = p_expected_existing_mapping
  for update;

  if existing_mapping.id is null
    or existing_mapping.status <> 'active'
    or existing_mapping.effective_to is not null
    or public.workforce_provider_mapping_person(
      existing_mapping.company_id,
      existing_mapping.workforce_id,
      existing_mapping.field_executive_id,
      existing_mapping.employee_id,
      existing_mapping.contractor_id
    ) is distinct from p_workforce
    or existing_mapping.provider_id is distinct from mapping_payload.provider_id
    or upper(btrim(existing_mapping.provider_member_id))
      <> upper(btrim(mapping_payload.provider_member_id))
    or existing_mapping.station_id is not distinct from mapping_payload.station_id
  then
    raise exception 'The active mapping changed after confirmation';
  end if;

  perform mapping.id
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.effective_to is null
    and mapping.status = 'active'
    and (
      public.workforce_provider_mapping_person(
        mapping.company_id,
        mapping.workforce_id,
        mapping.field_executive_id,
        mapping.employee_id,
        mapping.contractor_id
      ) = p_workforce
      or (
        mapping.provider_id = mapping_payload.provider_id
        and upper(btrim(mapping.provider_member_id))
          = upper(btrim(mapping_payload.provider_member_id))
      )
    )
  order by mapping.id
  for update;

  if exists (
    select 1
    from public.field_executive_provider_mappings mapping
    where mapping.company_id = p_company
      and mapping.provider_id = mapping_payload.provider_id
      and upper(btrim(mapping.provider_member_id))
        = upper(btrim(mapping_payload.provider_member_id))
      and mapping.effective_to is null
      and mapping.status = 'active'
      and public.workforce_provider_mapping_person(
        mapping.company_id,
        mapping.workforce_id,
        mapping.field_executive_id,
        mapping.employee_id,
        mapping.contractor_id
      ) is distinct from p_workforce
  ) then
    raise exception 'Provider ID is already mapped to another DropX ID';
  end if;

  if exists (
    select 1
    from public.field_executive_provider_mappings mapping
    where mapping.company_id = p_company
      and public.workforce_provider_mapping_person(
        mapping.company_id,
        mapping.workforce_id,
        mapping.field_executive_id,
        mapping.employee_id,
        mapping.contractor_id
      ) = p_workforce
      and mapping.effective_to is null
      and mapping.status = 'active'
      and (
        mapping.provider_id is distinct from mapping_payload.provider_id
        or upper(btrim(mapping.provider_member_id))
          <> upper(btrim(mapping_payload.provider_member_id))
      )
  ) then
    raise exception 'All simultaneous location mappings must use the same Provider ID and DropX ID';
  end if;

  if exists (
    select 1
    from public.field_executive_provider_mappings mapping
    where mapping.company_id = p_company
      and mapping.provider_id = mapping_payload.provider_id
      and upper(btrim(mapping.provider_member_id))
        = upper(btrim(mapping_payload.provider_member_id))
      and mapping.station_id = mapping_payload.station_id
      and mapping.status <> 'cancelled'
      and daterange(
        mapping.effective_from,
        coalesce(mapping.effective_to, 'infinity'::date),
        '[]'
      ) && daterange(mapping_payload.effective_from, 'infinity'::date, '[]')
  ) then
    raise exception 'Provider ID already has an overlapping mapping at this location';
  end if;

  insert into public.field_executive_provider_mappings(
    company_id,
    workforce_id,
    provider_id,
    station_id,
    provider_member_id,
    effective_from,
    effective_to,
    payment_method_id,
    payment_values,
    production_threshold_config,
    pay_type,
    status,
    created_by
  ) values (
    p_company,
    p_workforce,
    mapping_payload.provider_id,
    mapping_payload.station_id,
    mapping_payload.provider_member_id,
    mapping_payload.effective_from,
    null,
    mapping_payload.payment_method_id,
    mapping_payload.payment_values,
    mapping_payload.production_threshold_config,
    mapping_payload.pay_type,
    'active',
    p_actor
  )
  returning id into new_mapping_id;

  -- Keep the profile's current location unchanged. Payout population resolves
  -- production through each station-specific mapping and later consolidates it
  -- under this one canonical Workforce identity.
  update public.workforce
  set provider_employee_id = mapping_payload.provider_member_id,
      provider_id_status = 'created',
      updated_at = now()
  where company_id = p_company
    and id = p_workforce;

  insert into public.workforce_joining_events(
    company_id,
    workforce_id,
    event_code,
    actor_id,
    actor_name,
    details
  ) values (
    p_company,
    p_workforce,
    'provider_mapping_location_kept',
    p_actor,
    coalesce(nullif(btrim(p_actor_name), ''), 'Dashboard mapping reviewer'),
    jsonb_build_object(
      'existing_mapping_id', existing_mapping.id,
      'new_mapping_id', new_mapping_id,
      'provider_id', mapping_payload.provider_id,
      'provider_member_id', mapping_payload.provider_member_id,
      'existing_station_id', existing_mapping.station_id,
      'new_station_id', mapping_payload.station_id,
      'effective_from', mapping_payload.effective_from
    )
  );

  return new_mapping_id;
end
$function$;

create or replace function public.workforce_clear_joining_mapping(
  p_company uuid,
  p_actor uuid,
  p_workforce uuid,
  p_mapping uuid,
  p_locations uuid[],
  p_actor_name text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  person public.workforce;
  mapping_row public.field_executive_provider_mappings;
  remaining_mapping public.field_executive_provider_mappings;
  today date := (now() at time zone 'Asia/Kolkata')::date;
  closed_to date;
  disposition text;
begin
  if p_actor is null or p_mapping is null then
    raise exception 'An authenticated reviewer and mapping are required';
  end if;

  select *
  into person
  from public.workforce
  where company_id = p_company
    and id = p_workforce
    and deleted_at is null
    and migration_state <> 'reclassified'
  for update;
  if person.id is null then
    raise exception 'The Workforce profile was not found';
  end if;

  select *
  into mapping_row
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.id = p_mapping
    and public.workforce_provider_mapping_person(
      mapping.company_id,
      mapping.workforce_id,
      mapping.field_executive_id,
      mapping.employee_id,
      mapping.contractor_id
    ) = p_workforce
  for update;
  if mapping_row.id is null
    or mapping_row.status <> 'active'
    or mapping_row.effective_to is not null
  then
    raise exception 'The active mapping changed. Reload the page and try again';
  end if;
  if p_locations is not null
    and (
      person.location_id is null
      or not (person.location_id = any(p_locations))
      or mapping_row.station_id is null
      or not (mapping_row.station_id = any(p_locations))
    )
  then
    raise exception 'The mapping is outside your station scope';
  end if;

  if mapping_row.effective_from < today then
    closed_to := today - 1;
    disposition := 'closed';
    update public.field_executive_provider_mappings
    set effective_to = closed_to,
        status = 'closed',
        updated_at = now()
    where id = mapping_row.id;
  else
    closed_to := null;
    disposition := 'cancelled';
    update public.field_executive_provider_mappings
    set status = 'cancelled',
        updated_at = now()
    where id = mapping_row.id;
  end if;

  select *
  into remaining_mapping
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and public.workforce_provider_mapping_person(
      mapping.company_id,
      mapping.workforce_id,
      mapping.field_executive_id,
      mapping.employee_id,
      mapping.contractor_id
    ) = p_workforce
    and mapping.status = 'active'
    and mapping.effective_to is null
  order by mapping.created_at desc, mapping.id desc
  limit 1;

  update public.workforce
  set provider_employee_id = remaining_mapping.provider_member_id,
      provider_id_status = case when remaining_mapping.id is null then 'pending' else 'created' end,
      updated_at = now()
  where company_id = p_company
    and id = p_workforce;

  insert into public.workforce_joining_events(
    company_id,
    workforce_id,
    event_code,
    actor_id,
    actor_name,
    details
  ) values (
    p_company,
    p_workforce,
    'provider_mapping_cleared',
    p_actor,
    coalesce(nullif(btrim(p_actor_name), ''), 'Dashboard mapping reviewer'),
    jsonb_build_object(
      'mapping_id', mapping_row.id,
      'provider_id', mapping_row.provider_id,
      'provider_member_id', mapping_row.provider_member_id,
      'station_id', mapping_row.station_id,
      'disposition', disposition,
      'effective_to', closed_to,
      'remaining_mapping_id', remaining_mapping.id
    )
  );

  return jsonb_build_object(
    'mapping_id', mapping_row.id,
    'disposition', disposition,
    'effective_to', closed_to,
    'remaining_mapping_id', remaining_mapping.id,
    'remaining_station_id', remaining_mapping.station_id,
    'remaining_provider_id', remaining_mapping.provider_id,
    'remaining_provider_member_id', remaining_mapping.provider_member_id,
    'remaining_payment_method_id', remaining_mapping.payment_method_id,
    'remaining_payment_values', coalesce(remaining_mapping.payment_values, '{}'::jsonb),
    'remaining_effective_from', remaining_mapping.effective_from,
    'remaining_effective_to', remaining_mapping.effective_to
  );
end
$function$;

revoke all on function public.workforce_keep_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) from public, anon, authenticated;
grant execute on function public.workforce_keep_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) to service_role;

revoke all on function public.workforce_clear_joining_mapping(
  uuid, uuid, uuid, uuid, uuid[], text
) from public, anon, authenticated;
grant execute on function public.workforce_clear_joining_mapping(
  uuid, uuid, uuid, uuid, uuid[], text
) to service_role;

comment on function public.workforce_keep_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) is 'Adds the same provider member at another station without moving the canonical Workforce profile; every active station mapping must retain the same Workforce owner.';

comment on function public.workforce_active_provider_member_mappings(
  uuid, uuid, text
) is 'Returns active provider-member mappings using the canonical trim- and case-insensitive Provider ID identity.';

comment on function public.workforce_clear_joining_mapping(
  uuid, uuid, uuid, uuid, uuid[], text
) is 'Clears one current provider mapping while preserving its historical coverage and respecting published-payout and bank-processing mapping guards.';

notify pgrst, 'reload schema';

commit;
