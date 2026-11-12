begin;

create or replace function public.workforce_clear_unlocked_mapping_month(
  p_company uuid,
  p_actor uuid,
  p_workforce uuid,
  p_mapping uuid,
  p_expected_updated_at timestamptz,
  p_locations uuid[],
  p_actor_name text,
  p_month date
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
  removed_from date;
  removed_to date;
  suffix public.field_executive_provider_mappings;
  disposition text := 'trimmed';
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

  removed_from := mapping_row.effective_from;
  removed_to := mapping_row.effective_to;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception 'Select a calendar month for this correction.';
  end if;
  removed_from := greatest(removed_from, p_month);
  removed_to := least(removed_to, (p_month + interval '1 month - 1 day')::date);
  if removed_from > removed_to then
    raise exception 'This mapping does not overlap the selected month.';
  end if;
  if not exists (
    select 1 from public.workforce_payout_mapping_unlocks unlock
    where unlock.company_id = p_company and unlock.workforce_id = p_workforce
      and unlock.period_start = p_month
      and unlock.period_end = (p_month + interval '1 month - 1 day')::date
      and unlock.status = 'open'
  ) then
    raise exception 'Unlock this associate and month in Workforce Payouts before removing its mapping.';
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
          removed_from,
          coalesce(removed_to, 'infinity'::date),
          '[]'
        )
    )
  then
    raise exception 'The registered-location mapping cannot be removed while an additional-location mapping overlaps this period. Remove the additional-location period first.';
  end if;

  -- Ordinary UPDATE intentionally preserves the finalized-payroll and active
  -- bank-processing trigger boundaries.
  if mapping_row.effective_from < removed_from then
    update public.field_executive_provider_mappings
    set effective_to = removed_from - 1, status = 'closed', updated_at = now()
    where id = mapping_row.id and company_id = p_company;
    if removed_to is not null and (mapping_row.effective_to is null or mapping_row.effective_to > removed_to) then
      suffix := mapping_row;
      suffix.id := gen_random_uuid();
      suffix.effective_from := removed_to + 1;
      suffix.updated_at := now();
      insert into public.field_executive_provider_mappings select (suffix).*;
    end if;
  elsif removed_to is not null and (mapping_row.effective_to is null or mapping_row.effective_to > removed_to) then
    update public.field_executive_provider_mappings
    set effective_from = removed_to + 1, updated_at = now()
    where id = mapping_row.id and company_id = p_company;
  else
    disposition := 'cancelled';
    update public.field_executive_provider_mappings
    set status = 'cancelled', updated_at = now()
    where id = mapping_row.id and company_id = p_company;
  end if;

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
      'disposition', disposition,
      'removed_from', removed_from,
      'removed_to', removed_to,
      'retained_suffix_mapping_id', suffix.id,
      'remaining_mapping', remaining_details
    )
  );

  return jsonb_build_object(
    'mapping_id', mapping_row.id,
    'disposition', disposition,
    'original_status', mapping_row.status,
    'effective_from', removed_from,
    'effective_to', removed_to,
    'payment_method_id', mapping_row.payment_method_id,
    'payment_values', coalesce(mapping_row.payment_values, '{}'::jsonb),
    'remaining_mapping', remaining_details
  );
end
$function$;

comment on function public.workforce_clear_unlocked_mapping_month(
  uuid, uuid, uuid, uuid, timestamptz, uuid[], text, date
) is
  'Removes coverage for an explicitly unlocked month and keeps the other dates and audit history.';

revoke all on function public.workforce_clear_unlocked_mapping_month(
  uuid, uuid, uuid, uuid, timestamptz, uuid[], text, date
) from public, anon, authenticated;
grant execute on function public.workforce_clear_unlocked_mapping_month(
  uuid, uuid, uuid, uuid, timestamptz, uuid[], text, date
) to service_role;

notify pgrst, 'reload schema';
commit;
