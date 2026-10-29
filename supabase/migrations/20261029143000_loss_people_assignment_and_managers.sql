begin;
-- Names follow the station's active hierarchy through AOM; People pay stays private.
update public.nl_loss_sources set recovery_policy = recovery_policy || jsonb_build_object(
  'directory_ceiling_designations', jsonb_build_array('AOM'),
  'directory_excluded_designations', (
    select coalesce(jsonb_agg(code order by code), '[]'::jsonb)
    from (select distinct upper(code) code from jsonb_array_elements_text(
      coalesce(recovery_policy->'directory_excluded_designations','[]'::jsonb)) code
      where upper(code) not in ('CM','CLM','AOM')) x
  ),
  'eligible_designations', case when jsonb_array_length(coalesce(recovery_policy->'eligible_designations','[]'::jsonb))=0
    then '[]'::jsonb else (select jsonb_agg(name order by name) from (
      select distinct name from (
        select jsonb_array_elements_text(recovery_policy->'eligible_designations') name
        union all select unnest(array['Cluster Manager','Area Operations Manager','Area Operation Manager'])
      ) names) unique_names) end
), updated_at=now()
where recovery_policy->'directory_ceiling_designations' is distinct from '["AOM"]'::jsonb
  or recovery_policy->'directory_excluded_designations' ?| array['CM','CLM','AOM'];

-- A People assignment must not depend on a payroll already being calculated.
-- Employment, station scope, full allocation, schedule, locks and approval checks
-- remain in the writer. The payroll engine alone limits the actual debit to pay.
do $$ declare f record; definition text; patched boolean:=false; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery' loop
  definition:=pg_get_functiondef(f.oid);
  if position('-- People pay checked in payroll' in definition)>0 then patched:=true; continue; end if;
  if position('-- Always verify available pay' in definition)=0 then continue; end if;
  definition:=replace(definition,
    'if true then -- Always verify available pay',
    'if a->>''employee_ref'' like ''workforce:%'' then -- People pay checked in payroll');
  definition:=replace(definition,
    'if pay.gross is not null and round(monthly::numeric/100,2)>pay.gross then',
    'if a->>''employee_ref'' like ''workforce:%'' and pay.gross is not null and round(monthly::numeric/100,2)>pay.gross then');
  if position('-- People pay checked in payroll' in definition)=0 then raise exception 'People recovery writer patch failed'; end if;
  execute definition; patched:=true;
 end loop;
 if not patched then raise exception 'Available-pay recovery writer is required'; end if;
end $$;
commit;
