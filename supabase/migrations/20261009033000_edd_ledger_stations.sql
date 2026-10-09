-- The ledger cleanup took its station list from the live snapshot tables, so a
-- station that stopped appearing in the feeds (SBPD) kept its old rows forever.
-- This lists the stations actually present in the ledger, one index probe each.
begin;
create function public.edd_ledger_stations()
returns setof text language sql stable security invoker set search_path = public, pg_temp as $$
  with recursive station(code) as (
    (select l.station_code from public.edd_package_ledger l order by l.station_code limit 1)
    union all
    select (select l.station_code from public.edd_package_ledger l where l.station_code > station.code order by l.station_code limit 1)
    from station where station.code is not null
  )
  select code from station where code is not null
$$;
revoke all on function public.edd_ledger_stations() from public, anon, authenticated;
grant execute on function public.edd_ledger_stations() to service_role;
commit;
