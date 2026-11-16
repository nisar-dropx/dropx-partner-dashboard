begin;

do $migration$
declare
  definition text := replace(pg_get_functiondef(
    'public.workforce_clear_unlocked_mapping_month(uuid,uuid,uuid,uuid,timestamptz,uuid[],text,date)'::regprocedure
  ), chr(13), '');
  old_guard constant text := $old$  if not exists (
    select 1 from public.workforce_payout_mapping_unlocks unlock$old$;
  new_guard constant text := $new$  if exists (
    select 1 from public.workforce_payout_publications publication
    where publication.company_id = p_company
      and publication.workforce_id = p_workforce
      and publication.publication_kind = 'worksheet'
      and publication.period_start <= removed_to
      and publication.period_end >= removed_from
  ) and not exists (
    select 1 from public.workforce_payout_mapping_unlocks unlock$new$;
begin
  if strpos(definition, new_guard) > 0 then return; end if;
  if strpos(definition, old_guard) = 0 then
    raise exception 'Unexpected mapping month removal guard.';
  end if;
  execute replace(definition, old_guard, new_guard);
end;
$migration$;

commit;
