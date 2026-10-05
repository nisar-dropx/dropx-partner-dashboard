-- Provider mapping corrections must preserve the distinction between the
-- effective-dated mapping station and the Workforce profile's current station.
-- An existing mapping can be backdated in place only when that widened period
-- is conflict-free and has not been used by finalized payroll.
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

      -- Serialize with payroll confirmation before accepting a historical
      -- correction. Draft/review payroll remains recalculable; approved/paid is
      -- immutable for a participating associate.
      perform public.lock_workforce_payment_allocation_company(p_company);
      if exists (
        select 1
        from public.workforce_payroll_runs payroll_run
        join public.workforce_payroll_items payroll_item
          on payroll_item.company_id = payroll_run.company_id
         and payroll_item.payroll_run_id = payroll_run.id
         and payroll_item.workforce_id = p_workforce
        where payroll_run.company_id = p_company
          and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
          and coalesce(payroll_item.status, '') <> 'excluded'
          and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
            && daterange(m.effective_from, coalesce(m.effective_to, 'infinity'::date), '[]')
      ) then
        raise exception 'Finalized Workforce payroll uses this mapping period. Correct the start date after the approved or paid payroll period.';
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

-- A location correction may encounter policy history that already records the
-- destination station (for example, the Workforce profile was moved before the
-- provider mapping was corrected). Treat old and destination snapshots as one
-- reconcilable path while still rejecting an unrelated third location.
create or replace function public.workforce_rebase_payment_policy_location(
  p_company uuid,
  p_workforce uuid,
  p_old_station uuid,
  p_new_station uuid,
  p_effective_from date
)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  new_station public.stations;
  covering_policy public.workforce_payment_policy_history;
  seed_policy public.workforce_payment_policy_history;
  person public.workforce;
  designation public.designations;
begin
  if p_old_station is null or p_new_station is null or p_effective_from is null then
    raise exception 'Old location, new location and effective date are required';
  end if;
  if p_old_station = p_new_station then
    return;
  end if;

  select *
  into new_station
  from public.stations
  where company_id = p_company
    and id = p_new_station
    and is_active = true;

  if new_station.id is null then
    raise exception 'The destination location is unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('workforce-payment-policy:' || p_workforce::text, 0)
  );
  perform 1
  from public.workforce_payment_policy_history
  where company_id = p_company
    and workforce_id = p_workforce
  order by effective_from, id
  for update;

  if exists (
    select 1
    from public.workforce_payment_policy_history policy
    where policy.company_id = p_company
      and policy.workforce_id = p_workforce
      and coalesce(policy.effective_to, 'infinity'::date) >= p_effective_from
      and policy.station_id is distinct from p_old_station
      and policy.station_id is distinct from p_new_station
  ) then
    raise exception 'Payment-policy history contains a later location change; reconcile it first';
  end if;

  select policy.*
  into covering_policy
  from public.workforce_payment_policy_history policy
  where policy.company_id = p_company
    and policy.workforce_id = p_workforce
    and policy.effective_from <= p_effective_from
    and coalesce(policy.effective_to, 'infinity'::date) >= p_effective_from
  order by policy.effective_from desc, policy.recorded_at desc
  limit 1
  for update;

  if covering_policy.id is not null then
    if covering_policy.station_id = p_old_station then
      if covering_policy.effective_from < p_effective_from then
        update public.workforce_payment_policy_history
        set effective_to = p_effective_from - 1
        where id = covering_policy.id;

        insert into public.workforce_payment_policy_history(
          company_id,
          workforce_id,
          station_id,
          station_code_snapshot,
          designation_id,
          designation_code_snapshot,
          designation_name_snapshot,
          designation_is_active,
          is_field_operations,
          provider_mapping_required,
          effective_from,
          effective_to,
          change_source
        ) values (
          p_company,
          p_workforce,
          p_new_station,
          new_station.station_code,
          covering_policy.designation_id,
          covering_policy.designation_code_snapshot,
          covering_policy.designation_name_snapshot,
          covering_policy.designation_is_active,
          covering_policy.is_field_operations,
          covering_policy.provider_mapping_required,
          p_effective_from,
          covering_policy.effective_to,
          'provider_mapping_location_move'
        );
      else
        update public.workforce_payment_policy_history
        set station_id = p_new_station,
            station_code_snapshot = new_station.station_code,
            change_source = 'provider_mapping_location_move'
        where id = covering_policy.id;
      end if;
    elsif covering_policy.station_id is distinct from p_new_station then
      raise exception 'Payment-policy history contains an unrelated location at the requested move date';
    end if;
  else
    select policy.*
    into seed_policy
    from public.workforce_payment_policy_history policy
    where policy.company_id = p_company
      and policy.workforce_id = p_workforce
      and policy.effective_from > p_effective_from
    order by policy.effective_from, policy.recorded_at
    limit 1
    for update;

    if seed_policy.id is not null then
      if coalesce(seed_policy.change_source, '') <> 'migration_backfill' then
        raise exception 'Payment-policy history does not cover the requested location-move date';
      end if;
      insert into public.workforce_payment_policy_history(
        company_id,
        workforce_id,
        station_id,
        station_code_snapshot,
        designation_id,
        designation_code_snapshot,
        designation_name_snapshot,
        designation_is_active,
        is_field_operations,
        provider_mapping_required,
        effective_from,
        effective_to,
        change_source
      ) values (
        p_company,
        p_workforce,
        p_new_station,
        new_station.station_code,
        seed_policy.designation_id,
        seed_policy.designation_code_snapshot,
        seed_policy.designation_name_snapshot,
        seed_policy.designation_is_active,
        seed_policy.is_field_operations,
        seed_policy.provider_mapping_required,
        p_effective_from,
        seed_policy.effective_from - 1,
        'provider_mapping_location_move'
      );
    else
      select *
      into person
      from public.workforce
      where company_id = p_company
        and id = p_workforce;

      select candidate.*
      into designation
      from public.designations candidate
      where candidate.company_id = p_company
        and (
          candidate.id = person.designation_id
          or (
            person.designation_id is null
            and lower(btrim(coalesce(person.designation, ''))) in (
              lower(btrim(candidate.code)),
              lower(btrim(candidate.name))
            )
          )
        )
      order by (candidate.id = person.designation_id) desc, candidate.id
      limit 1;

      if designation.id is null then
        raise exception 'Payment-policy designation is unavailable';
      end if;

      insert into public.workforce_payment_policy_history(
        company_id,
        workforce_id,
        station_id,
        station_code_snapshot,
        designation_id,
        designation_code_snapshot,
        designation_name_snapshot,
        designation_is_active,
        is_field_operations,
        provider_mapping_required,
        effective_from,
        effective_to,
        change_source
      ) values (
        p_company,
        p_workforce,
        p_new_station,
        new_station.station_code,
        designation.id,
        designation.code,
        designation.name,
        coalesce(designation.is_active, false),
        coalesce(designation.is_active, false) and coalesce(designation.is_field_operations, false),
        coalesce(designation.is_active, false)
          and coalesce(designation.is_field_operations, false)
          and coalesce(designation.provider_mapping_required, false),
        p_effective_from,
        null,
        'provider_mapping_location_move'
      );
    end if;
  end if;

  update public.workforce_payment_policy_history policy
  set station_id = p_new_station,
      station_code_snapshot = new_station.station_code
  where policy.company_id = p_company
    and policy.workforce_id = p_workforce
    and policy.effective_from > p_effective_from
    and policy.station_id = p_old_station;
end
$function$;

revoke all on function public.workforce_rebase_payment_policy_location(
  uuid, uuid, uuid, uuid, date
) from public, anon, authenticated;

grant execute on function public.workforce_rebase_payment_policy_location(
  uuid, uuid, uuid, uuid, date
) to service_role;

-- A confirmed location replacement is still valid when the Workforce profile
-- already reflects the destination. The old mapping UUID remains the stale
-- confirmation token, and all history writes stay inside this transaction.
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
  new_mapping_id uuid;
  new_start date;
  new_station_id uuid;
  today date := (now() at time zone 'Asia/Kolkata')::date;
  old_disposition text;
  is_location_move boolean := false;
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
    new_station_id := (p_payload ->> 'station_id')::uuid;
  exception when others then
    raise exception 'A valid replacement effective date and location are required';
  end;
  if new_start > today then
    raise exception 'A replacement mapping cannot start in the future';
  end if;

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

  is_location_move := old_mapping.workforce_id = p_workforce
    and old_mapping.station_id is distinct from new_station_id;

  if old_mapping.workforce_id = p_workforce and not is_location_move then
    raise exception 'The provider ID is already mapped to the selected Workforce profile at this location';
  end if;
  if is_location_move
    and person.location_id is distinct from old_mapping.station_id
    and person.location_id is distinct from new_station_id
  then
    raise exception 'The Workforce location changed after confirmation';
  end if;
  if is_location_move and new_start < old_mapping.effective_from then
    raise exception 'A location move cannot start before the existing mapping';
  end if;
  if p_locations is not null
    and (
      person.location_id is null
      or not (person.location_id = any(p_locations))
      or old_mapping.station_id is null
      or not (old_mapping.station_id = any(p_locations))
      or not (new_station_id = any(p_locations))
    )
  then
    raise exception 'The existing or destination mapping is outside your station scope';
  end if;

  -- A location or owner replacement changes effective mapping history and may
  -- also rebase the station snapshot used by payroll. Serialize with payroll
  -- confirmation and keep approved/paid participating rows immutable.
  perform public.lock_workforce_payment_allocation_company(p_company);
  if exists (
    select 1
    from public.workforce_payroll_runs payroll_run
    join public.workforce_payroll_items payroll_item
      on payroll_item.company_id = payroll_run.company_id
     and payroll_item.payroll_run_id = payroll_run.id
    where payroll_run.company_id = p_company
      and payroll_item.workforce_id = any(
        array_remove(array[p_workforce, old_mapping.workforce_id], null)
      )
      and coalesce(payroll_item.status, '') <> 'excluded'
      and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
      and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
        && daterange(
          least(new_start, old_mapping.effective_from),
          'infinity'::date,
          '[]'
        )
  ) then
    raise exception 'Finalized Workforce payroll uses this mapping period. Move or replace the mapping after the approved or paid payroll period.';
  end if;

  if exists (
    select 1
    from public.field_executive_provider_mappings target
    where target.company_id = p_company
      and target.workforce_id = p_workforce
      and target.id <> old_mapping.id
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

  if is_location_move then
    perform public.workforce_rebase_payment_policy_location(
      p_company,
      p_workforce,
      old_mapping.station_id,
      new_station_id,
      new_start
    );
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

  select mapping.id
  into new_mapping_id
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.workforce_id = p_workforce
    and mapping.provider_id = (p_payload ->> 'provider_id')::uuid
    and upper(btrim(mapping.provider_member_id)) = upper(btrim(p_payload ->> 'provider_member_id'))
    and mapping.station_id = new_station_id
    and mapping.effective_from = new_start
    and mapping.status = 'active'
    and mapping.effective_to is null
  order by mapping.created_at desc, mapping.id desc
  limit 1;

  if new_mapping_id is null then
    raise exception 'The replacement mapping could not be verified';
  end if;

  if is_location_move then
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
      'provider_mapping_location_moved',
      p_actor,
      coalesce(nullif(btrim(p_actor_name), ''), 'Workforce mapping reviewer'),
      jsonb_build_object(
        'previous_mapping_id', old_mapping.id,
        'new_mapping_id', new_mapping_id,
        'provider_id', old_mapping.provider_id,
        'provider_member_id', old_mapping.provider_member_id,
        'previous_station_id', old_mapping.station_id,
        'new_station_id', new_station_id,
        'effective_from', new_start,
        'old_mapping_disposition', old_disposition
      )
    );
    return;
  end if;

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
    ) values (
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
  ) values (
    p_company,
    p_workforce,
    'provider_mapping_replacement_confirmed',
    p_actor,
    coalesce(nullif(btrim(p_actor_name), ''), 'Workforce mapping reviewer'),
    jsonb_build_object(
      'replaced_mapping_id', old_mapping.id,
      'previous_workforce_id', old_mapping.workforce_id,
      'new_mapping_id', new_mapping_id,
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
