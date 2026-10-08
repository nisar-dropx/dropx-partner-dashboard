-- Keep the EDD package ledger to what is read. Every reader looks at rows seen
-- in the last 7 days (verification: 3 days); nothing was ever removed, so by
-- 2026-10-08 three of every four rows (~1.2 GB) were dead weight on a 4 GB
-- database. Rows not seen for 14 days are now removed daily, one bounded batch
-- per station so no statement comes near the API statement timeout.
--
-- A package that reappears in a source feed is ingested again and re-verified.
begin;
create function public.edd_prune_ledger(p_station text, p_limit integer default 2000)
returns integer language sql security invoker set search_path = public, pg_temp as $$
  with gone as (
    delete from public.edd_package_ledger l
    where l.station_code = p_station and l.tracking_id in (
      select o.tracking_id from public.edd_package_ledger o
      where o.station_code = p_station and o.last_seen_at < now() - interval '14 days'
      order by o.last_seen_at limit least(greatest(p_limit, 1), 5000))
      -- Re-checked on the row being deleted: an ingest may have just seen it again.
      and l.last_seen_at < now() - interval '14 days'
    returning 1)
  select count(*)::integer from gone
$$;
revoke all on function public.edd_prune_ledger(text, integer) from public, anon, authenticated;
grant execute on function public.edd_prune_ledger(text, integer) to service_role;
commit;
