-- Match People's existing station approval/bank-file policy: blocked workers
-- stay visible in the audited snapshot, but never receive bank instructions.
-- Do not change the snapshot/hash: existing Finance approvals remain valid,
-- and clearing a worker's block still requires resubmission and Finance review.
do $migration$
declare
  definition text;
  old_guard text := 'if exists(select 1 from jsonb_array_elements(v_payload) p where p->>''status''=''blocked'') then raise exception ''Resolve blocked payroll rows before sending this station.''; end if;';
  new_guard text := 'if not exists(select 1 from jsonb_array_elements(v_payload) p where p->>''status''<>''blocked'') then raise exception ''All people in this station are blocked. Resolve their payroll issues before sending to Finance.''; end if;';
  old_issue text := 'if v_person.calculation_status=''blocked'' then raise exception ''Payroll contains blocked people. Return it to People for correction.''; end if;';
  new_issue text := 'if v_person.calculation_status=''blocked'' then continue; end if;';
begin
  definition := pg_get_functiondef('public.people_finance_submit(uuid,uuid,uuid,uuid,text)'::regprocedure);
  if position(old_guard in definition) = 0 then
    raise exception 'Unexpected people_finance_submit definition; review before applying.';
  end if;
  execute replace(definition, old_guard, new_guard);

  definition := pg_get_functiondef('public.people_finance_issue(uuid,uuid,uuid,uuid,uuid,date)'::regprocedure);
  if position(old_issue in definition) = 0 then
    raise exception 'Unexpected people_finance_issue definition; review before applying.';
  end if;
  execute replace(definition, old_issue, new_issue);
end
$migration$;
