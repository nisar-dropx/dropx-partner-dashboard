-- Workforce mobile numbers are contact details, not unique person identifiers.
-- Keep the identity review flow for a different designation, but do not reject
-- another Workforce row solely because the same mobile/designation already exists.
create or replace function public.enforce_onboarding_mobile_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  new_data jsonb := to_jsonb(new);
  old_data jsonb;
  company_value uuid;
  profile_id_value uuid;
  designation_id_value uuid;
  designation_name_value text;
  normalized_mobile_value text;
  evaluation jsonb;
  exact_matches jsonb;
  other_matches jsonb;
  override_context jsonb;
  reviewed_matches jsonb;
  existing_name text;
  existing_designation text;
begin
  company_value := nullif(new_data ->> 'company_id', '')::uuid;
  profile_id_value := nullif(new_data ->> 'id', '')::uuid;
  designation_id_value := nullif(new_data ->> 'designation_id', '')::uuid;
  designation_name_value := nullif(btrim(new_data ->> 'designation'), '');
  normalized_mobile_value := public.normalize_onboarding_mobile(new_data ->> 'mobile');

  if company_value is null or normalized_mobile_value = '' then return new; end if;

  if tg_op = 'UPDATE' then
    old_data := to_jsonb(old);
    if public.normalize_onboarding_mobile(old_data ->> 'mobile') = normalized_mobile_value
       and coalesce(old_data ->> 'designation_id', '') = coalesce(new_data ->> 'designation_id', '')
       and lower(coalesce(old_data ->> 'designation', '')) = lower(coalesce(new_data ->> 'designation', '')) then
      if tg_table_name = 'workforce'
         and coalesce((new_data ->> 'identity_exception_required')::boolean, false)
         and lower(coalesce(new_data ->> 'onboarding_status', '')) = 'active'
         and nullif(new_data ->> 'identity_exception_approved_at', '') is null then
        raise exception using
          errcode = '23514',
          message = 'Review and explicitly approve the existing-person exception before activating this Workforce engagement.';
      end if;
      return new;
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(company_value::text || ':' || normalized_mobile_value, 0)
  );

  evaluation := public.evaluate_onboarding_identity(
    company_value,
    normalized_mobile_value,
    designation_id_value,
    designation_name_value,
    tg_table_name,
    profile_id_value
  );
  exact_matches := coalesce(evaluation -> 'exact_matches', '[]'::jsonb);
  other_matches := coalesce(evaluation -> 'other_matches', '[]'::jsonb);

  if tg_op = 'INSERT' and tg_table_name in ('employees', 'contractors')
     and nullif(current_setting('dropx.people_mobile_override', true), '') is not null then
    override_context := current_setting('dropx.people_mobile_override', true)::jsonb;
    -- Consume a context once. It cannot authorize another row or another table.
    perform set_config('dropx.people_mobile_override', '', true);
    select coalesce(jsonb_agg(item order by item ->> 'source_type', item ->> 'source_id'), '[]'::jsonb)
    into reviewed_matches
    from jsonb_array_elements(public.onboarding_identity_conflicts(
      company_value,
      normalized_mobile_value,
      tg_table_name,
      profile_id_value
    )) item;
    if override_context ->> 'company_id' is distinct from company_value::text
       or override_context ->> 'source_id' is distinct from profile_id_value::text
       or override_context ->> 'source_table' is distinct from tg_table_name
       or override_context ->> 'mobile' is distinct from normalized_mobile_value
       or override_context ->> 'actor_id' is distinct from new_data ->> 'created_by'
       or not exists (
         select 1
         from public.profiles
         where id = (override_context ->> 'actor_id')::uuid
           and company_id = company_value
           and is_active
       )
       or override_context ->> 'review_key' is distinct from md5(reviewed_matches::text) then
      raise exception using
        errcode = '23514',
        message = 'Mobile matches changed or were not reviewed. Validate the file and acknowledge the current matches again.';
    end if;
    perform set_config('dropx.people_mobile_override_audit', jsonb_build_object(
      'acknowledged_at', now(),
      'actor_id', override_context ->> 'actor_id',
      'normalized_mobile', normalized_mobile_value,
      'existing_profiles', reviewed_matches
    )::text, true);
    return new;
  end if;

  if jsonb_array_length(exact_matches) > 0 and tg_table_name <> 'workforce' then
    existing_name := coalesce(exact_matches -> 0 ->> 'display_name', 'an existing person');
    existing_designation := coalesce(exact_matches -> 0 ->> 'designation_name', exact_matches -> 0 ->> 'designation_code', 'this designation');
    raise exception using
      errcode = '23505',
      message = format(
        'Mobile number is already registered to %s as %s. Continue the existing profile; duplicate registration for the same designation is not allowed.',
        existing_name,
        existing_designation
      );
  end if;

  if jsonb_array_length(other_matches) = 0 then
    if tg_table_name = 'workforce' then
      new.identity_exception_required := false;
      new.identity_exception_context := '{}'::jsonb;
      new.identity_exception_approved_at := null;
      new.identity_exception_approved_by := null;
    end if;
    return new;
  end if;

  existing_name := coalesce(other_matches -> 0 ->> 'display_name', 'an existing person');
  existing_designation := coalesce(other_matches -> 0 ->> 'designation_name', other_matches -> 0 ->> 'designation_code', 'another designation');

  if tg_table_name <> 'workforce' then
    raise exception using
      errcode = '23505',
      message = format(
        'Mobile number already belongs to %s (%s). A second profile is not allowed here; only a different Workforce engagement may proceed through lifecycle approval.',
        existing_name,
        existing_designation
      );
  end if;

  if coalesce((new_data ->> 'approval_required')::boolean, false) is not true
     or lower(coalesce(new_data ->> 'onboarding_status', '')) = 'active'
     or coalesce((new_data ->> 'is_active')::boolean, false) is true then
    raise exception using
      errcode = '23514',
      message = 'An existing person can receive a different Workforce designation only through the pending lifecycle approval flow.';
  end if;

  new.identity_exception_required := true;
  new.identity_exception_context := jsonb_build_object(
    'reason', 'existing_person_different_designation',
    'normalized_mobile', normalized_mobile_value,
    'existing_profiles', other_matches,
    'requested_designation_id', designation_id_value,
    'requested_designation', designation_name_value,
    'detected_at', now()
  );
  return new;
end
$function$;

comment on function public.enforce_onboarding_mobile_identity() is
  'Prevents duplicate mobile identities outside Workforce. Workforce may reuse mobile numbers; different-designation matches retain lifecycle review metadata.';
