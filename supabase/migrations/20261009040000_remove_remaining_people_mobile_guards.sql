-- Mobile numbers are contact details, not People identity keys.
--
-- The current dashboard writes People registers directly, but older service-role
-- RPCs can still exist in long-lived environments. Patch those functions only
-- when present so a shared mobile is accepted through every People-profile
-- creation path. Authentication, recruitment, referral, email, DropX ID,
-- biometric ID, and phone-format policies are intentionally unchanged.
do $migration$
declare
  function_oid oid;
  definition text;
  updated_definition text;
  marker text;
  start_marker text;
  end_marker text;
  start_at integer;
  end_at integer;
begin
  function_oid := to_regprocedure('public.enforce_people_workforce_confirmation_only()')::oid;
  if function_oid is not null then
    execute $replace_function$
      create or replace function public.enforce_people_workforce_confirmation_only()
      returns trigger
      language plpgsql
      security definer
      set search_path = ''
      as $function$
      begin
        return new;
      end
      $function$
    $replace_function$;
  end if;

  function_oid := to_regprocedure(
    'public.hr_bulk_create_people_profiles(uuid,text,jsonb,uuid,text)'
  )::oid;
  if function_oid is not null then
    definition := pg_get_functiondef(function_oid);
    marker := '    -- Shared-mobile policy: repeated mobiles are allowed within a People import.';
    updated_definition := replace(
      definition,
      '    if (mobile_country_value || mobile_value) = any(seen_mobiles) then raise exception ''Mobile number +% appears more than once'', mobile_country_value || mobile_value; end if;',
      marker
    );
    if updated_definition = definition and strpos(definition, marker) = 0 then
      raise exception 'Could not locate the legacy bulk mobile-duplicate guard';
    end if;
    if updated_definition <> definition then
      execute updated_definition;
    end if;
  end if;

  function_oid := to_regprocedure(
    'public.hr_create_people_with_workforce_confirmation(uuid,uuid,text,jsonb,text)'
  )::oid;
  if function_oid is not null then
    definition := pg_get_functiondef(function_oid);
    marker := '  -- Shared-mobile policy: People creation does not require mobile-match confirmation.';
    start_marker := '  if jsonb_array_length(matches) = 0 or exists (';
    end_marker := '  -- The normal identity guard consumes this context once, for this exact row.';
    start_at := strpos(definition, start_marker);
    end_at := strpos(definition, end_marker);
    if start_at > 0 and end_at > start_at then
      definition := left(definition, start_at - 1)
        || marker || chr(10)
        || substr(definition, end_at);
      execute definition;
    elsif strpos(definition, marker) = 0 then
      raise exception 'Could not locate the legacy reviewed-mobile identity block';
    end if;
  end if;

  function_oid := to_regprocedure(
    'public.hr_transfer_workforce_to_people(uuid,uuid,uuid,text,text,text,uuid,uuid,date,uuid)'
  )::oid;
  if function_oid is not null then
    definition := pg_get_functiondef(function_oid);
    marker := '  -- Shared-mobile policy: an existing People mobile does not block transfer.';
    start_marker := '  if v_people_match is not null then';
    end_marker := '  perform set_config(''dropx.people_mobile_override'', jsonb_build_object(';
    start_at := strpos(definition, start_marker);
    end_at := strpos(definition, end_marker);
    if start_at > 0 and end_at > start_at then
      definition := left(definition, start_at - 1)
        || marker || chr(10) || chr(10)
        || substr(definition, end_at);
      execute definition;
    elsif strpos(definition, marker) = 0 then
      raise exception 'Could not locate the legacy Workforce transfer mobile guard';
    end if;
  end if;

  function_oid := to_regprocedure(
    'public.workforce_create_amazon_pilot(uuid,uuid,jsonb,uuid[])'
  )::oid;
  if function_oid is not null then
    definition := pg_get_functiondef(function_oid);
    marker := ' -- Shared-mobile policy: identity matches are retained as audit context, not blockers.';
    start_marker := ' if jsonb_array_length(exact_matches)>0 then';
    end_marker := ' if exists(select 1 from public.workforce w where w.company_id=p_company and w.deleted_at is null and lower(btrim(w.email))=v_email) then';
    start_at := strpos(definition, start_marker);
    end_at := strpos(definition, end_marker);
    if start_at > 0 and end_at > start_at then
      definition := left(definition, start_at - 1)
        || marker || chr(10)
        || substr(definition, end_at);
      execute definition;
    elsif strpos(definition, marker) = 0 then
      raise exception 'Could not locate the legacy Amazon pilot mobile guard';
    end if;
  end if;
end
$migration$;

