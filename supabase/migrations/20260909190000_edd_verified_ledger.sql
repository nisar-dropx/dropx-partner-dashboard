-- Additive EDD-only ledger. Existing Ageing/Performance snapshots are never changed.
-- Service-role access only: every HTTP caller must resolve its station scope first.
create table public.edd_package_ledger (
  station_code text not null,
  tracking_id text not null,
  source jsonb not null default '{}'::jsonb,
  source_at timestamptz not null,
  backlog_at timestamptz,
  performance_at timestamptz,
  last_seen_at timestamptz not null,
  verification jsonb,
  verified_at timestamptz,
  next_check_at timestamptz not null default now(),
  primary key (station_code, tracking_id)
);
alter table public.edd_package_ledger enable row level security;
revoke all on public.edd_package_ledger from anon, authenticated;
grant all on public.edd_package_ledger to service_role;
create index edd_ledger_verification_queue on public.edd_package_ledger(next_check_at, station_code);

create table public.edd_verification_lease (
  id integer primary key check (id = 1), token uuid, expires_at timestamptz not null default now()
);
insert into public.edd_verification_lease(id) values(1);
alter table public.edd_verification_lease enable row level security;
revoke all on public.edd_verification_lease from anon, authenticated;
grant all on public.edd_verification_lease to service_role;

create function public.edd_ingest_observations(p_codes text[] default null)
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
end $$;

create function public.edd_claim_verification(p_token uuid, p_codes text[] default null, p_limit integer default 30)
returns setof public.edd_package_ledger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.edd_verification_lease set token=p_token, expires_at=now()+interval '100 seconds'
    where id=1 and expires_at < now();
  if not found then return; end if;
  return query with candidates as (
    select station_code,tracking_id from public.edd_package_ledger
    where (p_codes is null or station_code=any(p_codes)) and next_check_at <= now()
      and last_seen_at > now()-interval '3 days'
      and coalesce(source->>'ead', verification->>'edd', '') <= to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD')
    order by
      case when coalesce(source->>'ead',verification->>'edd')=to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD') then 0
        when coalesce(source->>'ead',verification->>'edd','')='' then 1 else 2 end,
      next_check_at,station_code,tracking_id
    limit least(greatest(p_limit,1),40) for update skip locked
  ) update public.edd_package_ledger l set next_check_at=now()+interval '10 minutes'
      from candidates c where l.station_code=c.station_code and l.tracking_id=c.tracking_id returning l.*;
end $$;

revoke all on function public.edd_ingest_observations(text[]) from public,anon,authenticated;
revoke all on function public.edd_claim_verification(uuid,text[],integer) from public,anon,authenticated;
grant execute on function public.edd_ingest_observations(text[]) to service_role;
grant execute on function public.edd_claim_verification(uuid,text[],integer) to service_role;
