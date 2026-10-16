begin;
create or replace function public.fleet_da_delivery_rows(p_company uuid,p_stations text[],p_from date,p_to date)
returns table(vehicle_id uuid,station_code text,work_date date,snapshot jsonb,review_status text,reason text,provider_employee_id text,name text,delivered numeric,c_return numeric,swa numeric,assignment_source text,minimum_deliveries integer)
language sql stable security invoker set search_path='' as $$
with policy as (select coalesce((select assignment_min_deliveries from public.fleet_control_settings where company_id=p_company),5) minimum,
 coalesce((select assignment_auto_delivery from public.fleet_control_settings where company_id=p_company),true) auto),
days as materialized (
 select p.vehicle_id,p.station_code,d::date work_date,p.snapshot,
 coalesce(a.ids,case when c.vehicle_id is not null then array[]::text[] else array[coalesce(h.provider_employee_id,b.provider_employee_id)] end) ids,
 coalesce(a.names,h.name,b.name) names,a.ids is not null manual,c.vehicle_id is not null and a.ids is null no_work,
 case when a.ids is not null then 'manual' when c.vehicle_id is not null then 'not_required' when h.provider_employee_id is not null then 'dated_default' when b.provider_employee_id is not null then 'historical_default' else 'unmapped' end origin
 from public.fleet_da_mapping_periods p
 cross join lateral generate_series(greatest(p.effective_from,p_from)::timestamp,least(coalesce(p.effective_to-1,p_to),p_to,(now() at time zone 'Asia/Kolkata')::date-1)::timestamp,interval '1 day') d
 left join public.fleet_vehicle_day_confirmations c on c.company_id=p.company_id and c.vehicle_id=p.vehicle_id and c.work_date=d::date
 left join lateral (select array_agg(upper(trim(x.provider_employee_id)) order by x.provider_employee_id) ids,string_agg(x.name,' / ' order by x.provider_employee_id) names from public.fleet_day_assignments x where x.company_id=p.company_id and x.vehicle_id=p.vehicle_id and x.work_date=d::date and x.purpose='delivery' and x.is_active) a on true
 left join public.fleet_da_default_periods h on h.company_id=p.company_id and h.vehicle_id=p.vehicle_id and h.station_code=p.station_code and h.effective_from<=d::date and (h.effective_to is null or h.effective_to>d::date)
 left join public.fleet_da_default_backfills b on b.company_id=p.company_id and b.vehicle_id=p.vehicle_id and b.station_code=p.station_code and b.effective_from<=d::date and b.effective_to>d::date
 where p.company_id=p_company and p.eligible
), feeds as materialized (
 select s.station_code base,s.station_code feed from public.stations s where s.company_id=p_company and s.station_code=any(p_stations)
 union select s.station_code,c.station_code from public.stations s join public.stations c on c.parent_station_id=s.id and c.company_id=s.company_id and c.is_active join public.location_models m on m.id=c.location_model_id and upper(m.code)='XPT' where s.company_id=p_company and s.station_code=any(p_stations)
), facts as materialized (
 select f.*,b.status batch_status from public.cps_shipment_daily f left join public.report_import_batches b on b.id=f.source_batch_id and b.company_id=f.company_id and b.source_type='amazon_shipments'
 where f.company_id=p_company and f.client='Amazon' and f.work_date between greatest(p_from,(select min(work_date) from days)) and p_to and f.station_code in (select feed from feeds)
), feed_days as materialized (
 select fs.base,fs.feed,f.work_date,count(*) filter(where f.batch_status='Completed') complete_count,bool_or(f.batch_status is distinct from 'Completed') incomplete
 from facts f join feeds fs on fs.feed=f.station_code group by fs.base,fs.feed,f.work_date
), ready_days as materialized (
 select dates.station_code,dates.work_date,bool_and(coalesce(fd.complete_count,0)>0 and not coalesce(fd.incomplete,true)) ready
 from (select distinct station_code,work_date from days where station_code=any(p_stations)) dates
 join feeds fs on fs.base=dates.station_code left join feed_days fd on fd.base=fs.base and fd.feed=fs.feed and fd.work_date=dates.work_date
 group by dates.station_code,dates.work_date
), metrics as materialized (
 select fs.base,f.work_date,upper(trim(f.provider_employee_id)) provider_id,
 sum(f.total_delivery) delivered,bool_or(f.total_delivery is null) unknown_delivery,
 sum(f.c_return) returned,bool_or(f.c_return is null) unknown_return,
 sum(f.swa_delivery) swa,bool_or(f.swa_delivery is null) unknown_swa
 from facts f join feeds fs on fs.feed=f.station_code where f.batch_status='Completed' group by fs.base,f.work_date,upper(trim(f.provider_employee_id))
), matched as materialized (
 select d.vehicle_id,d.station_code,d.work_date,sum(m.delivered) deliveries,
 bool_or(m.unknown_delivery) unknown_delivery,
 case when bool_or(m.unknown_return) then null else coalesce(sum(m.returned),0) end returns,
 case when bool_or(m.unknown_swa) then null else coalesce(sum(m.swa),0) end sw
 from days d left join metrics m on m.base=d.station_code and m.work_date=d.work_date and m.provider_id=any(d.ids)
 where d.station_code=any(p_stations) group by d.vehicle_id,d.station_code,d.work_date
), evidence as (
 select d.*,policy.minimum,policy.auto,coalesce(rd.ready,false) and not coalesce(m.unknown_delivery,false) ready,
 not d.manual and exists(select 1 from days other where other.vehicle_id<>d.vehicle_id and other.work_date=d.work_date and not other.no_work and other.ids&&d.ids) conflict,
 m.deliveries,m.returns,m.sw
 from days d cross join policy left join ready_days rd on rd.station_code=d.station_code and rd.work_date=d.work_date
 left join matched m on m.vehicle_id=d.vehicle_id and m.station_code=d.station_code and m.work_date=d.work_date
 where d.station_code=any(p_stations)
)
select vehicle_id,station_code,work_date,snapshot,
 case when no_work then 'saved' when not ready then 'awaiting_data' when conflict then 'pending' when coalesce(deliveries,0)<minimum then 'pending' when manual then 'saved' when auto then 'automatic' else 'pending' end,
 case when no_work then 'Recorded non-operational / no-work day' when not ready then 'Awaiting completed Amazon report for station and linked XPTs' when conflict then 'DA ID conflicts with another vehicle; deliveries are not attributed twice' when ids[1] is null then 'DA ID not mapped' when coalesce(deliveries,0)<minimum then 'Only '||coalesce(deliveries,0)::text||' deliveries; minimum '||minimum::text when manual then 'Saved DA has sufficient deliveries' when auto then 'Default DA has sufficient deliveries' else 'Automatic matching disabled in Fleet Masters' end,
 array_to_string(ids,' / '),names,
 case when ready and not conflict and not no_work then coalesce(deliveries,0) end,
 case when ready and not conflict and not no_work then returns end,
 case when ready and not conflict and not no_work then sw end,origin,minimum from evidence;
$$;
commit;
