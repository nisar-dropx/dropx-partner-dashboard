begin;
set local lock_timeout='5s';

-- Keep service-only APIs, company payment mutexes, exact snapshot freshness,
-- holds, dispute windows and finalization matching unchanged.
do $migration$
declare target record; definition text; old_guard text;
  new_guard text := $guard$if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Choose a valid payout bank-payment date range.';
  end if;$guard$;
begin
  for target in select oid,proname from pg_proc where pronamespace='public'::regnamespace
    and proname in ('workforce_set_payout_payment_holds','workforce_set_payout_source_payment_holds',
      'workforce_set_payout_combined_payment_holds','workforce_cancel_payout_payment_items',
      'workforce_get_payout_payment_redownload','workforce_create_payout_payment_batch',
      'workforce_set_payout_payment_hold','workforce_payout_payment_candidates',
      'workforce_payout_payment_row_candidates','workforce_create_payout_payment_row_batch',
      'helper_payout_payment_row_candidates','helper_cancel_payout_payment_items',
      'helper_create_payout_payment_row_batch','helper_set_payout_payment_hold',
      'helper_get_payout_payment_redownload')
  loop
    definition:=pg_get_functiondef(target.oid);
    if position(new_guard in definition)>0 then continue; end if;
    old_guard:=substring(definition from '(?is)if p_period_start is null.*?end if;');
    if old_guard is null or old_guard !~* '(calendar month|complete payout month)' then
      raise exception 'Unexpected bank period guard in %',target.proname;
    end if;
    execute replace(definition,old_guard,new_guard);
  end loop;
end $migration$;

do $migration$
declare target record;
begin
  for target in select conname,conrelid::regclass as table_name from pg_constraint
    where connamespace='public'::regnamespace and contype='c'
      and conrelid::regclass::text ~ '^(workforce|helper)_payout_'
      and pg_get_constraintdef(oid) ~* '(extract\(day from period_start\)|date_trunc)'
      and pg_get_constraintdef(oid) like '%period_end%'
  loop
    execute format('alter table %s drop constraint %I',target.table_name,target.conname);
    execute format('alter table %s add constraint %I check (period_start is not null and period_end is not null and period_end>=period_start)',target.table_name,target.conname);
  end loop;
end $migration$;

-- References retain the bank-compatible historical format. Their version
-- namespace covers the entire start month, so two cycles cannot reuse V1.
do $migration$
declare target record; definition text; version_block text; replacement text;
begin
  for target in select oid,proname from pg_proc where pronamespace='public'::regnamespace
    and proname in ('workforce_payout_payment_reference','helper_payout_payment_reference')
  loop
    definition:=pg_get_functiondef(target.oid);
    definition:=regexp_replace(definition,' or extract\(day from p_period_start\) <> 1','','gi');
    execute definition;
  end loop;
  for target in select oid,proname from pg_proc where pronamespace='public'::regnamespace
    and proname in ('workforce_create_payout_payment_batch','workforce_create_payout_payment_row_batch','helper_create_payout_payment_row_batch')
  loop
    definition:=pg_get_functiondef(target.oid);
    version_block:=substring(definition from '(?is)select coalesce\(max\(item.payment_version\).*?;');
    if version_block is null then raise exception 'Missing bank version allocation in %',target.proname; end if;
    if version_block like '%date_trunc%' then continue; end if;
    replacement:=regexp_replace(version_block,
      'item.period_start = p_period_start[[:space:]]+and item.period_end = p_period_end',
      'item.period_start >= date_trunc(''month'',p_period_start)::date and item.period_start < (date_trunc(''month'',p_period_start)+interval ''1 month'')::date','i');
    if replacement=version_block then raise exception 'Unexpected bank version allocation in %',target.proname; end if;
    execute replace(definition,version_block,replacement);
  end loop;
end $migration$;

-- Exact-period partial payments use their existing balance calculation.
-- Different overlapping periods cannot pay the same location twice. Paid
-- Workforce credits follow their effective recipient after mapping transfers.
create or replace function public.payout_bank_period_overlap(
  p_company_id uuid,p_audience text,p_subject_id uuid,p_station_id uuid,p_start date,p_end date
) returns boolean language plpgsql stable security definer set search_path=''
as $function$
begin
  if p_audience='helpers' then
    return exists(select 1 from public.helper_payout_payment_items item
      where item.company_id=p_company_id and item.helper_id=p_subject_id
        and (p_station_id is null or item.location_id_snapshot=p_station_id)
        and item.status in ('processing','paid') and item.instruction_amount>0
        and item.period_start<=p_end and item.period_end>=p_start
        and (item.period_start,item.period_end)<>(p_start,p_end));
  end if;
  return exists(select 1 from public.workforce_payout_effective_paid_allocations paid
    where paid.company_id=p_company_id and paid.credited_workforce_id=p_subject_id
      and (p_station_id is null or paid.station_id=p_station_id)
      and paid.settled_amount_snapshot>0
      and paid.period_start<=p_end and paid.period_end>=p_start
      and (paid.period_start,paid.period_end)<>(p_start,p_end))
    or exists(select 1 from public.workforce_payout_payment_items item
      join public.workforce_payout_payment_allocations allocation on allocation.payment_item_id=item.id
        and allocation.company_id=item.company_id
      where item.company_id=p_company_id and item.workforce_id=p_subject_id
        and (p_station_id is null or allocation.station_id=p_station_id)
        and item.status='processing' and allocation.instruction_amount_snapshot>0
        and item.period_start<=p_end and item.period_end>=p_start
        and (item.period_start,item.period_end)<>(p_start,p_end));
end $function$;
revoke all on function public.payout_bank_period_overlap(uuid,text,uuid,uuid,date,date) from public,anon,authenticated;
grant execute on function public.payout_bank_period_overlap(uuid,text,uuid,uuid,date,date) to service_role;

-- Both previews and creators use these same candidates. Creators already
-- hold lock_workforce_payment_allocation_company before rechecking candidates.
do $migration$
declare target record; definition text; guard text; audience text; station text;
begin
  for target in select oid,proname from pg_proc where pronamespace='public'::regnamespace
    and proname in ('workforce_payout_payment_candidates','workforce_payout_payment_row_candidates','helper_payout_payment_row_candidates')
  loop
    definition:=pg_get_functiondef(target.oid);
    if position('public.payout_bank_period_overlap(' in definition)>0 then continue; end if;
    audience:=case when target.proname like 'helper_%' then 'helpers' else 'workforce' end;
    station:=case when target.proname='workforce_payout_payment_candidates' then 'null::uuid' else 'station_id' end;
    guard:=format($guard$if public.payout_bank_period_overlap(p_company_id,%L,workforce_id,%s,p_period_start,p_period_end) then
      eligible := false;
      eligibility_code := 'overlapping_payment_period';
      eligibility_message := 'An overlapping date range has a paid or processing payment for this location. Use the original period for its remaining balance, or cancel/reverse that instruction first.';
      return next;
      continue;
    end if;
    eligible := true;$guard$,audience,station);
    if position('eligible := true;' in definition)=0 then raise exception 'Missing bank eligibility in %',target.proname; end if;
    execute replace(definition,'eligible := true;',guard);
  end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
