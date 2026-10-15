-- Restore the explicit Keep all choice when a provider member is first mapped
-- back to the Workforce profile's registered location. The existing mapping
-- remains untouched: an audited event defines when its concurrent multi-site
-- period begins, while the new registered-location anchor covers that period.
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
        and not exists (
          -- Reverse Keep all: the additional-location mapping predates the
          -- registered anchor. Only an exact event emitted atomically by the
          -- RPC can establish the later concurrent-period boundary.
          select 1
          from public.workforce_joining_events joining_event
          join public.field_executive_provider_mappings anchor
            on anchor.company_id = joining_event.company_id
           and anchor.id::text = joining_event.details ->> 'registered_mapping_id'
          where joining_event.company_id = mapping.company_id
            and joining_event.workforce_id = p_workforce
            and joining_event.event_code = 'provider_mapping_location_kept'
            and joining_event.details ->> 'keep_direction' = 'registered_anchor_added'
            and joining_event.details ->> 'additional_mapping_id' = mapping.id::text
            and joining_event.details ->> 'registered_station_id' = registered_station::text
            and joining_event.details ->> 'additional_station_id' = mapping.station_id::text
            and joining_event.details ->> 'provider_id' = mapping.provider_id::text
            and upper(btrim(joining_event.details ->> 'provider_member_id'))
              = upper(btrim(mapping.provider_member_id))
            and anchor.status = 'active'
            and anchor.effective_to is null
            and anchor.station_id = registered_station
            and anchor.provider_id = mapping.provider_id
            and upper(btrim(anchor.provider_member_id))
              = upper(btrim(mapping.provider_member_id))
            and anchor.effective_from = case
              when coalesce(joining_event.details ->> 'effective_from', '')
                ~ '^\d{4}-\d{2}-\d{2}$'
                then (joining_event.details ->> 'effective_from')::date
              else null
            end
            and case
              when coalesce(joining_event.details ->> 'concurrent_from', '')
                ~ '^\d{4}-\d{2}-\d{2}$'
                then (joining_event.details ->> 'concurrent_from')::date
              else null
            end = greatest(anchor.effective_from, mapping.effective_from)
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
            and (
              (
                coalesce(joining_event.details ->> 'keep_direction', '')
                  <> 'registered_anchor_added'
                and anchor.effective_from <= mapping.effective_from
              )
              or (
                joining_event.details ->> 'keep_direction'
                  = 'registered_anchor_added'
                and joining_event.details ->> 'registered_mapping_id'
                  = anchor.id::text
                and joining_event.details ->> 'additional_mapping_id'
                  = mapping.id::text
                and joining_event.details ->> 'registered_station_id'
                  = anchor.station_id::text
                and joining_event.details ->> 'additional_station_id'
                  = mapping.station_id::text
                and joining_event.details ->> 'provider_id'
                  = mapping.provider_id::text
                and upper(btrim(joining_event.details ->> 'provider_member_id'))
                  = upper(btrim(mapping.provider_member_id))
                and anchor.effective_from = case
                  when coalesce(joining_event.details ->> 'effective_from', '')
                    ~ '^\d{4}-\d{2}-\d{2}$'
                    then (joining_event.details ->> 'effective_from')::date
                  else null
                end
                and case
                  when coalesce(joining_event.details ->> 'concurrent_from', '')
                    ~ '^\d{4}-\d{2}-\d{2}$'
                    then (joining_event.details ->> 'concurrent_from')::date
                  else null
                end = greatest(anchor.effective_from, mapping.effective_from)
                and mapping.effective_to >= case
                  when coalesce(joining_event.details ->> 'concurrent_from', '')
                    ~ '^\d{4}-\d{2}-\d{2}$'
                    then (joining_event.details ->> 'concurrent_from')::date
                  else null
                end
              )
            )
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
    raise exception 'The registered-location mapping must cover the concurrent additional-location mapping period';
  end if;
  raise exception 'The registered-location mapping is required; map this Provider ID at the DropX profile registered location before adding or retaining another location';
end
$function$;

comment on function public.workforce_assert_provider_mapping_registered_location(
  uuid, uuid
) is 'Requires every current or audited Keep-all mapping to have an exact same-owner/provider/member registered-location anchor. An older retained mapping is accepted only from the concurrent-period date recorded by an audited reverse-Keep event.';

create or replace function public.workforce_keep_joining_mapping_at_registered_location(
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
  expected_mapping public.field_executive_provider_mappings;
  mapping_payload public.field_executive_provider_mappings;
  retained_mapping public.field_executive_provider_mappings;
  new_anchor_id uuid;
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
    or mapping_payload.effective_from is null
  then
    raise exception 'Keep all at the registered location requires one complete active, open-ended mapping';
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
  if person.location_id is null
    or mapping_payload.station_id is distinct from person.location_id
  then
    raise exception 'Keep all must add the mapping at the Workforce profile registered location';
  end if;
  if person.last_working_date < today
    or coalesce(person.lifecycle_status, '') in (
      'offboarded', 'closed', 'exited', 'terminated', 'resigned', 'settled', 'inactive'
    )
  then
    raise exception 'This Workforce associate is inactive or no longer eligible for ID mapping';
  end if;
  if p_locations is not null and not (person.location_id = any(p_locations)) then
    raise exception 'The registered location is outside your station scope';
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
  into expected_mapping
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.id = p_expected_existing_mapping
  for update;

  if expected_mapping.id is null
    or expected_mapping.status <> 'active'
    or expected_mapping.effective_to is not null
    or expected_mapping.station_id is null
    or expected_mapping.station_id = person.location_id
    or public.workforce_provider_mapping_person(
      expected_mapping.company_id,
      expected_mapping.workforce_id,
      expected_mapping.field_executive_id,
      expected_mapping.employee_id,
      expected_mapping.contractor_id
    ) is distinct from p_workforce
    or expected_mapping.provider_id is distinct from mapping_payload.provider_id
    or upper(btrim(expected_mapping.provider_member_id))
      <> upper(btrim(mapping_payload.provider_member_id))
  then
    raise exception 'The additional-location mapping changed after confirmation';
  end if;

  perform mapping.id
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.status = 'active'
    and mapping.effective_to is null
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
      and mapping.status = 'active'
      and mapping.effective_to is null
      and mapping.provider_id = mapping_payload.provider_id
      and upper(btrim(mapping.provider_member_id))
        = upper(btrim(mapping_payload.provider_member_id))
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
      and mapping.status = 'active'
      and mapping.effective_to is null
      and public.workforce_provider_mapping_person(
        mapping.company_id,
        mapping.workforce_id,
        mapping.field_executive_id,
        mapping.employee_id,
        mapping.contractor_id
      ) = p_workforce
      and (
        mapping.provider_id is distinct from mapping_payload.provider_id
        or upper(btrim(mapping.provider_member_id))
          <> upper(btrim(mapping_payload.provider_member_id))
      )
  ) then
    raise exception 'All simultaneous location mappings must use the same Provider ID and DropX ID';
  end if;

  if p_locations is not null and exists (
    select 1
    from public.field_executive_provider_mappings mapping
    where mapping.company_id = p_company
      and mapping.status = 'active'
      and mapping.effective_to is null
      and mapping.provider_id = mapping_payload.provider_id
      and upper(btrim(mapping.provider_member_id))
        = upper(btrim(mapping_payload.provider_member_id))
      and public.workforce_provider_mapping_person(
        mapping.company_id,
        mapping.workforce_id,
        mapping.field_executive_id,
        mapping.employee_id,
        mapping.contractor_id
      ) = p_workforce
      and (
        mapping.station_id is null
        or not (mapping.station_id = any(p_locations))
      )
  ) then
    raise exception 'One or more retained mappings are outside your station scope';
  end if;

  if exists (
    select 1
    from public.field_executive_provider_mappings mapping
    where mapping.company_id = p_company
      and mapping.provider_id = mapping_payload.provider_id
      and upper(btrim(mapping.provider_member_id))
        = upper(btrim(mapping_payload.provider_member_id))
      and mapping.station_id = person.location_id
      and mapping.status <> 'cancelled'
      and daterange(
        mapping.effective_from,
        coalesce(mapping.effective_to, 'infinity'::date),
        '[]'
      ) && daterange(mapping_payload.effective_from, 'infinity'::date, '[]')
  ) then
    raise exception 'Provider ID already has an overlapping mapping at the registered location';
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
    person.location_id,
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
  returning id into new_anchor_id;

  for retained_mapping in
    select mapping.*
    from public.field_executive_provider_mappings mapping
    where mapping.company_id = p_company
      and mapping.id <> new_anchor_id
      and mapping.status = 'active'
      and mapping.effective_to is null
      and mapping.station_id is distinct from person.location_id
      and mapping.provider_id = mapping_payload.provider_id
      and upper(btrim(mapping.provider_member_id))
        = upper(btrim(mapping_payload.provider_member_id))
      and public.workforce_provider_mapping_person(
        mapping.company_id,
        mapping.workforce_id,
        mapping.field_executive_id,
        mapping.employee_id,
        mapping.contractor_id
      ) = p_workforce
    order by mapping.id
  loop
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
        'keep_direction', 'registered_anchor_added',
        'registered_mapping_id', new_anchor_id,
        'additional_mapping_id', retained_mapping.id,
        'registered_station_id', person.location_id,
        'additional_station_id', retained_mapping.station_id,
        'concurrent_from', greatest(
          retained_mapping.effective_from,
          mapping_payload.effective_from
        ),
        -- Retain the established history keys while recording explicit roles.
        'existing_mapping_id', new_anchor_id,
        'new_mapping_id', retained_mapping.id,
        'provider_id', mapping_payload.provider_id,
        'provider_member_id', mapping_payload.provider_member_id,
        'existing_station_id', person.location_id,
        'new_station_id', retained_mapping.station_id,
        'effective_from', mapping_payload.effective_from,
        'effective_to', null
      )
    );
  end loop;

  return new_anchor_id;
end
$function$;

comment on function public.workforce_keep_joining_mapping_at_registered_location(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) is 'Atomically adds the registered-location anchor without rewriting retained mapping IDs or periods. Exact audited events establish the later concurrent multi-location period.';

revoke all on function public.workforce_assert_provider_mapping_registered_location(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.workforce_assert_provider_mapping_registered_location(
  uuid, uuid
) to service_role;

revoke all on function public.workforce_keep_joining_mapping_at_registered_location(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) from public, anon, authenticated;
grant execute on function public.workforce_keep_joining_mapping_at_registered_location(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) to service_role;

notify pgrst, 'reload schema';

commit;
