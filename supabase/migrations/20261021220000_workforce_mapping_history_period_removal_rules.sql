-- Make history-period removal a narrow, auditable operation. Financially
-- published/locked periods remain immutable. Outside that boundary, an
-- additional-location period can always be removed, while a registered-
-- location period remains the anchor for every overlapping additional row.
begin;

create or replace function public.workforce_provider_mapping_registered_location_guard()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  old_person uuid;
  new_person uuid;
  registered_station uuid;
begin
  -- Cancelling one exact history row cannot create a dependency when the row
  -- belongs to an additional location. For a registered-location row, inspect
  -- only the interval being removed. This intentionally avoids allowing an
  -- unrelated legacy data issue to prevent cleanup of an additional row.
  if tg_op = 'UPDATE'
    and old.status in ('active', 'closed')
    and new.status = 'cancelled'
    and (
      to_jsonb(old) - array['status', 'updated_at']::text[]
    ) is not distinct from (
      to_jsonb(new) - array['status', 'updated_at']::text[]
    )
  then
    old_person := public.workforce_provider_mapping_person(
      old.company_id,
      old.workforce_id,
      old.field_executive_id,
      old.employee_id,
      old.contractor_id
    );

    if old_person is null then
      raise exception 'Provider mapping must resolve to a canonical Workforce profile';
    end if;

    select workforce.location_id
    into registered_station
    from public.workforce workforce
    where workforce.company_id = old.company_id
      and workforce.id = old_person
      and workforce.deleted_at is null
      and workforce.migration_state <> 'reclassified';

    if old.station_id is not distinct from registered_station
      and exists (
        select 1
        from public.field_executive_provider_mappings additional
        where additional.company_id = old.company_id
          and additional.id is distinct from old.id
          and additional.status in ('active', 'closed')
          and additional.station_id is distinct from registered_station
          and public.workforce_provider_mapping_person(
            additional.company_id,
            additional.workforce_id,
            additional.field_executive_id,
            additional.employee_id,
            additional.contractor_id
          ) = old_person
          and daterange(
            additional.effective_from,
            coalesce(additional.effective_to, 'infinity'::date),
            '[]'
          ) && daterange(
            old.effective_from,
            coalesce(old.effective_to, 'infinity'::date),
            '[]'
          )
      )
    then
      raise exception 'The registered-location mapping cannot be removed while an additional-location mapping overlaps this period. Remove the additional-location period first.';
    end if;

    return null;
  end if;

  -- All non-removal writes retain the complete registered-location coverage
  -- invariant established by the existing deferred constraint trigger.
  if tg_op in ('UPDATE', 'DELETE') then
    old_person := public.workforce_provider_mapping_person(
      old.company_id,
      old.workforce_id,
      old.field_executive_id,
      old.employee_id,
      old.contractor_id
    );
    perform public.workforce_assert_provider_mapping_registered_location(
      old.company_id,
      old_person
    );
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    new_person := public.workforce_provider_mapping_person(
      new.company_id,
      new.workforce_id,
      new.field_executive_id,
      new.employee_id,
      new.contractor_id
    );
    if new_person is null then
      raise exception 'Provider mapping must resolve to a canonical Workforce profile';
    end if;

    if tg_op = 'INSERT' then
      perform public.workforce_assert_provider_mapping_registered_location(
        new.company_id,
        new_person
      );
    elsif new.company_id is distinct from old.company_id
      or new_person is distinct from old_person
    then
      perform public.workforce_assert_provider_mapping_registered_location(
        new.company_id,
        new_person
      );
    end if;
  end if;

  return null;
end
$function$;

comment on function public.workforce_provider_mapping_registered_location_guard()
is 'Deferred integrity guard: exact additional-location cancellation is always allowed; registered-location cancellation is blocked only by overlapping additional-location periods; all other writes retain full registered-location coverage validation.';

create or replace function public.workforce_clear_mapping_period(
  p_company uuid,
  p_actor uuid,
  p_workforce uuid,
  p_mapping uuid,
  p_expected_updated_at timestamptz,
  p_locations uuid[],
  p_actor_name text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  person public.workforce;
  mapping_row public.field_executive_provider_mappings;
  mapping_owner uuid;
  remaining_mapping public.field_executive_provider_mappings;
  remaining_details jsonb;
  published_period record;
  today_in_kolkata date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if p_company is null
    or p_actor is null
    or p_workforce is null
    or p_mapping is null
    or p_expected_updated_at is null
  then
    raise exception 'A company, authenticated reviewer, Workforce profile, mapping period and mapping version are required';
  end if;

  select workforce.*
  into person
  from public.workforce workforce
  where workforce.company_id = p_company
    and workforce.id = p_workforce
    and workforce.deleted_at is null
    and workforce.migration_state <> 'reclassified'
  for update;

  if person.id is null then
    raise exception 'The Workforce profile was not found';
  end if;

  select mapping.*
  into mapping_row
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.id = p_mapping
  for update;

  if mapping_row.id is null then
    raise exception 'The mapping period changed. Reload the page and try again';
  end if;

  if mapping_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'The mapping period changed. Reload the page and try again';
  end if;

  mapping_owner := public.workforce_provider_mapping_person(
    mapping_row.company_id,
    mapping_row.workforce_id,
    mapping_row.field_executive_id,
    mapping_row.employee_id,
    mapping_row.contractor_id
  );

  if mapping_owner is distinct from p_workforce then
    raise exception 'The mapping period does not belong to this Workforce profile';
  end if;

  if not (
    (mapping_row.status = 'active' and mapping_row.effective_to is null)
    or (
      mapping_row.status = 'closed'
      and mapping_row.effective_to is not null
      and mapping_row.effective_to >= mapping_row.effective_from
    )
  ) then
    raise exception 'The mapping period changed. Reload the page and try again';
  end if;

  if p_locations is not null
    and (
      person.location_id is null
      or not (person.location_id = any(p_locations))
      or mapping_row.station_id is null
      or not (mapping_row.station_id = any(p_locations))
    )
  then
    raise exception 'The mapping period is outside your station scope';
  end if;

  -- Publication is an absolute removal boundary. Unlike audited remapping, an
  -- open mapping-unlock does not permit deleting the period that was published.
  select publication.period_start, publication.period_end
  into published_period
  from public.workforce_payout_publications publication
  where publication.company_id = p_company
    and publication.workforce_id = p_workforce
    and publication.publication_kind = 'worksheet'
    and daterange(
      publication.period_start,
      publication.period_end,
      '[]'
    ) && daterange(
      mapping_row.effective_from,
      coalesce(mapping_row.effective_to, 'infinity'::date),
      '[]'
    )
  order by publication.period_start, publication.period_end, publication.id
  limit 1;

  if found then
    raise exception
      'Workforce payout % to % was published; this mapping period cannot be removed.',
      published_period.period_start,
      published_period.period_end;
  end if;

  -- Give the caller the requested dependency error immediately. The deferred
  -- trigger repeats this check as the table-wide integrity boundary.
  if mapping_row.station_id is not distinct from person.location_id
    and exists (
      select 1
      from public.field_executive_provider_mappings additional
      where additional.company_id = p_company
        and additional.id is distinct from mapping_row.id
        and additional.status in ('active', 'closed')
        and additional.station_id is distinct from person.location_id
        and public.workforce_provider_mapping_person(
          additional.company_id,
          additional.workforce_id,
          additional.field_executive_id,
          additional.employee_id,
          additional.contractor_id
        ) = p_workforce
        and daterange(
          additional.effective_from,
          coalesce(additional.effective_to, 'infinity'::date),
          '[]'
        ) && daterange(
          mapping_row.effective_from,
          coalesce(mapping_row.effective_to, 'infinity'::date),
          '[]'
        )
    )
  then
    raise exception 'The registered-location mapping cannot be removed while an additional-location mapping overlaps this period. Remove the additional-location period first.';
  end if;

  -- Ordinary UPDATE intentionally preserves the finalized-payroll and active
  -- bank-processing trigger boundaries.
  update public.field_executive_provider_mappings mapping
  set status = 'cancelled',
      updated_at = now()
  where mapping.company_id = p_company
    and mapping.id = mapping_row.id;

  select mapping.*
  into remaining_mapping
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and (
      (mapping.status = 'active' and mapping.effective_to is null)
      or (
        mapping.status = 'closed'
        and mapping.effective_to is not null
        and mapping.effective_to >= mapping.effective_from
      )
    )
    and mapping.effective_from <= today_in_kolkata
    and (
      mapping.effective_to is null
      or mapping.effective_to >= today_in_kolkata
    )
    and public.workforce_provider_mapping_person(
      mapping.company_id,
      mapping.workforce_id,
      mapping.field_executive_id,
      mapping.employee_id,
      mapping.contractor_id
    ) = p_workforce
  order by
    (mapping.station_id is not distinct from person.location_id) desc,
    mapping.effective_from desc,
    mapping.created_at desc,
    mapping.id desc
  limit 1;

  update public.workforce workforce
  set provider_employee_id = remaining_mapping.provider_member_id,
      provider_id_status = case
        when remaining_mapping.id is null then 'pending'
        else 'created'
      end,
      updated_at = now()
  where workforce.company_id = p_company
    and workforce.id = p_workforce;

  remaining_details := case
    when remaining_mapping.id is null then null
    else jsonb_build_object(
      'mapping_id', remaining_mapping.id,
      'provider_id', remaining_mapping.provider_id,
      'provider_member_id', remaining_mapping.provider_member_id,
      'station_id', remaining_mapping.station_id,
      'effective_from', remaining_mapping.effective_from,
      'effective_to', remaining_mapping.effective_to,
      'status', remaining_mapping.status,
      'payment_method_id', remaining_mapping.payment_method_id,
      'payment_values', coalesce(remaining_mapping.payment_values, '{}'::jsonb)
    )
  end;

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
    'provider_mapping_period_cleared',
    p_actor,
    coalesce(nullif(btrim(p_actor_name), ''), 'Workforce mapping reviewer'),
    jsonb_build_object(
      'mapping_id', mapping_row.id,
      'provider_id', mapping_row.provider_id,
      'provider_member_id', mapping_row.provider_member_id,
      'station_id', mapping_row.station_id,
      'original_status', mapping_row.status,
      'original_effective_from', mapping_row.effective_from,
      'original_effective_to', mapping_row.effective_to,
      'original_payment_method_id', mapping_row.payment_method_id,
      'original_payment_values', coalesce(mapping_row.payment_values, '{}'::jsonb),
      'original_production_threshold_config', mapping_row.production_threshold_config,
      'original_pay_type', mapping_row.pay_type,
      'disposition', 'cancelled',
      'remaining_mapping', remaining_details
    )
  );

  return jsonb_build_object(
    'mapping_id', mapping_row.id,
    'disposition', 'cancelled',
    'original_status', mapping_row.status,
    'effective_from', mapping_row.effective_from,
    'effective_to', mapping_row.effective_to,
    'payment_method_id', mapping_row.payment_method_id,
    'payment_values', coalesce(mapping_row.payment_values, '{}'::jsonb),
    'remaining_mapping', remaining_details
  );
end
$function$;

comment on function public.workforce_clear_mapping_period(
  uuid, uuid, uuid, uuid, timestamptz, uuid[], text
) is
  'Cancels one exact mapping-history period while preserving its definition; published, finalized or bank-processing periods and registered periods with overlapping additional-location mappings remain locked.';

revoke all on function public.workforce_clear_mapping_period(
  uuid, uuid, uuid, uuid, timestamptz, uuid[], text
) from public, anon, authenticated;
grant execute on function public.workforce_clear_mapping_period(
  uuid, uuid, uuid, uuid, timestamptz, uuid[], text
) to service_role;

notify pgrst, 'reload schema';
commit;
