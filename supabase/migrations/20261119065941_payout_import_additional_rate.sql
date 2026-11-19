begin;
do $migration$
declare
  definition text := replace(pg_get_functiondef('public.workforce_apply_payout_import_without_deductions(uuid,date,date,text,text,jsonb,uuid,uuid[])'::regprocedure),chr(13),'');
begin
  if strpos(definition, 'v_from, v_to, v_numeric_value, null, 0,') = 0 then
    raise exception 'Unexpected additional payment import definition';
  end if;
  definition := replace(definition, 'v_from, v_to, v_numeric_value, null, 0,',
    'v_from, v_to, v_numeric_value, nullif(v_row ->> ''rate_value'', '''')::numeric, 0,');
  definition := replace(definition, 'rate_value = null,', 'rate_value = excluded.rate_value,');
  definition := replace(definition, 'and v_additional_field.default_rate_value is null',
    'and v_additional_field.default_rate_value is null and nullif(v_row ->> ''rate_value'', '''') is null');
  execute definition;
end;
$migration$;
commit;
