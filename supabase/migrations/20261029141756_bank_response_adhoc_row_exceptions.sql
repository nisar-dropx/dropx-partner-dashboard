-- Known ad hoc financial conflicts belong in the existing row Exceptions list.
-- Keep unexpected database failures fatal so they cannot be hidden as bad rows.
begin;
do $patch$
declare
  signature regprocedure := 'public.finalize_central_bank_response_partially(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure;
  definition text := replace(pg_get_functiondef(signature), chr(13), '');
  old_branch text := E'      if v_error_state = ''P0001'' then\n';
  new_branch text := E'      -- Known ad hoc conflicts are isolated without bypassing their guards.\n      if v_error_state = ''P0001'' then\n        if v_error_message = ''This associate already has a paid ad hoc request for this location and work date'' then\n          v_safe_error_message := ''This associate already has a paid ad hoc request for this location and work date. Review the existing payment before reconciling this row.'';\n        elsif v_error_message = ''This work date is already in a finalized Workforce payout. Finance must review it before paying ad hoc'' then\n          v_safe_error_message := ''This work date is already in a finalized Workforce payout. Finance must review it before reconciling this row.'';\n        end if;\n';
begin
  if position(new_branch in definition) > 0 then return; end if;
  if position(old_branch in definition) = 0
    or (length(definition) - length(replace(definition, old_branch, ''))) / length(old_branch) <> 1
  then
    raise exception 'Unexpected bank response exception implementation; inspect before applying.';
  end if;
  execute replace(definition, old_branch, new_branch);
end
$patch$;
notify pgrst, 'reload schema';
commit;
