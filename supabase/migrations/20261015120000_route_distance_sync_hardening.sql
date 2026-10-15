-- Route distance sync must never hold up payroll.
-- 1. Unchanged, frozen and preserved writes return before the company payroll
--    lock and without resolving identities (the hourly sync is mostly these).
-- 2. Identity is resolved once per write, outside the lock (was twice inside).
-- 3. The lock wait is capped; a busy payroll makes the sync retry later
--    instead of queueing behind it.
-- Safe to re-run (if-not-exists table/indexes, create-or-replace function).
-- 4. A small service-only run log lets the hourly worker visit only the
--    station-days that can still change.
begin;

create table if not exists public.workforce_route_distance_sync_runs (
  company_id uuid not null references public.companies(id),
  station_id uuid not null references public.stations(id),
  work_date date not null,
  last_run_at timestamptz not null,
  outcome text not null check (outcome in ('done','failed')),
  calculation_version text,
  ready integer not null default 0,
  pending integer not null default 0,
  frozen integer not null default 0,
  busy integer not null default 0,
  unchanged integer not null default 0,
  primary key (company_id,station_id,work_date)
);
create index if not exists workforce_route_distance_sync_runs_day on public.workforce_route_distance_sync_runs(company_id,work_date);
create index if not exists workforce_route_distance_sync_runs_station_fk on public.workforce_route_distance_sync_runs(station_id);
alter table public.workforce_route_distance_sync_runs enable row level security;
revoke all on public.workforce_route_distance_sync_runs from public,anon,authenticated,service_role;
grant select,insert,update on public.workforce_route_distance_sync_runs to service_role;

create or replace function public.workforce_store_route_distance(p_company_id uuid,p_row jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare
  target record;
  candidate record;
  matches integer := 0;
  existing public.workforce_route_distances;
  day date := (p_row->>'work_date')::date;
  worker uuid := (p_row->>'workforce_id')::uuid;
  station uuid := (p_row->>'station_id')::uuid;
  mapping uuid := (p_row->>'mapping_id')::uuid;
  caller_lock_timeout text := current_setting('lock_timeout');
begin
  -- An automatic sync never rewrites a reviewed/published payment period.
  if exists(select 1 from public.workforce_payout_publications p where p.company_id=p_company_id
    and p.workforce_id=worker and day between p.period_start and p.period_end)
    then return 'frozen'; end if;
  select * into existing from public.workforce_route_distances d where d.company_id=p_company_id and d.workforce_id=worker and d.station_id=station and d.work_date=day;
  if found and existing.status='ready' and existing.mapping_id=mapping and p_row->>'reason' in ('source_unavailable','road_routing_unavailable') then return 'preserved'; end if;
  if found and existing.source_hash=p_row->>'source_hash' and existing.status=p_row->>'status'
    and existing.reason is not distinct from p_row->>'reason' and existing.mapping_id=mapping
    and existing.transporter_id is not distinct from p_row->>'transporter_id' then
    -- Same evidence and result under a newer calculation: record the version only.
    -- Payable values are untouched, so payroll needs neither the lock nor a revision.
    if p_row ? 'calculation_version' and existing.calculation_version is distinct from p_row->>'calculation_version' then
      update public.workforce_route_distances set calculation_version=p_row->>'calculation_version' where id=existing.id;
    end if;
    return 'unchanged';
  end if;

  for candidate in select * from public.workforce_route_distance_targets(p_company_id,day,station) t where t.workforce_id=worker loop
    matches := matches+1;
    if candidate.mapping_id=mapping then target := candidate; end if;
  end loop;
  if matches<>1 or target.mapping_id is null then raise exception 'Route mapping is missing or ambiguous'; end if;
  if p_row->>'status'='ready' and (day >= (now() at time zone 'Asia/Kolkata')::date
    or target.transporter_id is null or target.transporter_id is distinct from p_row->>'transporter_id')
    then raise exception 'Route day or Amazon identity is not settled'; end if;

  -- Payroll holds this lock while confirming; wait briefly, then let the hourly sync retry.
  begin
    perform set_config('lock_timeout','3s',true);
    perform public.lock_workforce_payment_allocation_company(p_company_id);
  exception when lock_not_available then
    perform set_config('lock_timeout',caller_lock_timeout,true);
    return 'busy';
  end;
  perform set_config('lock_timeout',caller_lock_timeout,true);
  -- Re-check under the lock: payroll may have published while we waited.
  if exists(select 1 from public.workforce_payout_publications p where p.company_id=p_company_id
    and p.workforce_id=worker and day between p.period_start and p.period_end)
    then return 'frozen'; end if;
  select * into existing from public.workforce_route_distances d where d.company_id=p_company_id and d.workforce_id=worker and d.station_id=station and d.work_date=day for update;
  if found and existing.status='ready' and p_row->>'reason' in ('source_unavailable','road_routing_unavailable') then return 'preserved'; end if;
  insert into public.workforce_route_distances(company_id,workforce_id,station_id,mapping_id,work_date,transporter_id,status,reason,distance_km,departure_km,delivery_km,return_km,scan_count,itinerary_ids,source_hash,route_geometry,calculation_version)
  values(p_company_id,worker,station,target.mapping_id,day,p_row->>'transporter_id',p_row->>'status',p_row->>'reason',
    (p_row->>'distance_km')::numeric,(p_row->>'departure_km')::numeric,(p_row->>'delivery_km')::numeric,(p_row->>'return_km')::numeric,
    coalesce((p_row->>'scan_count')::integer,0),coalesce(p_row->'itinerary_ids','[]'::jsonb),coalesce(p_row->>'source_hash',''),p_row->'route_geometry',
    coalesce(p_row->>'calculation_version','amazon-scan-road-v1'))
  on conflict(company_id,workforce_id,station_id,work_date) do update set mapping_id=excluded.mapping_id,transporter_id=excluded.transporter_id,status=excluded.status,reason=excluded.reason,
    distance_km=excluded.distance_km,departure_km=excluded.departure_km,delivery_km=excluded.delivery_km,return_km=excluded.return_km,
    scan_count=excluded.scan_count,itinerary_ids=excluded.itinerary_ids,source_hash=excluded.source_hash,route_geometry=excluded.route_geometry,
    calculation_version=case when p_row ? 'calculation_version' then excluded.calculation_version else public.workforce_route_distances.calculation_version end,
    calculated_at=clock_timestamp();
  perform public.workforce_bump_payout_period_dependency_revision(p_company_id,day);
  return 'updated';
end;
$$;
revoke all on function public.workforce_store_route_distance(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.workforce_store_route_distance(uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
