-- Legacy Keep-all events can record the registered-location anchor as the
-- new mapping. When that anchor is later split into adjacent payment periods,
-- the closed anchor row must not be validated as an additional-location row.
-- The actual station role is authoritative; all existing coverage checks for
-- genuine additional-location mappings remain unchanged.
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
            and ((anchor.status = 'active' and anchor.effective_to is null)
              or (anchor.status = 'closed' and anchor.effective_to is not null))
            and anchor.station_id = registered_station
            and anchor.provider_id = mapping.provider_id
            and upper(btrim(anchor.provider_member_id))
              = upper(btrim(mapping.provider_member_id))
            and public.workforce_provider_mapping_period_covered(
              p_company, p_workforce, registered_station, mapping.provider_id,
              mapping.provider_member_id, mapping.effective_from, null
            )
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
            and ((anchor.status = 'active' and anchor.effective_to is null)
              or (anchor.status = 'closed' and anchor.effective_to is not null))
            and public.workforce_provider_mapping_period_covered(
              p_company, p_workforce, registered_station, mapping.provider_id,
              mapping.provider_member_id, greatest(anchor.effective_from, mapping.effective_from), null
            )
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
        -- A closed row at the registered station is an anchor period, not an
        -- additional-location dependency. Legacy Keep-all events can name the
        -- registered anchor as new_mapping_id, so classify by actual station.
        and mapping.station_id is distinct from registered_station
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
            and public.workforce_provider_mapping_period_covered(
              p_company, p_workforce, anchor.station_id, mapping.provider_id,
              mapping.provider_member_id,
              case when joining_event.details ->> 'keep_direction' = 'registered_anchor_added'
                then greatest(anchor.effective_from, mapping.effective_from)
                else mapping.effective_from end, mapping.effective_to
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
    raise exception 'The registered-location mapping must cover the full additional-location mapping period without gaps. To change payment rates, use + Add payment period and save the complete plan together';
  end if;
  raise exception 'The registered-location mapping is required; map this Provider ID at the DropX profile registered location before adding or retaining another location';
end
$function$;

comment on function public.workforce_assert_provider_mapping_registered_location(uuid,uuid)
  is 'Validates gap-free registered-location coverage while classifying closed legacy Keep-all rows by their actual station role.';

revoke all on function public.workforce_assert_provider_mapping_registered_location(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.workforce_assert_provider_mapping_registered_location(uuid,uuid)
  to service_role;

notify pgrst, 'reload schema';
commit;



