begin;

-- Fuel-only identity evidence. Never writes the onboarding links or pay mappings.
alter table public.workforce_route_distance_stations add column scc_account_key text not null default 'default';
update public.workforce_route_distance_stations r set scc_account_key=a.account_key
from public.stations s join public.amazon_portal_credentials a on upper(a.default_station_code)=upper(s.station_code)
where r.station_id=s.id and r.company_id=s.company_id and a.account_key<>'default'
and (select count(*) from public.amazon_portal_credentials b where upper(b.default_station_code)=upper(s.station_code) and b.account_key<>'default')=1;

create table public.workforce_route_scc_snapshots (
 company_id uuid not null references public.companies(id),
 station_id uuid not null references public.stations(id),
 drivers jsonb not null check(jsonb_typeof(drivers)='array' and jsonb_array_length(drivers)<=1000),
 observed_at timestamptz not null default now(),
 primary key(company_id,station_id)
);
alter table public.workforce_route_scc_snapshots enable row level security;
revoke all on public.workforce_route_scc_snapshots from public,anon,authenticated,service_role;
grant select on public.workforce_route_scc_snapshots to service_role;

create function public.workforce_store_route_scc_snapshot(p_company_id uuid,p_station_id uuid,p_drivers jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare cleaned jsonb;
begin
 if not exists(select 1 from public.workforce_route_distance_stations s join public.workforce_route_distance_settings c using(company_id)
   where s.company_id=p_company_id and s.station_id=p_station_id and c.enabled) then raise exception 'Fuel station is not enabled'; end if;
 if jsonb_typeof(p_drivers)<>'array' or jsonb_array_length(p_drivers)>1000 or jsonb_array_length(p_drivers)=0 then raise exception 'Invalid SCC roster'; end if;
 -- Keep contradictory ID pairs: the resolver must flag them, never pick the first.
 select jsonb_agg(distinct jsonb_build_object('employeeId',btrim(d->>'employeeId'),'tasId',upper(btrim(d->>'tasId')))) into cleaned
 from jsonb_array_elements(p_drivers) d
 where btrim(d->>'employeeId') ~ '^[1-9][0-9]{0,19}$' and upper(btrim(d->>'tasId')) ~ '^A[A-Z0-9]{5,31}$'
 and coalesce(d->>'store','false')='false';
 if cleaned is null then raise exception 'No valid SCC driver IDs'; end if;
 insert into public.workforce_route_scc_snapshots(company_id,station_id,drivers) values(p_company_id,p_station_id,cleaned)
 on conflict(company_id,station_id) do update set drivers=excluded.drivers,observed_at=clock_timestamp();
 return jsonb_array_length(cleaned);
end;
$$;
revoke all on function public.workforce_store_route_scc_snapshot(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.workforce_store_route_scc_snapshot(uuid,uuid,jsonb) to service_role;

create function public.workforce_route_distance_targets_v2(p_company_id uuid,p_work_date date,p_station_id uuid default null)
returns table(mapping_id uuid,workforce_id uuid,station_id uuid,station_code text,service_area_id text,latitude double precision,longitude double precision,transporter_id text,identity_source text,identity_reason text)
language sql security definer set search_path='' as $$
with candidates as (
 select m.id,m.workforce_id,m.station_id,s.station_code,s.amazon_service_area_id::text service_area_id,a.latitude,a.longitude,
  sc.ids scc_ids,sc.reverse_conflict,pl.ids portal_ids,old.ids prior_ids
 from public.field_executive_provider_mappings m
 join public.workforce_route_distance_settings cfg on cfg.company_id=m.company_id and cfg.enabled and p_work_date>=cfg.effective_from
 join public.workforce w on w.id=m.workforce_id and w.company_id=m.company_id
 join public.stations s on s.id=m.station_id and s.company_id=m.company_id
 left join public.workforce_route_distance_stations a on a.company_id=m.company_id and a.station_id=m.station_id
 left join public.workforce_route_scc_snapshots snap on snap.company_id=m.company_id and snap.station_id=m.station_id and snap.observed_at>=now()-interval '7 days'
 left join lateral (
  select array_agg(distinct d->>'tasId') ids,
   bool_or(exists(select 1 from jsonb_array_elements(snap.drivers) x where x->>'tasId'=d->>'tasId' and x->>'employeeId'<>d->>'employeeId')) reverse_conflict
  from jsonb_array_elements(snap.drivers) d where d->>'employeeId'=btrim(m.provider_member_id)
 ) sc on true
 left join lateral (select array_agg(distinct upper(btrim(l.transporter_id))) ids from public.workforce_amazon_portal_links l
  where l.company_id=m.company_id and l.workforce_id=m.workforce_id and nullif(btrim(l.transporter_id),'') is not null) pl on true
 left join lateral (select array_agg(distinct upper(btrim(d.transporter_id))) ids from public.workforce_route_distances d
  where d.company_id=m.company_id and d.workforce_id=m.workforce_id and d.station_id=m.station_id and d.mapping_id=m.id and d.status='ready'
  and d.work_date<p_work_date and d.work_date>=p_work_date-7 and d.transporter_id is not null) old on true
 where m.company_id=p_company_id and (p_station_id is null or m.station_id=p_station_id)
 and m.status in ('active','closed') and m.effective_from<=p_work_date and (m.effective_to is null or m.effective_to>=p_work_date)
 and (w.date_of_join is null or w.date_of_join<=p_work_date) and (w.last_working_date is null or w.last_working_date>=p_work_date)
 and exists(select 1 from public.payment_method_components c join public.payment_fields f on f.id=c.payment_field_id where c.payment_method_id=m.payment_method_id
  and c.is_active is not false and upper(trim(coalesce(nullif(c.component_code,''),f.code)))='KM_RUN')
 and exists(select 1 from jsonb_each_text(m.payment_values) v where upper(trim(v.key))='KM_RUN' and v.value ~ '^([0-9]+([.][0-9]*)?|[.][0-9]+)$' and v.value::numeric>0)
), resolved as (
 select *,case when cardinality(scc_ids)>1 or reverse_conflict or cardinality(portal_ids)>1 or cardinality(prior_ids)>1
   or (cardinality(scc_ids)=1 and cardinality(portal_ids)=1 and scc_ids[1]<>portal_ids[1])
   or (cardinality(scc_ids)=1 and cardinality(prior_ids)=1 and scc_ids[1]<>prior_ids[1])
   or (cardinality(portal_ids)=1 and cardinality(prior_ids)=1 and portal_ids[1]<>prior_ids[1]) then true else false end conflict,
   coalesce(scc_ids[1],portal_ids[1],prior_ids[1]) candidate_id,
   case when cardinality(scc_ids)=1 then 'scc_exact_id' when cardinality(portal_ids)=1 then 'verified_portal_link' when cardinality(prior_ids)=1 then 'prior_confirmed_route' end source
 from candidates
), checked as (
 select *,count(*) over(partition by workforce_id,station_id) worker_count,
 count(*) over(partition by candidate_id,station_id) driver_count from resolved
)
select id,workforce_id,station_id,station_code,service_area_id,latitude,longitude,
 case when not conflict and worker_count=1 and driver_count=1 then candidate_id end,
 case when not conflict and worker_count=1 and driver_count=1 then source end,
 case when conflict or worker_count>1 or (candidate_id is not null and driver_count>1) then 'amazon_identity_conflict'
 when candidate_id is null then 'amazon_identity_missing' end
from checked;
$$;
revoke all on function public.workforce_route_distance_targets_v2(uuid,date,uuid) from public,anon,authenticated;
grant execute on function public.workforce_route_distance_targets_v2(uuid,date,uuid) to service_role;

-- Existing consumers and the write guard resolve exactly the same identity.
create or replace function public.workforce_route_distance_targets(p_company_id uuid,p_work_date date,p_station_id uuid default null)
returns table(mapping_id uuid,workforce_id uuid,station_id uuid,station_code text,service_area_id text,latitude double precision,longitude double precision,transporter_id text)
language sql security definer set search_path='' as $$
 select mapping_id,workforce_id,station_id,station_code,service_area_id,latitude,longitude,transporter_id
 from public.workforce_route_distance_targets_v2(p_company_id,p_work_date,p_station_id);
$$;
notify pgrst,'reload schema';
commit;
