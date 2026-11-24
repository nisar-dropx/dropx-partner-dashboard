begin;
set local lock_timeout='5s';

-- Publication/review snapshots already store both inclusive boundary dates.
-- Permit exact selected periods without changing calculation, bank-payment,
-- advance-recovery, authorization, snapshot freshness or notification rules.
do $migration$
declare target record; definition text; old_guard text;
  new_guard text := $guard$if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Choose a valid payout publication date range.';
  end if;$guard$;
begin
  for target in select oid,proname from pg_catalog.pg_proc
    where pronamespace='public'::regnamespace and proname in (
      'workforce_publish_payout_notifications','helper_publish_payout_notifications','helper_payout_dependency_state',
      'workforce_unlock_payout_mappings','workforce_relock_payout_mappings',
      'workforce_apply_payout_publication_input_revisions_without_hard',
      'workforce_claim_selected_payout_publication_refresh_jobs',
      'workforce_claim_selected_payout_publication_row_refresh_jobs',
      'workforce_ensure_payout_publication_refresh_jobs'
    )
  loop
    definition:=pg_catalog.pg_get_functiondef(target.oid);
    if target.proname='helper_payout_dependency_state' then
      new_guard:=$guard$if p_company_id is null or p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Choose a company and valid payout publication date range.';
  end if;$guard$;
      old_guard:=substring(definition from '(?is)if p_company_id is null.*?end if;');
    else
      new_guard:=$guard$if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Choose a valid payout publication date range.';
  end if;$guard$;
      old_guard:=substring(definition from '(?is)if p_period_start is null.*?end if;');
    end if;
    if position(new_guard in definition)>0 then continue; end if;
    if old_guard is null or old_guard !~* '(calendar month|complete payout month)' then
      raise exception 'Unexpected period guard in %',target.proname;
    end if;
    execute replace(definition,old_guard,new_guard);
  end loop;
end $migration$;

do $migration$
declare target record;
begin
  for target in select c.conname,c.conrelid::regclass as table_name
    from pg_catalog.pg_constraint c where c.contype='c' and c.connamespace='public'::regnamespace
      and c.conname in ('helper_payout_publications_period_check',
        'workforce_payout_mapping_unlocks_period_check','workforce_payout_mapping_relocks_period_check')
  loop
    execute format('alter table %s drop constraint %I',target.table_name,target.conname);
    execute format('alter table %s add constraint %I check (period_start is not null and period_end is not null and period_end >= period_start)',target.table_name,target.conname);
  end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
