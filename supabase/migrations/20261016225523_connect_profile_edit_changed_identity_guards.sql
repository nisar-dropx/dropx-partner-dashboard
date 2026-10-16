-- Active profiles can contain legacy identity gaps predating current
-- registration rules. Self-service edits must validate and reverify the fields
-- changed by this request without making an unrelated contact/address edit an
-- implicit full-profile migration.
do $migration$
declare
  function_definition text;
  old_dob_guard constant text := $guard$if final_dob is not null and final_dob::date > (current_date - interval '18 years')::date then$guard$;
  new_dob_guard constant text := $guard$if edit_request.payload ? 'date_of_birth'
     and final_dob is not null
     and final_dob::date > (current_date - interval '18 years')::date then$guard$;
  old_pan_aadhaar_guard constant text := $guard$if final_aadhaar is not null and final_pan is null then$guard$;
  new_pan_aadhaar_guard constant text := $guard$if (edit_request.payload ? 'pan_number' or edit_request.payload ? 'aadhaar_number')
     and final_aadhaar is not null
     and final_pan is null then$guard$;
  old_bank_guard constant text := $guard$if (final_bank is null) <> (final_ifsc is null) then$guard$;
  new_bank_guard constant text := $guard$if (edit_request.payload ? 'bank_account_no' or edit_request.payload ? 'ifsc')
     and (final_bank is null) <> (final_ifsc is null) then$guard$;
begin
  select pg_get_functiondef('public.connect_commit_profile_edit(uuid,uuid)'::regprocedure)
  into function_definition;

  if position(new_dob_guard in function_definition) > 0
     and position(new_pan_aadhaar_guard in function_definition) > 0
     and position(new_bank_guard in function_definition) > 0 then
    return;
  end if;

  if position(old_dob_guard in function_definition) = 0
     or position(old_pan_aadhaar_guard in function_definition) = 0
     or position(old_bank_guard in function_definition) = 0 then
    raise exception 'connect_commit_profile_edit identity guards do not match the expected prior definition';
  end if;

  function_definition := replace(function_definition, old_dob_guard, new_dob_guard);
  function_definition := replace(function_definition, old_pan_aadhaar_guard, new_pan_aadhaar_guard);
  function_definition := replace(function_definition, old_bank_guard, new_bank_guard);
  execute function_definition;
end
$migration$;
