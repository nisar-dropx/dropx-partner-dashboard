-- Clear one exact provider-mapping period without rewriting or deleting its
-- historical dates, payment method or rate details. The ordinary mapping
-- triggers remain authoritative for finalized, published, bank-processing and
-- registered-location protections.
begin;

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

  -- Match the central mapping guards' lock order: canonical Workforce first,
  -- then the exact mapping row that the reviewer selected.
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

  -- The history modal is a snapshot. Reject the request when this exact row
  -- was edited after that snapshot, even when its UUID and canonical shape are
  -- unchanged. This comparison happens while the row is locked so the later
  -- cancellation cannot race another edit.
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

  -- A null scope is the established service-layer representation of access to
  -- every station. A scoped reviewer must be allowed to manage both the exact
  -- mapping station and the Workforce profile's current registered station,
  -- matching the existing provider-mapping edit/clear boundary.
  if p_locations is not null
    and (
      person.location_id is null
      or not (person.location_id = any(p_locations))
      or
      mapping_row.station_id is null
      or not (mapping_row.station_id = any(p_locations))
    )
  then
    raise exception 'The mapping period is outside your station scope';
  end if;

  -- Deliberately use an ordinary UPDATE. All existing mapping triggers must
  -- see this transition and may reject it when financial or anchor history is
  -- locked. Only status and the audit timestamp change; the period and payment
  -- definition remain intact for history.
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
  'Cancels one exact canonical provider-mapping period while preserving its dates and payment history; ordinary mapping guards remain authoritative.';

revoke all on function public.workforce_clear_mapping_period(
  uuid, uuid, uuid, uuid, timestamptz, uuid[], text
) from public, anon, authenticated;
grant execute on function public.workforce_clear_mapping_period(
  uuid, uuid, uuid, uuid, timestamptz, uuid[], text
) to service_role;

notify pgrst, 'reload schema';
commit;
