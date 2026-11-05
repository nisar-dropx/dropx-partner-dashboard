-- Preserve the live transition's existing locks, permissions, audit and closure guards.
do $migration$
declare definition text; patched text;
begin
 definition := pg_get_functiondef('public.nl_redispute_transition(uuid,text,text,integer,text,jsonb,uuid,text)'::regprocedure);
 patched := replace(replace(definition, $old$'^\\d{4}-(0[1-9]|1[0-2])$'$old$, $new$'^[0-9]{4}-(0[1-9]|1[0-2])$'$new$), $old$'^\d{4}-(0[1-9]|1[0-2])$'$old$, $new$'^[0-9]{4}-(0[1-9]|1[0-2])$'$new$);
 if position('target !~ ''^[0-9]{4}-(0[1-9]|1[0-2])$''' in patched)=0 then
  raise exception 'Redispute payroll month validation anchor not found';
 end if;
 if position('-- Refresh every original allocation payroll' in patched)=0 then
  if position('return to_jsonb(w);' in patched)=0 then raise exception 'Redispute return anchor not found'; end if;
  patched := replace(patched, 'return to_jsonb(w);', $body$
 -- Refresh every original allocation payroll, including open prior-month salaries.
 perform public.nl_recovery_bump_payout_months(p_company, array(
  select distinct payroll_month from (
   select r.deduction_month payroll_month from public.nl_loss_recoveries r
    where r.company_id=p_company and r.month=p_month and r.case_key=p_case and not r.is_deleted
   union all
   select coalesce(nullif(a->>'salary_month',''),r.deduction_month) from public.nl_loss_recoveries r
    cross join lateral jsonb_array_elements(r.allocations) a
    where r.company_id=p_company and r.month=p_month and r.case_key=p_case and not r.is_deleted
   union all select before_state->>'recovery_month'
   union all select w.recovery_month
  ) months where payroll_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 ));
 return to_jsonb(w);$body$);
 end if;
 execute patched;
end $migration$;
