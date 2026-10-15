begin;

-- Multi-location provider mappings deliberately allow one canonical Workforce
-- person and Provider ID to be active at more than one station. The original
-- save RPC predates that rule and rejected an edit as soon as its corrected
-- period overlapped the same identity at another station. Keep rejecting a
-- different Provider identity for the same person, while the following guard
-- continues to reject duplicate periods for the same identity and station.
create or replace function public.workforce_save_mapping(
  p_company uuid,
  p_actor uuid,
  p_workforce uuid,
  p_mapping uuid,
  p_dropx text,
  p_payload jsonb,
  p_locations uuid[]
)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  w public.workforce;
  m public.field_executive_provider_mappings;
  v_old public.field_executive_provider_mappings;
  v_backdated boolean := false;
begin
  select *
  into w
  from public.workforce
  where company_id = p_company
    and id = p_workforce
    and deleted_at is null
    and migration_state <> 'reclassified'
  for update;

  if not found then
    raise exception 'Workforce profile was not found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_company::text || (p_payload ->> 'provider_id') || (p_payload ->> 'provider_member_id'),
      0
    )
  );

  m := jsonb_populate_record(null::public.field_executive_provider_mappings, p_payload);

  if p_locations is not null
    and (
      w.location_id is null
      or m.station_id is null
      or not (w.location_id = any(p_locations))
      or not (m.station_id = any(p_locations))
    )
  then
    raise exception 'Mapping is outside your station scope';
  end if;

  if not exists (
    select 1
    from public.stations
    where company_id = p_company
      and id = m.station_id
      and provider_id = m.provider_id
  ) then
    raise exception 'Provider and station do not match';
  end if;

  if p_mapping is not null then
    select *
    into v_old
    from public.field_executive_provider_mappings
    where company_id = p_company
      and id = p_mapping
    for update;

    if not found or v_old.workforce_id is distinct from p_workforce then
      raise exception 'Mapping does not belong to this associate';
    end if;
    if p_locations is not null
      and v_old.station_id is not null
      and not (v_old.station_id = any(p_locations))
    then
      raise exception 'Existing mapping is outside your station scope';
    end if;

    v_backdated := m.effective_from < v_old.effective_from;
    if v_backdated then
      if v_old.status <> 'active'
        or v_old.effective_to is not null
        or v_old.provider_id is distinct from m.provider_id
        or v_old.station_id is distinct from m.station_id
        or upper(btrim(v_old.provider_member_id)) <> upper(btrim(m.provider_member_id))
      then
        raise exception 'Only the exact active mapping can have its start date corrected earlier';
      end if;

    elsif m.effective_from > v_old.effective_from then
      update public.field_executive_provider_mappings
      set effective_to = m.effective_from - 1,
          status = 'closed',
          updated_at = now()
      where id = p_mapping;
      p_mapping := null;
    end if;
  end if;

  if exists (
    select 1
    from public.field_executive_provider_mappings x
    where x.company_id = p_company
      and x.workforce_id = p_workforce
      and x.status <> 'cancelled'
      and x.id <> coalesce(p_mapping, '00000000-0000-0000-0000-000000000000'::uuid)
      and x.id <> coalesce(v_old.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and (
        x.provider_id is distinct from m.provider_id
        or upper(btrim(x.provider_member_id))
          is distinct from upper(btrim(m.provider_member_id))
      )
      and daterange(x.effective_from, coalesce(x.effective_to, 'infinity'::date), '[]')
        && daterange(m.effective_from, coalesce(m.effective_to, 'infinity'::date), '[]')
  ) then
    raise exception 'This DropX ID already has an overlapping provider mapping';
  end if;

  if exists (
    select 1
    from public.field_executive_provider_mappings x
    where x.company_id = p_company
      and x.provider_id = m.provider_id
      and upper(btrim(x.provider_member_id)) = upper(btrim(m.provider_member_id))
      and x.station_id = m.station_id
      and x.status <> 'cancelled'
      and x.id <> coalesce(p_mapping, '00000000-0000-0000-0000-000000000000'::uuid)
      and x.id <> coalesce(v_old.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and daterange(x.effective_from, coalesce(x.effective_to, 'infinity'::date), '[]')
        && daterange(m.effective_from, coalesce(m.effective_to, 'infinity'::date), '[]')
  ) then
    raise exception 'Provider ID already has an overlapping mapping';
  end if;

  if p_mapping is null then
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
    )
    values (
      p_company,
      p_workforce,
      m.provider_id,
      m.station_id,
      m.provider_member_id,
      m.effective_from,
      m.effective_to,
      m.payment_method_id,
      m.payment_values,
      case
        when p_payload ? 'production_threshold_config' then m.production_threshold_config
        when v_old.id is not null and v_old.payment_method_id = m.payment_method_id
          then v_old.production_threshold_config
        else null
      end,
      m.pay_type,
      m.status,
      p_actor
    );
  else
    update public.field_executive_provider_mappings
    set provider_id = m.provider_id,
        station_id = m.station_id,
        provider_member_id = m.provider_member_id,
        effective_from = m.effective_from,
        effective_to = m.effective_to,
        payment_method_id = m.payment_method_id,
        payment_values = m.payment_values,
        production_threshold_config = case
          when p_payload ? 'production_threshold_config' then m.production_threshold_config
          else v_old.production_threshold_config
        end,
        pay_type = m.pay_type,
        delivery_rate = null,
        pickup_rate = null,
        mfn_rate = null,
        mfn_return_rate = null,
        guarantee_amount = null,
        guarantee_schedule = null,
        fuel_rate = null,
        reason = null,
        status = m.status,
        updated_at = now()
    where id = p_mapping;
  end if;

  -- Editing or versioning the same mapping station must never silently revert a
  -- Workforce profile that has already moved elsewhere. Initial mappings and
  -- confirmed replacements still synchronize the profile to the new station.
  update public.workforce
  set dropx_id = p_dropx,
      location_id = case
        when v_old.id is not null
          and v_old.station_id = m.station_id
          and w.location_id is distinct from v_old.station_id
        then w.location_id
        else m.station_id
      end,
      updated_at = now()
  where id = p_workforce;

  if v_backdated then
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
      'provider_mapping_start_corrected',
      p_actor,
      'Dashboard mapping reviewer',
      jsonb_build_object(
        'mapping_id', v_old.id,
        'previous_effective_from', v_old.effective_from,
        'corrected_effective_from', m.effective_from,
        'provider_id', v_old.provider_id,
        'provider_member_id', v_old.provider_member_id,
        'station_id', v_old.station_id
      )
    );
  end if;
end
$function$;

revoke all on function public.workforce_save_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[]
) from public, anon, authenticated;

grant execute on function public.workforce_save_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[]
) to service_role;

notify pgrst, 'reload schema';

commit;
