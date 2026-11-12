begin;

-- Imported historical periods can be marked active with a valid end date.
-- Keep the ordinary whole-period removal rules and all payout locks intact.
do $migration$
declare
  definition text := replace(pg_get_functiondef(
    'public.workforce_clear_unlocked_mapping_month(uuid,uuid,uuid,uuid,timestamptz,uuid[],text,date)'::regprocedure
  ), chr(13), '');
  old_guard constant text := $old$      mapping_row.status = 'closed'
      and mapping_row.effective_to is not null$old$;
  new_guard constant text := $new$      mapping_row.status in ('active', 'closed')
      and mapping_row.effective_to is not null$new$;
begin
  if strpos(definition, new_guard) > 0 then return; end if;
  if strpos(definition, old_guard) = 0 then
    raise exception 'Unexpected unlocked mapping removal guard.';
  end if;
  definition := replace(definition, old_guard, new_guard);
  definition := replace(definition, 'suffix.effective_from := removed_to + 1;',
    'suffix.effective_from := removed_to + 1;
      suffix.status := case when suffix.effective_to is null then ''active'' else ''closed'' end;');
  definition := replace(definition, 'set effective_from = removed_to + 1, updated_at = now()',
    'set effective_from = removed_to + 1,
        status = case when mapping_row.effective_to is null then ''active'' else ''closed'' end,
        updated_at = now()');
  execute definition;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
