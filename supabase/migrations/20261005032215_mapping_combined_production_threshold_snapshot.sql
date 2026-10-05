alter table public.field_executive_provider_mappings
  add column if not exists production_threshold_config jsonb;

comment on column public.field_executive_provider_mappings.production_threshold_config is
  'Effective-dated combined production minimum snapshot. Shape: {"period":"day"|"month","component_codes":[...],"minimum_units":positive integer}, or {"enabled":false} when disabled for this mapping period.';

-- Rows created before this feature must remain threshold-free if their live
-- payment method is enabled later. Null remains reserved for an incomplete
-- post-feature write, which payout calculation intentionally fails closed.
update public.field_executive_provider_mappings
set production_threshold_config = '{"enabled":false}'::jsonb
where production_threshold_config is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'field_executive_provider_mappings_threshold_config_check'
      and conrelid = 'public.field_executive_provider_mappings'::regclass
  ) then
    alter table public.field_executive_provider_mappings
      add constraint field_executive_provider_mappings_threshold_config_check
      check (
        production_threshold_config is null
        or production_threshold_config = '{"enabled":false}'::jsonb
        or (
          jsonb_typeof(production_threshold_config) = 'object'
          and production_threshold_config ? 'period'
          and production_threshold_config ? 'component_codes'
          and production_threshold_config ? 'minimum_units'
          and production_threshold_config ->> 'period' in ('day', 'month')
          and jsonb_typeof(production_threshold_config -> 'component_codes') = 'array'
          and jsonb_array_length(production_threshold_config -> 'component_codes') > 0
          and not jsonb_path_exists(
            production_threshold_config -> 'component_codes',
            '$[*] ? (@.type() != "string")'
          )
          and jsonb_typeof(production_threshold_config -> 'minimum_units') = 'number'
          and (production_threshold_config ->> 'minimum_units')::numeric > 0
          and (production_threshold_config ->> 'minimum_units')::numeric = trunc((production_threshold_config ->> 'minimum_units')::numeric)
        )
      );
  end if;
end $$;

-- workforce_save_mapping uses an explicit column list, so include the new
-- snapshot in both its insert and update paths. The function signature and all
-- existing scope, overlap and history checks remain unchanged.
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
    if m.effective_from < v_old.effective_from then
      raise exception 'A mapping version cannot start before its existing period';
    end if;
    if m.effective_from > v_old.effective_from then
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
      and x.provider_id = m.provider_id
      and x.provider_member_id = m.provider_member_id
      and x.station_id = m.station_id
      and x.status <> 'cancelled'
      and x.id <> coalesce(p_mapping, '00000000-0000-0000-0000-000000000000'::uuid)
      and daterange(x.effective_from, x.effective_to, '[]') && daterange(m.effective_from, m.effective_to, '[]')
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

  update public.workforce
  set dropx_id = p_dropx,
      location_id = m.station_id,
      updated_at = now()
  where id = p_workforce;
end
$function$;

revoke all on function public.workforce_save_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[]
) from public, anon, authenticated;

grant execute on function public.workforce_save_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[]
) to service_role;

notify pgrst, 'reload schema';
