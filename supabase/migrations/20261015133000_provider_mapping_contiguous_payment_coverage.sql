-- Rate changes split a mapping into adjacent payment periods. Location coverage
-- belongs to the complete same-person/provider/station timeline, not one row.
-- Keep the deferred guard, audited historical anchors and reverse-Keep-all proof.
begin;

create or replace function public.workforce_provider_mapping_period_covered(
  p_company uuid, p_workforce uuid, p_station uuid, p_provider uuid,
  p_member text, p_from date, p_to date
) returns boolean language sql stable security invoker set search_path to ''
as $function$
  select case when p_from is null or (p_to is not null and p_to < p_from)
    then false
    else coalesce((
      select pg_catalog.range_agg(pg_catalog.daterange(m.effective_from, m.effective_to, '[]'))
        @> pg_catalog.daterange(p_from, p_to, '[]')
      from public.field_executive_provider_mappings m
      where m.company_id = p_company and m.station_id = p_station
        and m.provider_id = p_provider
        and upper(btrim(m.provider_member_id)) = upper(btrim(p_member))
        and ((m.status = 'active' and m.effective_to is null)
          or (m.status = 'closed' and m.effective_to is not null))
        and public.workforce_provider_mapping_person(
          m.company_id, m.workforce_id, m.field_executive_id, m.employee_id, m.contractor_id
        ) = p_workforce
    ), false) end;
$function$;
revoke all on function public.workforce_provider_mapping_period_covered(uuid,uuid,uuid,uuid,text,date,date)
  from public, anon, authenticated;
grant execute on function public.workforce_provider_mapping_period_covered(uuid,uuid,uuid,uuid,text,date,date)
  to service_role;

CREATE OR REPLACE FUNCTION public.workforce_assert_provider_mapping_registered_location(p_company uuid, p_workforce uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  is 'Validates gap-free same-owner/provider/member registered-location coverage across adjacent payment periods, preserving audited historical and reverse-Keep-all anchors.';


-- Keep clean installations aligned with the existing same-person multi-location
-- writer in production. Different provider/member identities still conflict;
-- the following station-specific overlap guard remains unchanged.
do $save_writer$
declare
  definition text;
  marker text := $old$      and x.workforce_id = p_workforce
      and x.status <> 'cancelled'
      and x.id <> coalesce(p_mapping, '00000000-0000-0000-0000-000000000000'::uuid)
      and x.id <> coalesce(v_old.id, '00000000-0000-0000-0000-000000000000'::uuid)
$old$;
  identity_check text := $identity$      and (
        x.provider_id is distinct from m.provider_id
        or upper(btrim(x.provider_member_id))
          is distinct from upper(btrim(m.provider_member_id))
      )
$identity$;
begin
  select pg_get_functiondef('public.workforce_save_mapping(uuid,uuid,uuid,uuid,text,jsonb,uuid[])'::regprocedure)
    into definition;
  definition := replace(definition, E'\r\n', E'\n');
  marker := replace(marker, E'\r\n', E'\n');
  identity_check := replace(identity_check, E'\r\n', E'\n');
  if position(marker || identity_check in definition) = 0 then
    if (length(definition) - length(replace(definition, marker, ''))) / length(marker) <> 1 then
      raise exception 'Unexpected mapping overlap definition; migration stopped without changing it';
    end if;
    execute replace(definition, marker, marker || identity_check);
  end if;
end
$save_writer$;

-- Do not overwrite unrelated deployed protections in the audited writer.
do $patch$
declare
  definition text;
  old_check text := $old$  if existing_mapping.effective_from > mapping_payload.effective_from
    or (
      mapping_payload.effective_to is null
      and existing_mapping.effective_to is not null
    )
    or (
      mapping_payload.effective_to is not null
      and existing_mapping.effective_to is not null
      and existing_mapping.effective_to < mapping_payload.effective_to
    )
$old$;
  new_check text := $new$  if existing_mapping.effective_from > mapping_payload.effective_from
    or not public.workforce_provider_mapping_period_covered(
      p_company, p_workforce, existing_mapping.station_id,
      mapping_payload.provider_id, mapping_payload.provider_member_id,
      mapping_payload.effective_from, mapping_payload.effective_to
    )
$new$;
begin
  select pg_get_functiondef('public.workforce_keep_joining_mapping(uuid,uuid,uuid,uuid,text,jsonb,uuid[],text)'::regprocedure)
    into definition;
  definition := replace(definition, E'\r\n', E'\n');
  old_check := replace(old_check, E'\r\n', E'\n');
  new_check := replace(new_check, E'\r\n', E'\n');
  if position(new_check in definition) = 0 then
    if (length(definition) - length(replace(definition, old_check, ''))) / length(old_check) <> 1 then
      raise exception 'Unexpected Keep-all coverage definition; migration stopped without changing it';
    end if;
    execute replace(definition, old_check, new_check);
  end if;
end
$patch$;

-- Commit a prevalidated multi-period rate plan atomically through the existing
-- audited mapping writer and all payroll/publication/overlap guards.
create or replace function public.workforce_save_mapping_schedule(
  p_company uuid, p_actor uuid, p_workforce uuid, p_dropx text,
  p_periods jsonb, p_locations uuid[], p_actor_name text, p_expected_versions jsonb
) returns jsonb language plpgsql security invoker set search_path to '' as $$
declare
  person public.workforce;
  payload jsonb;
  first_payload jsonb;
  previous_end date;
  starts date;
  ends date;
  station uuid;
  existing public.field_executive_provider_mappings;
  anchor public.field_executive_provider_mappings;
  count_periods integer;
  result jsonb;
  item record;
begin
  if p_actor is null or jsonb_typeof(p_periods) is distinct from 'array' then raise exception 'An authenticated reviewer and payment periods are required'; end if;
  count_periods := jsonb_array_length(p_periods);
  if count_periods < 2 or count_periods > 12 then raise exception 'Plan between 2 and 12 payment periods'; end if;
  first_payload := p_periods->0;
  station := (first_payload->>'station_id')::uuid;
  select * into person from public.workforce where id=p_workforce and company_id=p_company and deleted_at is null for update;
  if person.id is null then raise exception 'Associate not found'; end if;
  if p_locations is not null and (person.location_id is null or not(person.location_id=any(p_locations)) or not(station=any(p_locations))) then raise exception 'Mapping is outside your station scope'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_company::text || (first_payload->>'provider_id') || (first_payload->>'provider_member_id'),0));
  if jsonb_typeof(p_expected_versions) is distinct from 'array' or
    (select count(*) from public.field_executive_provider_mappings where company_id=p_company and workforce_id=p_workforce and station_id=station and status<>'cancelled') <> jsonb_array_length(p_expected_versions)
    or exists(select 1 from jsonb_array_elements(p_expected_versions) version where not exists (
      select 1 from public.field_executive_provider_mappings m where m.company_id=p_company and m.workforce_id=p_workforce and m.station_id=station and m.id=(version->>'id')::uuid and m.updated_at is not distinct from (version->>'updated_at')::timestamptz and m.status<>'cancelled'
    )) then raise exception 'Mapping changed while the schedule was being prepared. Reload and review it.'; end if;
  -- Validate the entire sequence before the first write. Inclusive dates meet
  -- on adjacent days, and only the final period may have no end date.
  for item in select value,ordinality from jsonb_array_elements(p_periods) with ordinality loop
    payload:=item.value; starts:=(payload->>'effective_from')::date; ends:=nullif(payload->>'effective_to','')::date;
    if (payload->>'station_id')::uuid is distinct from station or payload->>'provider_id' is distinct from first_payload->>'provider_id' or upper(btrim(payload->>'provider_member_id')) is distinct from upper(btrim(first_payload->>'provider_member_id')) or (payload->>'workforce_id')::uuid is distinct from p_workforce or (payload->>'company_id')::uuid is distinct from p_company then raise exception 'All periods must belong to the same associate, provider and station'; end if;
    if starts is null or (ends is not null and ends<starts) or (item.ordinality<count_periods and ends is null) or (item.ordinality>1 and starts is distinct from previous_end+1) then raise exception 'Payment periods must have valid adjacent dates without overlaps or gaps'; end if;
    previous_end:=ends;
  end loop;
  for payload in select value from jsonb_array_elements(p_periods) loop
    starts:=(payload->>'effective_from')::date;
    select * into existing from public.field_executive_provider_mappings m
      where m.company_id=p_company and m.workforce_id=p_workforce and m.station_id=station and m.provider_id=(payload->>'provider_id')::uuid and upper(btrim(m.provider_member_id))=upper(btrim(payload->>'provider_member_id')) and m.status<>'cancelled'
      and m.effective_from<=starts and (m.effective_to is null or m.effective_to>=starts)
      order by m.effective_from desc,m.id limit 1 for update;
    if existing.id is null and person.location_id is distinct from station then
      select * into anchor from public.field_executive_provider_mappings m where m.company_id=p_company and m.workforce_id=p_workforce and m.station_id=person.location_id and m.provider_id=(payload->>'provider_id')::uuid and upper(btrim(m.provider_member_id))=upper(btrim(payload->>'provider_member_id')) and m.status<>'cancelled' and m.effective_from<=starts and (m.effective_to is null or m.effective_to >= starts) and public.workforce_provider_mapping_period_covered(p_company,p_workforce,person.location_id,m.provider_id,m.provider_member_id,starts,nullif(payload->>'effective_to','')::date) order by m.effective_from desc limit 1;
      if anchor.id is null then raise exception 'Map this Provider ID at its registered location for the complete period first'; end if;
      perform public.workforce_keep_joining_mapping(p_company,p_actor,p_workforce,anchor.id,p_dropx,payload,p_locations,p_actor_name);
    else
      perform public.workforce_save_joining_mapping(p_company,p_actor,p_workforce,existing.id,p_dropx,payload,p_locations,p_actor_name);
    end if;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.effective_from),'[]'::jsonb) into result from public.field_executive_provider_mappings m where m.company_id=p_company and m.workforce_id=p_workforce and m.station_id=station and m.provider_id=(first_payload->>'provider_id')::uuid and upper(btrim(m.provider_member_id))=upper(btrim(first_payload->>'provider_member_id'));
  return result;
end;
$$;
revoke all on function public.workforce_save_mapping_schedule(uuid,uuid,uuid,text,jsonb,uuid[],text,jsonb) from public,anon,authenticated;
grant execute on function public.workforce_save_mapping_schedule(uuid,uuid,uuid,text,jsonb,uuid[],text,jsonb) to service_role;


notify pgrst, 'reload schema';
commit;
