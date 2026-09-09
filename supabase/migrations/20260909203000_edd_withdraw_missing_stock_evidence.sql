-- EDD-only derived evidence invalidation; original source tables remain read-only.
create or replace function public.edd_ingest_observations(p_codes text[] default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Preserve dates even when a completed package disappears from the backlog.
  insert into public.edd_package_ledger as old(station_code,tracking_id,source,source_at,last_seen_at,backlog_at)
  select distinct on (s.station_code,p->>'trackingId') s.station_code,p->>'trackingId',jsonb_strip_nulls(p),s.fetched_at,s.fetched_at,s.fetched_at
  from public.edd_station_snapshots s cross join lateral jsonb_array_elements(s.packages) p
  where (p_codes is null or s.station_code = any(p_codes)) and coalesce(p->>'trackingId','') <> ''
    and not exists(select 1 from public.edd_package_ledger l where l.station_code=s.station_code and l.backlog_at>=s.fetched_at)
  order by s.station_code,p->>'trackingId'
  on conflict(station_code,tracking_id) do update set
    source = old.source || excluded.source || case when excluded.source_at < old.source_at then jsonb_strip_nulls(jsonb_build_object('state',old.source->'state','driverId',old.source->'driverId','driverName',old.source->'driverName')) else '{}'::jsonb end,
    source_at = greatest(old.source_at,excluded.source_at), last_seen_at = greatest(old.last_seen_at,excluded.last_seen_at), backlog_at=excluded.backlog_at
    where old.backlog_at is null or excluded.backlog_at > old.backlog_at;
  -- Performance supplies newer outcomes/associate IDs, NOT an inferred EDD date.
  insert into public.edd_package_ledger as old(station_code,tracking_id,source,source_at,last_seen_at,performance_at)
  select distinct on (s.station_code,p->>'trackingId') s.station_code,p->>'trackingId',jsonb_strip_nulls(p - 'bucket'),s.fetched_at,s.fetched_at,s.fetched_at
  from public.edd_performance_snapshots s cross join lateral jsonb_array_elements(s.packages) p
  where (p_codes is null or s.station_code = any(p_codes)) and coalesce(p->>'trackingId','') <> ''
    and not exists(select 1 from public.edd_package_ledger l where l.station_code=s.station_code and l.performance_at>=s.fetched_at)
  order by s.station_code,p->>'trackingId'
  on conflict(station_code,tracking_id) do update set
    source = case when excluded.source_at >= old.source_at then old.source || excluded.source else excluded.source || old.source end,
    source_at = greatest(old.source_at,excluded.source_at), last_seen_at = greatest(old.last_seen_at,excluded.last_seen_at), performance_at=excluded.performance_at
    where old.performance_at is null or excluded.performance_at > old.performance_at;
  -- Disappearance from a newer complete active backlog is not evidence of stock.
  -- Keep the prior scan facts for audit/HFR, but withdraw no-dispatch confirmation.
  update public.edd_package_ledger l set
    verification=l.verification || jsonb_build_object('historyComplete',false),
    next_check_at=least(l.next_check_at,now())
  from public.edd_station_snapshots s
  where l.station_code=s.station_code and (p_codes is null or s.station_code=any(p_codes))
    and coalesce(l.backlog_at,'-infinity'::timestamptz)<s.fetched_at
    and l.verified_at<s.fetched_at
    and l.verification->>'historyComplete'='true'
    and coalesce(l.verification->>'state',l.source->>'state') in ('INDUCTED','RECEIVED');
end $$;
