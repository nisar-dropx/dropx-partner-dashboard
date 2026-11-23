begin;
-- All People hides Employee copies when an Independent Contractor owns the
-- same DropX ID. Use the same precedence: Workforce, Contractor, Employee.
do $migration$
declare definition text := pg_get_functiondef('public.import_manually_paid_advances(uuid,uuid,jsonb,text,uuid[],boolean)'::regprocedure);
  old_selection text := 'select id,''employee'',full_name,location_id,1 from public.employees';
  new_selection text := 'select id,''employee'',full_name,location_id,2 from public.employees';
begin
  if position(old_selection in definition)=0 and position(new_selection in definition)>0 then return; end if;
  if (length(definition)-length(replace(definition,old_selection,'')))/length(old_selection)<>2 then
    raise exception 'Unexpected manual advance person matcher definition';
  end if;
  execute replace(definition,old_selection,new_selection);
end $migration$;
notify pgrst,'reload schema';
commit;
