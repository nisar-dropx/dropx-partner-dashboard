-- Profiles may share a mobile number. Self-service profile edits must therefore
-- reject only a mobile/emergency-contact collision within the same profile.
-- Patch the installed RPCs in place so environments that already ran the base
-- profile-edit migration receive the updated behavior.

begin;

do $migration$
declare
  function_definition text;
  block_start integer;
  block_end integer;
  old_block_start text := $marker$  if p_mobile_changed then
    target_unavailable := exists ($marker$;
  old_block_end text := $marker$  update public.connect_profile_edit_verifications$marker$;
  applied_marker constant text := 'Cross-profile mobile reuse is allowed; only the per-profile contact guard applies.';
begin
  old_block_start := replace(old_block_start, E'\r\n', E'\n');
  old_block_end := replace(old_block_end, E'\r\n', E'\n');
  select pg_get_functiondef(
    'public.connect_reserve_profile_edit_request(uuid,uuid,uuid,text,uuid,timestamptz,text,text,text,text,text,text,text,text,text,boolean,jsonb,jsonb,text,timestamptz,text,text,integer,integer,integer)'::regprocedure
  ) into function_definition;
  function_definition := replace(function_definition, E'\r\n', E'\n');

  if position(applied_marker in function_definition) > 0 then
    return;
  end if;

  block_start := position(old_block_start in function_definition);
  block_end := position(old_block_end in function_definition);
  if block_start = 0 or block_end = 0 or block_end <= block_start then
    raise exception 'connect_reserve_profile_edit_request mobile guard does not match the expected prior definition';
  end if;

  function_definition := overlay(
    function_definition placing
      '  -- ' || applied_marker || E'\n\n'
    from block_start for block_end - block_start
  );
  function_definition := replace(
    function_definition,
    E'  target_unavailable boolean := false;\n',
    ''
  );
  execute function_definition;
end
$migration$;

do $migration$
declare
  function_definition text;
  old_collision_open text := $guard$    if exists (
      select 1 from public.profiles profile$guard$;
  new_collision_open text := $guard$    select (exists (
      select 1 from public.profiles profile$guard$;
  old_collision_close text := $guard$    ) then
      raise exception 'This mobile number cannot be used for self-service profile editing. Contact an administrator.';
    end if;$guard$;
  new_collision_close text := $guard$    )) into target_phone_already_in_use;$guard$;
  final_vehicle_assignment text := $guard$  final_vehicle := nullif(upper(btrim(case when edit_request.payload ? 'vehicle_reg_no' then edit_request.payload->>'vehicle_reg_no' else profile_before->>'vehicle_reg_no' end)), '');$guard$;
  final_contact_guard text := $guard$  final_emergency_contact := nullif(regexp_replace(
    btrim(case
      when edit_request.payload ? 'emergency_contact_number'
        then edit_request.payload->>'emergency_contact_number'
      else profile_before->>'emergency_contact_number'
    end),
    '[^0-9]', '', 'g'
  ), '');
  if final_emergency_contact is not null
     and final_emergency_contact in (
       regexp_replace(coalesce(edit_request.new_mobile_value, ''), '[^0-9]', '', 'g'),
       regexp_replace(coalesce(edit_request.new_mobile_number, ''), '[^0-9]', '', 'g')
     ) then
    raise exception 'Mobile number and Emergency contact number cannot be same';
  end if;$guard$;
  old_collision_comment text := $comment$    -- People records may share a contact number through administrator-managed
    -- lifecycle flows, but Connect authentication is still phone-principal:
    -- sessions, PINs and device access resolve every account on the number. A
    -- self-service move to an occupied number would therefore grant the other
    -- holder access to this profile. Serialize the final check with other edits
    -- and require an administrator for that exceptional move.
    -- Legacy Connect authentication keys credentials by the normalized value
    -- supplied by the login route. India-style 10-digit subscribers normalize
    -- to country-prefixed digits, while shorter supported international
    -- subscribers (for example an 8-digit Singapore number) remain local.
    -- Lock both representations for both sides of a move, in deterministic
    -- hash order, so neither form can race the collision check, profile update,
    -- or credential retirement.$comment$;
  new_collision_comment text := $comment$    -- Mobile numbers may be shared by profiles. Lock both local and canonical
    -- representations in deterministic order so a concurrent move cannot race
    -- the profile update or credential-preservation decision.$comment$;
  old_cleanup_comment text := $comment$    -- The locked collision check above proves the target has no active account.
    -- Clear credentials left behind by a recycled number before this profile
    -- becomes reachable there, then revoke the editing session so the user must
    -- authenticate again on the newly verified number.$comment$;
  new_cleanup_comment text := $comment$    -- Clear credentials left behind by an unused recycled number. If another
    -- active profile already uses the target, preserve that phone principal's
    -- sessions, PIN and pending login/reset OTPs.$comment$;
  target_cleanup_start text := $guard$    update public.connect_login_sessions
    set revoked_at = now()
    where revoked_at is null
      and country_code = edit_request.new_mobile_country_code$guard$;
  wrapped_target_cleanup_start text := $guard$    if not target_phone_already_in_use then
      update public.connect_login_sessions
      set revoked_at = now()
      where revoked_at is null
      and country_code = edit_request.new_mobile_country_code$guard$;
  target_cleanup_end text := $guard$      and purpose in ('connect_login', 'connect_pin_reset')
      and status = 'pending';

    -- A Connect session is a phone principal$guard$;
  wrapped_target_cleanup_end text := $guard$      and purpose in ('connect_login', 'connect_pin_reset')
      and status = 'pending';
    end if;

    -- A Connect session is a phone principal$guard$;
  applied_marker constant text := 'target_phone_already_in_use boolean := false;';
begin
  old_collision_open := replace(old_collision_open, E'\r\n', E'\n');
  new_collision_open := replace(new_collision_open, E'\r\n', E'\n');
  old_collision_close := replace(old_collision_close, E'\r\n', E'\n');
  new_collision_close := replace(new_collision_close, E'\r\n', E'\n');
  final_vehicle_assignment := replace(final_vehicle_assignment, E'\r\n', E'\n');
  final_contact_guard := replace(final_contact_guard, E'\r\n', E'\n');
  old_collision_comment := replace(old_collision_comment, E'\r\n', E'\n');
  new_collision_comment := replace(new_collision_comment, E'\r\n', E'\n');
  old_cleanup_comment := replace(old_cleanup_comment, E'\r\n', E'\n');
  new_cleanup_comment := replace(new_cleanup_comment, E'\r\n', E'\n');
  target_cleanup_start := replace(target_cleanup_start, E'\r\n', E'\n');
  wrapped_target_cleanup_start := replace(wrapped_target_cleanup_start, E'\r\n', E'\n');
  target_cleanup_end := replace(target_cleanup_end, E'\r\n', E'\n');
  wrapped_target_cleanup_end := replace(wrapped_target_cleanup_end, E'\r\n', E'\n');
  select pg_get_functiondef('public.connect_commit_profile_edit(uuid,uuid)'::regprocedure)
  into function_definition;
  function_definition := replace(function_definition, E'\r\n', E'\n');

  if position(applied_marker in function_definition) > 0
     and position(final_contact_guard in function_definition) > 0
     and position(new_collision_open in function_definition) > 0
     and position(wrapped_target_cleanup_start in function_definition) > 0
     and position(wrapped_target_cleanup_end in function_definition) > 0 then
    return;
  end if;

  if position(old_collision_open in function_definition) = 0
     or position(old_collision_close in function_definition) = 0
     or position(final_vehicle_assignment in function_definition) = 0
     or position(target_cleanup_start in function_definition) = 0
     or position(target_cleanup_end in function_definition) = 0 then
    raise exception 'connect_commit_profile_edit mobile guard does not match the expected prior definition';
  end if;

  function_definition := replace(
    function_definition,
    E'  final_vehicle text;\n',
    E'  final_vehicle text;\n  final_emergency_contact text;\n'
  );
  function_definition := replace(
    function_definition,
    E'  source_phone_still_in_use boolean := false;\n',
    E'  source_phone_still_in_use boolean := false;\n  target_phone_already_in_use boolean := false;\n'
  );
  function_definition := replace(function_definition, old_collision_comment, new_collision_comment);
  function_definition := replace(function_definition, old_collision_open, new_collision_open);
  function_definition := replace(function_definition, old_collision_close, new_collision_close);
  function_definition := replace(
    function_definition,
    final_vehicle_assignment,
    final_vehicle_assignment || E'\n' || final_contact_guard
  );
  function_definition := replace(function_definition, old_cleanup_comment, new_cleanup_comment);
  function_definition := replace(function_definition, target_cleanup_start, wrapped_target_cleanup_start);
  function_definition := replace(function_definition, target_cleanup_end, wrapped_target_cleanup_end);
  execute function_definition;
end
$migration$;

commit;
