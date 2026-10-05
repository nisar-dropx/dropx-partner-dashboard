-- Replace an active provider-member owner only after the application presents
-- the exact mapping UUID to the user for confirmation. The old record remains
-- auditable, and every validation/write happens in this one transaction.
create or replace function public.workforce_replace_joining_mapping(
  p_company uuid,
  p_actor uuid,
  p_workforce uuid,
  p_expected_old_mapping uuid,
  p_dropx text,
  p_payload jsonb,
  p_locations uuid[],
  p_actor_name text
)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  person public.workforce;
  old_hint public.field_executive_provider_mappings;
  old_mapping public.field_executive_provider_mappings;
  new_start date;
  today date := (now() at time zone 'Asia/Kolkata')::date;
  old_disposition text;
begin
  if p_actor is null or p_expected_old_mapping is null then
    raise exception 'An authenticated reviewer and confirmed existing mapping are required';
  end if;
  if nullif(p_payload ->> 'effective_to', '') is not null then
    raise exception 'A replacement mapping must remain open-ended';
  end if;
  if coalesce(p_payload ->> 'status', '') <> 'active' then
    raise exception 'A replacement mapping must be active';
  end if;

  begin
    new_start := (p_payload ->> 'effective_from')::date;
  exception when others then
    raise exception 'A valid replacement effective date is required';
  end;
  if new_start > today then
    raise exception 'A replacement mapping cannot start in the future';
  end if;

  -- Read the previous owner first so both Workforce rows can be locked in a
  -- deterministic order. The row is re-read FOR UPDATE after the provider lock.
  select *
  into old_hint
  from public.field_executive_provider_mappings
  where company_id = p_company
    and id = p_expected_old_mapping;

  if not found then
    raise exception 'The active mapping changed after confirmation';
  end if;

  perform 1
  from public.workforce
  where company_id = p_company
    and id = any(array_remove(array[p_workforce, old_hint.workforce_id], null))
  order by id
  for update;

  select *
  into person
  from public.workforce
  where company_id = p_company
    and id = p_workforce
    and deleted_at is null
    and migration_state <> 'reclassified';

  if person.id is null then
    raise exception 'The destination Workforce profile was not found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_company::text || (p_payload ->> 'provider_id') || (p_payload ->> 'provider_member_id'),
      0
    )
  );

  select *
  into old_mapping
  from public.field_executive_provider_mappings
  where company_id = p_company
    and id = p_expected_old_mapping
  for update;

  if old_mapping.id is null
    or old_mapping.status <> 'active'
    or old_mapping.effective_to is not null
    or old_mapping.provider_id is distinct from (p_payload ->> 'provider_id')::uuid
    or upper(btrim(old_mapping.provider_member_id)) <> upper(btrim(p_payload ->> 'provider_member_id'))
  then
    raise exception 'The active mapping changed after confirmation';
  end if;
  if old_mapping.workforce_id = p_workforce then
    raise exception 'The provider ID is already mapped to the selected Workforce profile';
  end if;
  if p_locations is not null
    and (
      person.location_id is null
      or not (person.location_id = any(p_locations))
      or old_mapping.station_id is null
      or not (old_mapping.station_id = any(p_locations))
      or nullif(p_payload ->> 'station_id', '') is null
      or not ((p_payload ->> 'station_id')::uuid = any(p_locations))
    )
  then
    raise exception 'The existing or destination mapping is outside your station scope';
  end if;
  -- The destination Workforce row is already locked above, serializing this
  -- check with every normal save for the same person. Reject historical and
  -- scheduled overlaps as well as an open current mapping.
  if exists (
    select 1
    from public.field_executive_provider_mappings target
    where target.company_id = p_company
      and target.workforce_id = p_workforce
      and target.status <> 'cancelled'
      and daterange(
        target.effective_from,
        coalesce(target.effective_to, 'infinity'::date),
        '[]'
      ) && daterange(new_start, 'infinity'::date, '[]')
  ) then
    raise exception 'The replacement period overlaps an existing mapping for the destination DropX ID';
  end if;

  if new_start > old_mapping.effective_from then
    update public.field_executive_provider_mappings
    set effective_to = new_start - 1,
        status = 'closed',
        updated_at = now()
    where id = old_mapping.id;
    old_disposition := 'closed';
  else
    update public.field_executive_provider_mappings
    set status = 'cancelled',
        updated_at = now()
    where id = old_mapping.id;
    old_disposition := 'cancelled';
  end if;

  perform public.workforce_save_joining_mapping(
    p_company,
    p_actor,
    p_workforce,
    null,
    p_dropx,
    p_payload,
    p_locations,
    p_actor_name
  );

  if old_mapping.workforce_id is not null then
    update public.workforce old_person
    set provider_employee_id = null,
        provider_id_status = 'pending',
        updated_at = now()
    where old_person.company_id = p_company
      and old_person.id = old_mapping.workforce_id
      and upper(btrim(coalesce(old_person.provider_employee_id, ''))) = upper(btrim(old_mapping.provider_member_id))
      and not exists (
        select 1
        from public.field_executive_provider_mappings remaining
        where remaining.company_id = p_company
          and remaining.workforce_id = old_person.id
          and remaining.effective_to is null
          and remaining.status = 'active'
      );

    insert into public.workforce_joining_events(
      company_id,
      workforce_id,
      event_code,
      actor_id,
      actor_name,
      details
    )
    values (
      p_company,
      old_mapping.workforce_id,
      'provider_mapping_replaced',
      p_actor,
      coalesce(nullif(btrim(p_actor_name), ''), 'Workforce mapping reviewer'),
      jsonb_build_object(
        'mapping_id', old_mapping.id,
        'provider_id', old_mapping.provider_id,
        'provider_member_id', old_mapping.provider_member_id,
        'replacement_workforce_id', p_workforce,
        'replacement_effective_from', new_start,
        'old_mapping_disposition', old_disposition
      )
    );
  end if;

  insert into public.workforce_joining_events(
    company_id,
    workforce_id,
    event_code,
    actor_id,
    actor_name,
    details
  )
  values (
    p_company,
    p_workforce,
    'provider_mapping_replacement_confirmed',
    p_actor,
    coalesce(nullif(btrim(p_actor_name), ''), 'Workforce mapping reviewer'),
    jsonb_build_object(
      'replaced_mapping_id', old_mapping.id,
      'previous_workforce_id', old_mapping.workforce_id,
      'provider_id', old_mapping.provider_id,
      'provider_member_id', old_mapping.provider_member_id,
      'effective_from', new_start,
      'old_mapping_disposition', old_disposition
    )
  );
end
$function$;

revoke all on function public.workforce_replace_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) from public, anon, authenticated;

grant execute on function public.workforce_replace_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) to service_role;

notify pgrst, 'reload schema';
