-- Final historical-period rules: a completed mapping at the Workforce profile's registered location remains
-- valid identity evidence for an additional-location mapping only for dates it
-- fully covers. Keep ordinary closed relocation history independent: bounded
-- dependent rows are protected only when they were explicitly created through
-- the audited Keep all flow.
begin;

create or replace function public.workforce_assert_provider_mapping_registered_location(
  p_company uuid,
  p_workforce uuid
)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  registered_station uuid;
  invalid_mapping public.field_executive_provider_mappings%rowtype;
  partial_anchor public.field_executive_provider_mappings%rowtype;
begin
  if p_company is null or p_workforce is null then
    return;
  end if;

  select workforce.location_id
  into registered_station
  from public.workforce workforce
  where workforce.company_id = p_company
    and workforce.id = p_workforce
    and workforce.deleted_at is null
    and workforce.migration_state <> 'reclassified';

  select mapping.*
  into invalid_mapping
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.status in ('active', 'closed')
    and public.workforce_provider_mapping_person(
      mapping.company_id,
      mapping.workforce_id,
      mapping.field_executive_id,
      mapping.employee_id,
      mapping.contractor_id
    ) = p_workforce
    and (
      (
        -- Current mappings always follow the Workforce profile's current
        -- registered location, including legacy rows without a Keep all event.
        mapping.status = 'active'
        and mapping.effective_to is null
        and not exists (
          select 1
          from public.field_executive_provider_mappings anchor
          where anchor.company_id = mapping.company_id
            and anchor.status = 'active'
            and anchor.station_id = registered_station
            and anchor.provider_id = mapping.provider_id
            and upper(btrim(anchor.provider_member_id))
              = upper(btrim(mapping.provider_member_id))
            and anchor.effective_from <= mapping.effective_from
            and anchor.effective_to is null
            and public.workforce_provider_mapping_person(
              anchor.company_id,
              anchor.workforce_id,
              anchor.field_executive_id,
              anchor.employee_id,
              anchor.contractor_id
            ) = p_workforce
        )
      )
      or (
        -- Once an audited Keep all row is historical, validate it against the
        -- exact registered-location anchor captured when it was created. A
        -- later legitimate profile move must not rewrite historical location
        -- truth to use the profile's new registered station.
        mapping.status = 'closed'
        and mapping.effective_to is not null
        and exists (
          select 1
          from public.workforce_joining_events joining_event
          where joining_event.company_id = mapping.company_id
            and joining_event.workforce_id = p_workforce
            and joining_event.event_code = 'provider_mapping_location_kept'
            and joining_event.details ->> 'new_mapping_id' = mapping.id::text
        )
        and not exists (
          select 1
          from public.workforce_joining_events joining_event
          join public.field_executive_provider_mappings anchor
            on anchor.company_id = joining_event.company_id
           and anchor.id::text = joining_event.details ->> 'existing_mapping_id'
           and anchor.station_id::text
             = joining_event.details ->> 'existing_station_id'
          where joining_event.company_id = mapping.company_id
            and joining_event.workforce_id = p_workforce
            and joining_event.event_code = 'provider_mapping_location_kept'
            and joining_event.details ->> 'new_mapping_id' = mapping.id::text
            and (
              (anchor.status = 'active' and anchor.effective_to is null)
              or (anchor.status = 'closed' and anchor.effective_to is not null)
            )
            and anchor.provider_id = mapping.provider_id
            and upper(btrim(anchor.provider_member_id))
              = upper(btrim(mapping.provider_member_id))
            and anchor.effective_from <= mapping.effective_from
            and (
              anchor.effective_to is null
              or anchor.effective_to >= mapping.effective_to
            )
            and public.workforce_provider_mapping_person(
              anchor.company_id,
              anchor.workforce_id,
              anchor.field_executive_id,
              anchor.employee_id,
              anchor.contractor_id
            ) = p_workforce
        )
      )
    )
  order by mapping.effective_from, mapping.id
  limit 1;

  if invalid_mapping.id is null then
    return;
  end if;

  if registered_station is null then
    raise exception 'The mapped DropX profile has no registered location';
  end if;

  select anchor.*
  into partial_anchor
  from public.field_executive_provider_mappings anchor
  where anchor.company_id = p_company
    and (
      (anchor.status = 'active' and anchor.effective_to is null)
      or (anchor.status = 'closed' and anchor.effective_to is not null)
    )
    and anchor.station_id = registered_station
    and anchor.provider_id = invalid_mapping.provider_id
    and upper(btrim(anchor.provider_member_id))
      = upper(btrim(invalid_mapping.provider_member_id))
    and public.workforce_provider_mapping_person(
      anchor.company_id,
      anchor.workforce_id,
      anchor.field_executive_id,
      anchor.employee_id,
      anchor.contractor_id
    ) = p_workforce
  order by anchor.effective_from, anchor.id
  limit 1;

  if partial_anchor.id is not null then
    raise exception 'The registered-location mapping must cover the full additional-location mapping period';
  end if;

  raise exception 'The registered-location mapping is required; map this Provider ID at the DropX profile registered location before adding or retaining another location';
end
$function$;

comment on function public.workforce_assert_provider_mapping_registered_location(
  uuid, uuid
) is 'Requires every current or audited Keep-all mapping to have an exact same-owner/provider/member registered-location mapping whose inclusive effective period fully contains it.';

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
  if mapping_payload.provider_id is null
    or mapping_payload.station_id is null
    or nullif(btrim(mapping_payload.provider_member_id), '') is null
    or mapping_payload.payment_method_id is null
    or mapping_payload.effective_from is null
    or mapping_payload.status is null
    or (
      mapping_payload.effective_to is not null
      and mapping_payload.effective_to < mapping_payload.effective_from
    )
    or not (
      (
        mapping_payload.status = 'active'
        and mapping_payload.effective_to is null
      )
      or (
        mapping_payload.status = 'closed'
        and mapping_payload.effective_to is not null
      )
    )
  then
    raise exception 'Keep all requires one complete active/open or closed/bounded mapping';
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
    or not (
      (existing_mapping.status = 'active' and existing_mapping.effective_to is null)
      or (existing_mapping.status = 'closed' and existing_mapping.effective_to is not null)
    )
    or existing_mapping.station_id is distinct from person.location_id
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
    raise exception 'The registered-location mapping changed after confirmation';
  end if;

  if existing_mapping.effective_from > mapping_payload.effective_from
    or (
      mapping_payload.effective_to is null
      and existing_mapping.effective_to is not null
    )
    or (
      mapping_payload.effective_to is not null
      and existing_mapping.effective_to is not null
      and existing_mapping.effective_to < mapping_payload.effective_to
    )
  then
    raise exception 'The registered-location mapping must cover the full additional-location mapping period';
  end if;

  -- Lock current rows as before. For a bounded historical write, also lock all
  -- overlapping owner/identity rows used by the additional period checks.
  perform mapping.id
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and (
      (mapping.status = 'active' and mapping.effective_to is null)
      or (mapping.status = 'closed' and mapping.effective_to is not null)
    )
    and (
      (mapping.status = 'active' and mapping.effective_to is null)
      or (
        mapping_payload.effective_to is not null
        and daterange(
          mapping.effective_from,
          coalesce(mapping.effective_to, 'infinity'::date),
          '[]'
        ) && daterange(
          mapping_payload.effective_from,
          mapping_payload.effective_to,
          '[]'
        )
      )
    )
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

  -- Preserve the established current-owner guard.
  if mapping_payload.effective_to is null
    and exists (
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

  -- A bounded historical Keep all must obey the same canonical-owner rule for
  -- its complete effective period, including closed history.
  if mapping_payload.effective_to is not null
    and exists (
      select 1
      from public.field_executive_provider_mappings mapping
      where mapping.company_id = p_company
        and mapping.provider_id = mapping_payload.provider_id
        and upper(btrim(mapping.provider_member_id))
          = upper(btrim(mapping_payload.provider_member_id))
        and (
          (mapping.status = 'active' and mapping.effective_to is null)
          or (mapping.status = 'closed' and mapping.effective_to is not null)
        )
        and daterange(
          mapping.effective_from,
          coalesce(mapping.effective_to, 'infinity'::date),
          '[]'
        ) && daterange(
          mapping_payload.effective_from,
          mapping_payload.effective_to,
          '[]'
        )
        and public.workforce_provider_mapping_person(
          mapping.company_id,
          mapping.workforce_id,
          mapping.field_executive_id,
          mapping.employee_id,
          mapping.contractor_id
        ) is distinct from p_workforce
    )
  then
    raise exception 'Provider ID is mapped to another DropX ID during this period';
  end if;

  -- Preserve the established current identity guard for the destination.
  if mapping_payload.effective_to is null
    and exists (
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

  if mapping_payload.effective_to is not null
    and exists (
      select 1
      from public.field_executive_provider_mappings mapping
      where mapping.company_id = p_company
        and (
          (mapping.status = 'active' and mapping.effective_to is null)
          or (mapping.status = 'closed' and mapping.effective_to is not null)
        )
        and public.workforce_provider_mapping_person(
          mapping.company_id,
          mapping.workforce_id,
          mapping.field_executive_id,
          mapping.employee_id,
          mapping.contractor_id
        ) = p_workforce
        and daterange(
          mapping.effective_from,
          coalesce(mapping.effective_to, 'infinity'::date),
          '[]'
        ) && daterange(
          mapping_payload.effective_from,
          mapping_payload.effective_to,
          '[]'
        )
        and (
          mapping.provider_id is distinct from mapping_payload.provider_id
          or upper(btrim(mapping.provider_member_id))
            <> upper(btrim(mapping_payload.provider_member_id))
        )
    )
  then
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
      ) && daterange(
        mapping_payload.effective_from,
        coalesce(mapping_payload.effective_to, 'infinity'::date),
        '[]'
      )
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
    mapping_payload.effective_to,
    mapping_payload.payment_method_id,
    mapping_payload.payment_values,
    mapping_payload.production_threshold_config,
    mapping_payload.pay_type,
    mapping_payload.status,
    p_actor
  )
  returning id into new_mapping_id;

  -- A bounded historical repair must never replace a newer current identity.
  -- Synchronize the profile only when Keep all creates a current/open mapping.
  if mapping_payload.status = 'active' and mapping_payload.effective_to is null then
    update public.workforce
    set provider_employee_id = mapping_payload.provider_member_id,
        provider_id_status = 'created',
        updated_at = now()
    where company_id = p_company
      and id = p_workforce;
  end if;

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
      'effective_from', mapping_payload.effective_from,
      'effective_to', mapping_payload.effective_to
    )
  );

  return new_mapping_id;
end
$function$;

comment on function public.workforce_keep_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) is 'Keeps an exact provider/member mapping at another location when the registered-location mapping fully contains the added active/open or closed/bounded period.';

revoke all on function public.workforce_assert_provider_mapping_registered_location(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.workforce_assert_provider_mapping_registered_location(
  uuid, uuid
) to service_role;

revoke all on function public.workforce_keep_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) from public, anon, authenticated;
grant execute on function public.workforce_keep_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) to service_role;

commit;
