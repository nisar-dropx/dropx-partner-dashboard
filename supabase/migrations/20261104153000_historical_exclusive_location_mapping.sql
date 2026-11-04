begin;

-- A completed assignment at a former station is not a simultaneous Keep-all
-- assignment. Require a previously verified identity and an entirely free
-- period, without changing the person's current station or later rates.
create or replace function public.workforce_historical_mapping_period_available(
  p_company uuid, p_workforce uuid, p_provider uuid, p_member text,
  p_from date, p_to date
) returns boolean language sql stable security invoker set search_path = '' as $$
  select case when p_from is null or p_to is null or p_to < p_from then false
  else coalesce(
    p_to < (now() at time zone 'Asia/Kolkata')::date
    and nullif(btrim(p_member), '') is not null
    and exists (
      select 1 from public.field_executive_provider_mappings m
      where m.company_id = p_company and m.provider_id = p_provider
        and upper(btrim(m.provider_member_id)) = upper(btrim(p_member))
        and ((m.status = 'active' and m.effective_to is null)
          or (m.status = 'closed' and m.effective_to >= m.effective_from))
        and public.workforce_provider_mapping_person(m.company_id, m.workforce_id,
          m.field_executive_id, m.employee_id, m.contractor_id) = p_workforce
    )
    and not exists (
      select 1 from public.field_executive_provider_mappings m
      where m.company_id = p_company and m.status <> 'cancelled'
        and (public.workforce_provider_mapping_person(m.company_id, m.workforce_id,
          m.field_executive_id, m.employee_id, m.contractor_id) = p_workforce
          or (m.provider_id = p_provider
            and upper(btrim(m.provider_member_id)) = upper(btrim(p_member))))
        and daterange(m.effective_from, m.effective_to, '[]') && daterange(p_from, p_to, '[]')
    ), false) end;
$$;

create or replace function public.workforce_save_historical_location_mapping(
  p_company uuid, p_actor uuid, p_workforce uuid, p_payload jsonb, p_locations uuid[]
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  person public.workforce;
  desired public.field_executive_provider_mappings;
  new_mapping uuid;
begin
  if p_company is null or p_actor is null or p_workforce is null then
    raise exception 'A company, authenticated reviewer and Workforce profile are required';
  end if;
  select * into person from public.workforce
    where company_id = p_company and id = p_workforce and deleted_at is null
      and migration_state <> 'reclassified' for update;
  if not found or person.location_id is null then
    raise exception 'The Workforce profile or registered location is unavailable';
  end if;
  if person.last_working_date < (now() at time zone 'Asia/Kolkata')::date
    or coalesce(person.lifecycle_status, '') in
      ('offboarded','closed','exited','terminated','resigned','settled','inactive') then
    raise exception 'This Workforce associate is inactive or no longer eligible for ID mapping';
  end if;
  desired := jsonb_populate_record(null::public.field_executive_provider_mappings, p_payload);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_company::text || desired.provider_id::text || upper(btrim(desired.provider_member_id)), 0));
  if desired.station_id is null or desired.station_id = person.location_id
    or desired.status is distinct from 'closed'
    or (p_locations is not null and
      (not (person.location_id = any(p_locations)) or not (desired.station_id = any(p_locations)))) then
    raise exception 'Historical mapping location is invalid or outside your station scope';
  end if;
  if not exists (select 1 from public.stations s where s.company_id = p_company
    and s.id = desired.station_id and s.provider_id = desired.provider_id) then
    raise exception 'Provider and station do not match';
  end if;
  if not exists (select 1 from public.payment_methods p where p.company_id = p_company
    and p.id = desired.payment_method_id and p.is_active and p.code = desired.pay_type) then
    raise exception 'The payment method is unavailable';
  end if;
  if not public.workforce_historical_mapping_period_available(p_company, p_workforce,
    desired.provider_id, desired.provider_member_id, desired.effective_from, desired.effective_to) then
    raise exception 'Use a completed date range without another mapping for this person or Provider ID. Reload history and resolve overlapping periods first.';
  end if;

  -- Ordinary INSERT: published-payment, ownership and payroll locks remain
  -- authoritative. No trigger or validation is disabled for a correction.
  insert into public.field_executive_provider_mappings (
    company_id, workforce_id, provider_id, station_id, provider_member_id,
    effective_from, effective_to, payment_method_id, payment_values,
    production_threshold_config, pay_type, status, created_by
  ) values (
    p_company, p_workforce, desired.provider_id, desired.station_id, btrim(desired.provider_member_id),
    desired.effective_from, desired.effective_to, desired.payment_method_id, desired.payment_values,
    desired.production_threshold_config, desired.pay_type, 'closed', p_actor
  ) returning id into new_mapping;
  insert into public.workforce_joining_events(company_id, workforce_id, event_code, actor_id, actor_name, details)
    values(p_company, p_workforce, 'provider_mapping_historical_location_saved', p_actor,
      'Dashboard mapping reviewer', jsonb_build_object('mapping_id', new_mapping,
        'provider_id', desired.provider_id, 'provider_member_id', desired.provider_member_id,
        'station_id', desired.station_id, 'effective_from', desired.effective_from,
        'effective_to', desired.effective_to, 'payment_method_id', desired.payment_method_id,
        'payment_values', desired.payment_values, 'current_station_preserved', person.location_id));
  return new_mapping;
end;
$$;

-- Retain exclusivity on later edits too, including edits to the other station.
create or replace function public.workforce_exclusive_historical_mapping_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  changed public.field_executive_provider_mappings;
  historical public.field_executive_provider_mappings;
  changed_owner uuid;
begin
  if tg_op = 'DELETE' then changed := old; else changed := new; end if;
  changed_owner := public.workforce_provider_mapping_person(changed.company_id, changed.workforce_id,
    changed.field_executive_id, changed.employee_id, changed.contractor_id);
  for historical in
    select m.* from public.field_executive_provider_mappings m
    where m.company_id = changed.company_id and m.status <> 'cancelled'
      and (m.workforce_id = changed_owner or (m.provider_id = changed.provider_id
        and upper(btrim(m.provider_member_id)) = upper(btrim(changed.provider_member_id))))
      and exists (select 1 from public.workforce_joining_events e
        where e.company_id = m.company_id and e.workforce_id = m.workforce_id
          and e.event_code = 'provider_mapping_historical_location_saved'
          and e.details ->> 'mapping_id' = m.id::text)
  loop
    if historical.status <> 'closed' or historical.effective_to is null
      or historical.effective_to < historical.effective_from
      or historical.effective_to >= (now() at time zone 'Asia/Kolkata')::date then
      raise exception 'An exclusive historical assignment must retain a completed date range';
    end if;
    if exists (select 1 from public.field_executive_provider_mappings m
      where m.company_id = historical.company_id and m.id <> historical.id and m.status <> 'cancelled'
        and (public.workforce_provider_mapping_person(m.company_id, m.workforce_id,
          m.field_executive_id, m.employee_id, m.contractor_id) = historical.workforce_id
          or (m.provider_id = historical.provider_id
            and upper(btrim(m.provider_member_id)) = upper(btrim(historical.provider_member_id))))
        and daterange(m.effective_from,m.effective_to,'[]')
          && daterange(historical.effective_from,historical.effective_to,'[]')) then
      raise exception 'Another mapping overlaps an exclusive historical assignment. Resolve its dates first.';
    end if;
  end loop;
  return null;
end;
$$;
drop trigger if exists workforce_exclusive_historical_mapping_guard on public.field_executive_provider_mappings;
create constraint trigger workforce_exclusive_historical_mapping_guard
  after insert or update or delete on public.field_executive_provider_mappings
  deferrable initially deferred for each row execute function public.workforce_exclusive_historical_mapping_guard();
revoke all on function public.workforce_exclusive_historical_mapping_guard() from public, anon, authenticated;
grant execute on function public.workforce_exclusive_historical_mapping_guard() to service_role;

revoke all on function public.workforce_historical_mapping_period_available(uuid,uuid,uuid,text,date,date) from public, anon, authenticated;
revoke all on function public.workforce_save_historical_location_mapping(uuid,uuid,uuid,jsonb,uuid[]) from public, anon, authenticated;
grant execute on function public.workforce_historical_mapping_period_available(uuid,uuid,uuid,text,date,date) to service_role;
grant execute on function public.workforce_save_historical_location_mapping(uuid,uuid,uuid,jsonb,uuid[]) to service_role;
notify pgrst, 'reload schema';
commit;
