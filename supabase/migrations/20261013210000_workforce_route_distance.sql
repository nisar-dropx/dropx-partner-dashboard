begin;

-- Separate service-only provenance: public map rows are never payroll inputs.
create table public.workforce_route_distance_settings (
  company_id uuid primary key references public.companies(id),
  enabled boolean not null default false,
  effective_from date not null,
  updated_at timestamptz not null default now()
);
create table public.workforce_route_distance_stations (
  company_id uuid not null references public.companies(id),
  station_id uuid not null references public.stations(id),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  primary key(company_id,station_id),
  check (latitude <> 0 or longitude <> 0)
);
create table public.workforce_route_distances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  workforce_id uuid not null references public.workforce(id),
  station_id uuid not null references public.stations(id),
  mapping_id uuid not null references public.field_executive_provider_mappings(id),
  work_date date not null,
  transporter_id text,
  status text not null check (status in ('ready','pending')),
  reason text,
  distance_km numeric(18,4),
  departure_km numeric(18,4),
  delivery_km numeric(18,4),
  return_km numeric(18,4),
  scan_count integer not null check(scan_count >= 0),
  itinerary_ids jsonb not null default '[]'::jsonb check(jsonb_typeof(itinerary_ids)='array'),
  source_hash text not null,
  route_geometry jsonb,
  calculation_version text not null default 'amazon-scan-road-v1',
  calculated_at timestamptz not null default now(),
  unique(company_id,workforce_id,station_id,work_date),
  check ((status='ready' and distance_km is not null and departure_km is not null and delivery_km is not null and return_km is not null and abs(distance_km-departure_km-delivery_km-return_km)<=0.0002 and distance_km>0 and departure_km>=0 and delivery_km>=0 and return_km>=0 and reason is null and transporter_id is not null and source_hash ~ '^[a-f0-9]{64}$')
      or (status='pending' and reason is not null and distance_km is null and departure_km is null and delivery_km is null and return_km is null))
);
create index workforce_route_distances_period on public.workforce_route_distances(company_id,work_date,workforce_id);

alter table public.workforce_route_distance_settings enable row level security;
alter table public.workforce_route_distance_stations enable row level security;
alter table public.workforce_route_distances enable row level security;
revoke all on public.workforce_route_distance_settings,public.workforce_route_distance_stations,public.workforce_route_distances from public,anon,authenticated,service_role;
grant select on public.workforce_route_distance_settings,public.workforce_route_distance_stations,public.workforce_route_distances to service_role;

-- Release is explicitly enabled after the Worker and both consumers are deployed.
insert into public.workforce_route_distance_settings(company_id,effective_from)
values ('43866344-b550-4e8a-9a2d-9d23f3d8a997','2026-10-01');
insert into public.workforce_route_distance_stations(company_id,station_id,latitude,longitude)
select distinct s.company_id,s.id,s.latitude,s.longitude from public.stations s
join public.field_executive_provider_mappings m on m.station_id=s.id and m.company_id=s.company_id
where s.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
and m.payment_values ? 'KM_RUN' and s.latitude is not null and s.longitude is not null
and (s.latitude<>0 or s.longitude<>0);

create function public.workforce_route_distance_targets(p_company_id uuid,p_work_date date,p_station_id uuid default null)
returns table(mapping_id uuid,workforce_id uuid,station_id uuid,station_code text,service_area_id text,latitude double precision,longitude double precision,transporter_id text)
language sql security definer set search_path='' as $$
select m.id,m.workforce_id,m.station_id,s.station_code,s.amazon_service_area_id::text,a.latitude,a.longitude,
  case when count(l.transporter_id) over(partition by m.workforce_id,m.station_id)=1
       and count(*) over(partition by l.transporter_id,m.station_id)=1 then l.transporter_id else null end
from public.field_executive_provider_mappings m
join public.workforce_route_distance_settings cfg on cfg.company_id=m.company_id and cfg.enabled and p_work_date>=cfg.effective_from
join public.workforce w on w.id=m.workforce_id and w.company_id=m.company_id
join public.stations s on s.id=m.station_id and s.company_id=m.company_id
left join public.workforce_route_distance_stations a on a.company_id=m.company_id and a.station_id=m.station_id
left join public.workforce_amazon_portal_links l on l.company_id=m.company_id and l.workforce_id=m.workforce_id and nullif(l.transporter_id,'') is not null
where m.company_id=p_company_id and (p_station_id is null or m.station_id=p_station_id)
and m.status in ('active','closed') and m.effective_from<=p_work_date and (m.effective_to is null or m.effective_to>=p_work_date)
and (w.date_of_join is null or w.date_of_join<=p_work_date) and (w.last_working_date is null or w.last_working_date>=p_work_date)
and exists (select 1 from public.payment_method_components c join public.payment_fields f on f.id=c.payment_field_id
 where c.payment_method_id=m.payment_method_id and c.is_active is not false and upper(trim(coalesce(nullif(c.component_code,''),f.code)))='KM_RUN')
and exists (select 1 from jsonb_each_text(m.payment_values) v where upper(trim(v.key))='KM_RUN' and v.value ~ '^([0-9]+([.][0-9]*)?|[.][0-9]+)$' and v.value::numeric>0);
$$;

create function public.workforce_store_route_distance(p_company_id uuid,p_row jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare
  target record;
  existing public.workforce_route_distances;
  day date := (p_row->>'work_date')::date;
  worker uuid := (p_row->>'workforce_id')::uuid;
  station uuid := (p_row->>'station_id')::uuid;
begin
  perform public.lock_workforce_payment_allocation_company(p_company_id);
  select * into target from public.workforce_route_distance_targets(p_company_id,day,station) t
    where t.workforce_id=worker and t.mapping_id=(p_row->>'mapping_id')::uuid;
  if not found or (select count(*) from public.workforce_route_distance_targets(p_company_id,day,station) t where t.workforce_id=worker)<>1
    then raise exception 'Route mapping is missing or ambiguous'; end if;
  if p_row->>'status'='ready' and (day >= (now() at time zone 'Asia/Kolkata')::date
    or target.transporter_id is null or target.transporter_id is distinct from p_row->>'transporter_id')
    then raise exception 'Route day or Amazon identity is not settled'; end if;
  -- An automatic sync never rewrites a reviewed/published payment period.
  if exists(select 1 from public.workforce_payout_publications p where p.company_id=p_company_id
    and p.workforce_id=worker and day between p.period_start and p.period_end)
    then return 'frozen'; end if;
  select * into existing from public.workforce_route_distances d where d.company_id=p_company_id and d.workforce_id=worker and d.station_id=station and d.work_date=day for update;
  if existing.status='ready' and p_row->>'reason' in ('source_unavailable','road_routing_unavailable') then return 'preserved'; end if;
  if found and existing.source_hash=p_row->>'source_hash' and existing.status=p_row->>'status'
    and existing.reason is not distinct from p_row->>'reason' and existing.mapping_id=target.mapping_id then return 'unchanged'; end if;
  insert into public.workforce_route_distances(company_id,workforce_id,station_id,mapping_id,work_date,transporter_id,status,reason,distance_km,departure_km,delivery_km,return_km,scan_count,itinerary_ids,source_hash,route_geometry)
  values(p_company_id,worker,station,target.mapping_id,day,p_row->>'transporter_id',p_row->>'status',p_row->>'reason',
    (p_row->>'distance_km')::numeric,(p_row->>'departure_km')::numeric,(p_row->>'delivery_km')::numeric,(p_row->>'return_km')::numeric,
    coalesce((p_row->>'scan_count')::integer,0),coalesce(p_row->'itinerary_ids','[]'::jsonb),coalesce(p_row->>'source_hash',''),p_row->'route_geometry')
  on conflict(company_id,workforce_id,station_id,work_date) do update set mapping_id=excluded.mapping_id,transporter_id=excluded.transporter_id,status=excluded.status,reason=excluded.reason,
    distance_km=excluded.distance_km,departure_km=excluded.departure_km,delivery_km=excluded.delivery_km,return_km=excluded.return_km,
    scan_count=excluded.scan_count,itinerary_ids=excluded.itinerary_ids,source_hash=excluded.source_hash,route_geometry=excluded.route_geometry,calculated_at=clock_timestamp();
  perform public.workforce_bump_payout_period_dependency_revision(p_company_id,day);
  return 'updated';
end;
$$;
revoke all on function public.workforce_route_distance_targets(uuid,date,uuid),public.workforce_store_route_distance(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.workforce_route_distance_targets(uuid,date,uuid),public.workforce_store_route_distance(uuid,jsonb) to service_role;
comment on table public.workforce_route_distances is 'Calculated road distance through Amazon execution scans, including one station departure and return per driver/day. Service-only; not a GPS odometer trace.';
notify pgrst,'reload schema';
commit;
