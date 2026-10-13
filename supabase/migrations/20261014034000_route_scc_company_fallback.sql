-- A DA may be rostered at a parent/neighbouring SCC station while working at
-- the mapped station. Resolve the exact numeric employee ID across this same
-- company's fresh, service-only SCC snapshots. Reject conflicts in either
-- direction. The worker still requires this driver in the target station's
-- actual daily itinerary before calculating kilometres. No pay mappings change.
begin;
create or replace function public.workforce_route_distance_targets_v2(p_company_id uuid,p_work_date date,p_station_id uuid default null)
returns table(mapping_id uuid,workforce_id uuid,station_id uuid,station_code text,service_area_id text,latitude double precision,longitude double precision,transporter_id text,identity_source text,identity_reason text)
language sql security definer set search_path='' as $$
with scc_evidence as (
 select snap.station_id,d->>'employeeId' employee_id,d->>'tasId' tas_id
 from public.workforce_route_scc_snapshots snap
 cross join lateral jsonb_array_elements(snap.drivers) d
 where snap.company_id=p_company_id and snap.observed_at>=now()-interval '7 days'
), candidates as (
 select m.id,m.workforce_id,m.station_id,s.station_code,s.amazon_service_area_id::text service_area_id,a.latitude,a.longitude,
  sc.ids scc_ids,sc.reverse_conflict,sc.same_station,pl.ids portal_ids,old.ids prior_ids
 from public.field_executive_provider_mappings m
 join public.workforce_route_distance_settings cfg on cfg.company_id=m.company_id and cfg.enabled and p_work_date>=cfg.effective_from
 join public.workforce w on w.id=m.workforce_id and w.company_id=m.company_id
 join public.stations s on s.id=m.station_id and s.company_id=m.company_id
 left join public.workforce_route_distance_stations a on a.company_id=m.company_id and a.station_id=m.station_id
 left join lateral (
  select array_agg(distinct d.tas_id) ids,
   bool_or(d.station_id=m.station_id) same_station,
   bool_or(exists(select 1 from scc_evidence x where x.tas_id=d.tas_id and x.employee_id<>d.employee_id)) reverse_conflict
  from scc_evidence d where d.employee_id=btrim(m.provider_member_id)
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
   case when cardinality(scc_ids)=1 and same_station then 'scc_exact_id' when cardinality(scc_ids)=1 then 'scc_company_exact_id' when cardinality(portal_ids)=1 then 'verified_portal_link' when cardinality(prior_ids)=1 then 'prior_confirmed_route' end source
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
commit;
