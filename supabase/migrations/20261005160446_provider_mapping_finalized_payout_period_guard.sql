-- Lock provider mapping changes only when they alter an approved or paid
-- Workforce payout period for the affected associate. Date-only corrections
-- compare the exact old/new intersection, so unrelated historical and future
-- periods remain editable.

-- Provider mapping history is mutable until the affected associate payout is
-- financially locked. Approved and paid runs protect only the dates where that
-- associate has a non-excluded payroll item; draft/review periods stay editable.
create or replace function public.workforce_provider_mapping_person(
  p_company uuid,
  p_workforce uuid,
  p_field_executive uuid,
  p_employee uuid,
  p_contractor uuid
)
returns uuid
language plpgsql
set search_path to ''
as $function$
declare
  identities uuid[];
begin
  if p_workforce is not null then
    return p_workforce;
  end if;

  if p_field_executive is null
    and p_employee is null
    and p_contractor is null
  then
    return null;
  end if;

  select array_agg(distinct workforce.id order by workforce.id)
  into identities
  from public.workforce workforce
  where workforce.company_id = p_company
    and workforce.deleted_at is null
    and workforce.migration_state <> 'reclassified'
    and (
      workforce.id = p_field_executive
      or (
        workforce.source_profile_type = 'field_executive'
        and workforce.source_profile_id = p_field_executive
      )
      or (
        workforce.source_profile_type = 'employee'
        and workforce.source_profile_id = p_employee
      )
      or (
        workforce.source_profile_type = 'contractor'
        and workforce.source_profile_id = p_contractor
      )
    );

  if cardinality(identities) > 1 then
    raise exception 'Legacy mapping identity is ambiguous. Reconcile the canonical person first';
  end if;
  if identities[1] is null then
    raise exception 'Provider mapping identity must resolve to a canonical Workforce profile';
  end if;
  return identities[1];
end
$function$;

comment on function public.workforce_provider_mapping_person(
  uuid, uuid, uuid, uuid, uuid
) is
  'Resolves canonical Workforce identity for provider mappings, including legacy employee, contractor and field-executive references.';

revoke all on function public.workforce_provider_mapping_person(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.workforce_provider_mapping_person(
  uuid, uuid, uuid, uuid, uuid
) to service_role;

create or replace function public.workforce_joining_mapping_guard()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  affected uuid;
  old_affected uuid;
  company uuid;
  old_range daterange := 'empty'::daterange;
  new_range daterange := 'empty'::daterange;
  definition_changed boolean := true;
  locked_period record;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    old_affected := public.workforce_provider_mapping_person(
      old.company_id,
      old.workforce_id,
      old.field_executive_id,
      old.employee_id,
      old.contractor_id
    );
    if lower(coalesce(old.status, '')) <> 'cancelled' then
      old_range := daterange(
        old.effective_from,
        coalesce(old.effective_to, 'infinity'::date),
        '[]'
      );
    end if;
  end if;

  if tg_op <> 'DELETE' then
    affected := public.workforce_provider_mapping_person(
      new.company_id,
      new.workforce_id,
      new.field_executive_id,
      new.employee_id,
      new.contractor_id
    );
    company := new.company_id;
    if lower(coalesce(new.status, '')) <> 'cancelled' then
      new_range := daterange(
        new.effective_from,
        coalesce(new.effective_to, 'infinity'::date),
        '[]'
      );
    end if;
  else
    affected := old_affected;
    company := old.company_id;
  end if;

  if tg_op = 'UPDATE' then
    if (to_jsonb(old) - 'updated_at')
      is not distinct from (to_jsonb(new) - 'updated_at')
    then
      return new;
    end if;

    if old.company_id is distinct from new.company_id
      or old_affected is distinct from affected
    then
      raise exception 'Do not reassign a mapping; close and create an audited mapping';
    end if;

    -- Effective dates and cancelled/active coverage are compared separately
    -- against each locked run below. Every field here can change the payout
    -- source, location, calculation, rate, threshold, or mapping attribution.
    definition_changed := row(
      new.provider_id,
      new.station_id,
      upper(btrim(new.provider_member_id)),
      new.pay_type,
      new.delivery_rate,
      new.pickup_rate,
      new.mfn_rate,
      new.mfn_return_rate,
      new.guarantee_amount,
      new.guarantee_schedule,
      new.fuel_rate,
      new.payment_method_id,
      new.payment_values,
      new.production_threshold_config
    ) is distinct from row(
      old.provider_id,
      old.station_id,
      upper(btrim(old.provider_member_id)),
      old.pay_type,
      old.delivery_rate,
      old.pickup_rate,
      old.mfn_rate,
      old.mfn_return_rate,
      old.guarantee_amount,
      old.guarantee_schedule,
      old.fuel_rate,
      old.payment_method_id,
      old.payment_values,
      old.production_threshold_config
    );
  end if;

  if affected is not null then
    -- Match payroll confirmation lock order: Workforce identity first, then
    -- the shared company mutex. This makes a concurrent approval and mapping
    -- write resolve wholly before or wholly after each other.
    perform 1
    from public.workforce workforce
    where workforce.id = affected
      and workforce.company_id = company
    for update;

    perform public.lock_workforce_payment_allocation_company(company);

    select
      payroll_run.period_start,
      payroll_run.period_end,
      lower(payroll_run.status) as status
    into locked_period
    from public.workforce_payroll_items payroll_item
    join public.workforce_payroll_runs payroll_run
      on payroll_run.id = payroll_item.payroll_run_id
     and payroll_run.company_id = payroll_item.company_id
    where payroll_item.company_id = company
      and payroll_item.workforce_id = affected
      and coalesce(payroll_item.status, '') <> 'excluded'
      and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
      and (
        case
          when definition_changed then
            not isempty(
              daterange(payroll_run.period_start, payroll_run.period_end, '[]')
              * old_range
            )
            or not isempty(
              daterange(payroll_run.period_start, payroll_run.period_end, '[]')
              * new_range
            )
          else
            (
              daterange(payroll_run.period_start, payroll_run.period_end, '[]')
              * old_range
            ) is distinct from (
              daterange(payroll_run.period_start, payroll_run.period_end, '[]')
              * new_range
            )
        end
      )
    order by payroll_run.period_start, payroll_run.period_end, payroll_run.id
    limit 1;

    if found then
      raise exception
        'Workforce payout % to % is %; this mapping change affects that locked period.',
        locked_period.period_start,
        locked_period.period_end,
        locked_period.status;
    end if;

    update public.workforce_joining_plans
    set version = version + 1,
        updated_at = now()
    where workforce_id = affected
      and company_id = company;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

comment on function public.workforce_joining_mapping_guard() is
  'Serializes provider mapping writes with payroll confirmation. Only approved/paid, non-excluded associate payout dates are immutable; draft/review and non-overlapping dates remain editable.';

revoke all on function public.workforce_joining_mapping_guard()
  from public, anon, authenticated;
grant execute on function public.workforce_joining_mapping_guard()
  to service_role;

-- Trigger names determine BEFORE-trigger order. Run the finalized-period guard
-- after canonicalization/payment-basis validation and before the provider/direct
-- overlap guard, so both mapping and direct-allocation writers acquire locks in
-- the same order: Workforce row, company mutex, then person overlap mutex.
drop trigger if exists workforce_joining_mapping_guard
  on public.field_executive_provider_mappings;
drop trigger if exists field_executive_provider_mappings_01_finalized_payout_guard
  on public.field_executive_provider_mappings;
create trigger field_executive_provider_mappings_01_finalized_payout_guard
before insert or update or delete
on public.field_executive_provider_mappings
for each row execute function public.workforce_joining_mapping_guard();

-- The central trigger above is the single period-lock authority. These RPCs
-- retain their validation and atomic history behavior without broader duplicate
-- checks that previously blocked unrelated approved/paid periods.

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

