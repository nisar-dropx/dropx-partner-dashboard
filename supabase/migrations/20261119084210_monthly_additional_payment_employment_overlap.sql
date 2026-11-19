begin;
do $migration$
declare
  definition text := replace(pg_get_functiondef('public.workforce_apply_payout_import_without_deductions(uuid,date,date,text,text,jsonb,uuid,uuid[])'::regprocedure),chr(13),'');
  old_join text := 'if v_worker.date_of_join is not null and v_from < v_worker.date_of_join then';
  old_exit text := 'if v_worker.last_working_date is not null and v_to > v_worker.last_working_date then';
begin
  if strpos(definition, old_join) = 0 or strpos(definition, old_exit) = 0 then
    raise exception 'Unexpected payout employment date guards';
  end if;
  definition := replace(definition, old_join,
    'if v_worker.date_of_join is not null and v_from < v_worker.date_of_join
      and not (v_input_type = ''ADDITIONAL_PAYMENT'' and v_to >= v_worker.date_of_join) then');
  definition := replace(definition, old_exit,
    'if v_worker.last_working_date is not null and v_to > v_worker.last_working_date
      and not (v_input_type = ''ADDITIONAL_PAYMENT'' and v_from <= v_worker.last_working_date) then');
  execute definition;
end;
$migration$;
commit;
