-- ID mapping writes are authorized by the page's Add/Edit permission. Do not
-- additionally require the Workforce registration/lifecycle approval flow.
-- All mapping integrity, location-scope, actor and audit checks remain in the
-- existing save functions.
create or replace function public.workforce_save_joining_mapping(
  p_company uuid,
  p_actor uuid,
  p_workforce uuid,
  p_mapping uuid,
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
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select *
  into person
  from public.workforce
  where company_id = p_company
    and id = p_workforce
    and deleted_at is null
    and migration_state <> 'reclassified'
  for update;

  if p_actor is null or person.id is null then
    raise exception 'An authenticated reviewer and valid Workforce associate are required';
  end if;

  -- Registration approval is intentionally not required for ID mapping.
  -- Keep the separate safety rule that prevents new mappings for people whose
  -- employment has already ended or whose lifecycle is terminal.
  if person.last_working_date < today
    or coalesce(person.lifecycle_status, '') in (
      'offboarded',
      'closed',
      'exited',
      'terminated',
      'resigned',
      'settled',
      'inactive'
    )
  then
    raise exception 'This Workforce associate is inactive or no longer eligible for ID mapping';
  end if;

  perform public.workforce_save_mapping(
    p_company,
    p_actor,
    p_workforce,
    p_mapping,
    p_dropx,
    p_payload,
    p_locations
  );

  if nullif(btrim(p_payload ->> 'provider_member_id'), '') is not null
    and nullif(p_payload ->> 'payment_method_id', '') is not null
    and coalesce(p_payload ->> 'status', '') <> 'cancelled'
    and (p_payload ->> 'effective_from')::date <= today
    and (
      nullif(p_payload ->> 'effective_to', '') is null
      or (p_payload ->> 'effective_to')::date >= today
    )
  then
    update public.workforce
    set onboarding_status = 'active',
        is_active = true,
        lifecycle_status = 'active',
        provider_id_status = 'created',
        provider_employee_id = p_payload ->> 'provider_member_id',
        updated_at = now()
    where id = p_workforce
      and company_id = p_company
      and onboarding_status = 'approved';
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
    'provider_mapping_saved',
    p_actor,
    coalesce(nullif(btrim(p_actor_name), ''), 'Workforce mapping reviewer'),
    jsonb_build_object(
      'effective_from', p_payload ->> 'effective_from',
      'effective_to', p_payload ->> 'effective_to',
      'provider_id', p_payload ->> 'provider_id',
      'provider_member_id', p_payload ->> 'provider_member_id',
      'station_id', p_payload ->> 'station_id'
    )
  );
end
$function$;

-- Match the deployed RPC boundary: callers use the server-side service role
-- after the application has enforced page Add/Edit access.
revoke all on function public.workforce_save_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) from public, anon, authenticated;

grant execute on function public.workforce_save_joining_mapping(
  uuid, uuid, uuid, uuid, text, jsonb, uuid[], text
) to service_role;
