begin;
alter table public.fleet_control_settings add column assignment_min_deliveries integer not null default 5 check(assignment_min_deliveries between 1 and 10000);
create function public.fleet_da_min_delivery_log() returns trigger language plpgsql set search_path='' as $$
declare ctx jsonb;actor uuid;
begin
 begin ctx:=(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-fleet-audit')::jsonb;actor:=nullif(ctx->>'actorId','')::uuid;exception when others then actor:=null;end;
 if actor is not null and not exists(select 1 from public.profiles where id=actor and company_id=new.company_id) then actor:=null;end if;
 insert into public.fleet_system_logs(company_id,event_kind,entity,entity_id,action,actor_user_id,actor_label,route,before_values,after_values)
 values(new.company_id,'change','fleet_control_settings',new.company_id::text,'update',actor,coalesce((select full_name from public.profiles where id=actor and company_id=new.company_id),'System'),ctx->>'route',jsonb_build_object('assignment_min_deliveries',old.assignment_min_deliveries),jsonb_build_object('assignment_min_deliveries',new.assignment_min_deliveries));
 return new;
end;$$;
create trigger fleet_da_min_delivery_log after update of assignment_min_deliveries on public.fleet_control_settings for each row when(old.assignment_min_deliveries is distinct from new.assignment_min_deliveries) execute function public.fleet_da_min_delivery_log();

-- Explicit retrospective application is separate from dated defaults and never rewrites manual assignments.
create table public.fleet_da_default_backfills (
 company_id uuid not null references public.companies(id),vehicle_id uuid not null references public.fleet_vehicles(id),station_code text not null,
 effective_from date not null,effective_to date not null,provider_employee_id text not null,name text not null,
 applied_by uuid not null,applied_at timestamptz not null default now(),
 primary key(company_id,vehicle_id,station_code),check(effective_to>effective_from)
);
alter table public.fleet_da_default_backfills enable row level security;
revoke all on public.fleet_da_default_backfills from public,anon,authenticated;
grant select,insert,update on public.fleet_da_default_backfills to service_role;
create function public.fleet_backfill_da_history(p_company uuid,p_actor uuid) returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 if not exists(select 1 from public.profiles where id=p_actor and company_id=p_company) then raise exception 'Invalid actor';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_company::text||'da-history',0));
 insert into public.fleet_da_default_backfills(company_id,vehicle_id,station_code,effective_from,effective_to,provider_employee_id,name,applied_by)
 select h.company_id,h.vehicle_id,h.station_code,min(p.effective_from),h.effective_from,h.provider_employee_id,h.name,p_actor
 from public.fleet_da_default_periods h join public.fleet_da_mapping_periods p on p.company_id=h.company_id and p.vehicle_id=h.vehicle_id and p.station_code=h.station_code and p.eligible and p.effective_from<h.effective_from
 where h.company_id=p_company and not exists(select 1 from public.fleet_da_default_periods old where old.company_id=h.company_id and old.vehicle_id=h.vehicle_id and old.effective_from<h.effective_from)
 group by h.company_id,h.vehicle_id,h.station_code,h.effective_from,h.provider_employee_id,h.name
 on conflict do nothing;
 get diagnostics n=row_count;
 insert into public.fleet_system_logs(company_id,event_kind,entity,entity_id,action,actor_user_id,actor_label,route,before_values,after_values)
 values(p_company,'change','fleet_da_default_backfills',p_company::text,'historical_delivery_review',p_actor,(select full_name from public.profiles where id=p_actor and company_id=p_company),'/api/fleet/da-mapping','{}',jsonb_build_object('backfilled_defaults',n,'minimum_deliveries',(select assignment_min_deliveries from public.fleet_control_settings where company_id=p_company),'manual_assignments_preserved',true));
 return n;
end;$$;
revoke all on function public.fleet_backfill_da_history(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fleet_backfill_da_history(uuid,uuid) to service_role;

create function public.fleet_da_delivery_rows(p_company uuid,p_stations text[],p_from date,p_to date)
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
 where f.company_id=p_company and f.client='Amazon' and f.work_date between p_from and p_to and f.station_code in (select feed from feeds)
), evidence as (
 select d.*,policy.minimum,policy.auto,
 not exists(select 1 from feeds fs where fs.base=d.station_code and (not exists(select 1 from facts f where f.station_code=fs.feed and f.work_date=d.work_date and f.batch_status='Completed') or exists(select 1 from facts f where f.station_code=fs.feed and f.work_date=d.work_date and f.batch_status is distinct from 'Completed')))
 and not exists(select 1 from facts f join feeds fs on fs.feed=f.station_code and fs.base=d.station_code where f.work_date=d.work_date and upper(trim(f.provider_employee_id))=any(d.ids) and f.total_delivery is null) ready,
 not d.manual and exists(select 1 from days other where other.vehicle_id<>d.vehicle_id and other.work_date=d.work_date and not other.no_work and other.ids&&d.ids) conflict,
 (select sum(f.total_delivery) from facts f join feeds fs on fs.feed=f.station_code and fs.base=d.station_code where f.work_date=d.work_date and upper(trim(f.provider_employee_id))=any(d.ids) and f.batch_status='Completed') deliveries,
 (select case when count(*) filter(where f.c_return is null)>0 then null else coalesce(sum(f.c_return),0) end from facts f join feeds fs on fs.feed=f.station_code and fs.base=d.station_code where f.work_date=d.work_date and upper(trim(f.provider_employee_id))=any(d.ids) and f.batch_status='Completed') returns,
 (select case when count(*) filter(where f.swa_delivery is null)>0 then null else coalesce(sum(f.swa_delivery),0) end from facts f join feeds fs on fs.feed=f.station_code and fs.base=d.station_code where f.work_date=d.work_date and upper(trim(f.provider_employee_id))=any(d.ids) and f.batch_status='Completed') sw
 from days d cross join policy where d.station_code=any(p_stations)
)
select vehicle_id,station_code,work_date,snapshot,
 case when no_work then 'saved' when not ready then 'awaiting_data' when conflict then 'pending' when coalesce(deliveries,0)<minimum then 'pending' when manual then 'saved' when auto then 'automatic' else 'pending' end,
 case when no_work then 'Recorded non-operational / no-work day' when not ready then 'Awaiting completed Amazon report for station and linked XPTs' when conflict then 'DA ID conflicts with another vehicle; deliveries are not attributed twice' when ids[1] is null then 'DA ID not mapped' when coalesce(deliveries,0)<minimum then 'Only '||coalesce(deliveries,0)::text||' deliveries; minimum '||minimum::text when manual then 'Saved DA has sufficient deliveries' when auto then 'Default DA has sufficient deliveries' else 'Automatic matching disabled in Fleet Masters' end,
 array_to_string(ids,' / '),names,
 case when ready and not conflict and not no_work then coalesce(deliveries,0) end,
 case when ready and not conflict and not no_work then returns end,
 case when ready and not conflict and not no_work then sw end,origin,minimum from evidence;
$$;
revoke all on function public.fleet_da_delivery_rows(uuid,text[],date,date) from public,anon,authenticated;
grant execute on function public.fleet_da_delivery_rows(uuid,text[],date,date) to service_role;
create or replace function public.fleet_da_day_review(p_company uuid,p_stations text[],p_from date,p_to date)
returns table(vehicle_id uuid,station_code text,work_date date,snapshot jsonb,review_status text,reason text,provider_employee_id text,name text,delivered numeric)
language sql stable security invoker set search_path='' as $$
 select vehicle_id,station_code,work_date,snapshot,review_status,reason,provider_employee_id,name,delivered from public.fleet_da_delivery_rows(p_company,p_stations,p_from,p_to);
$$;

create function public.fleet_da_delivery_report(p_company uuid,p_stations text[],p_from date,p_to date,p_filters jsonb default '{}',p_offset integer default 0,p_limit integer default 50,p_group text default 'vehicle',p_sort text default 'delivered',p_direction text default 'desc')
returns jsonb language sql stable security invoker set search_path='' as $$
with raw as materialized (select * from public.fleet_da_delivery_rows(p_company,p_stations,p_from,p_to)),
filtered as materialized (
 select * from raw r where
 (coalesce(p_filters->>'vehicleId','')='' or r.vehicle_id::text=p_filters->>'vehicleId')
 and (coalesce(jsonb_array_length(p_filters->'sources'),0)=0 or p_filters->'sources' ? coalesce(r.snapshot->>'sourceCode',r.snapshot->>'ownership_type',''))
 and (coalesce(jsonb_array_length(p_filters->'models'),0)=0 or p_filters->'models' ? coalesce(r.snapshot->>'model','Not recorded'))
 and (coalesce(jsonb_array_length(p_filters->'statuses'),0)=0 or p_filters->'statuses' ? case when r.assignment_source='not_required' then 'not_required' else r.review_status end)
 and (coalesce(p_filters->>'query','')='' or lower(concat_ws(' ',r.snapshot->>'vehicle_no',r.snapshot->>'model',r.station_code,r.name,r.provider_employee_id)) like '%'||lower(p_filters->>'query')||'%')
), grouped as materialized (
 select vehicle_id,station_code,case when p_group='day' then work_date end work_date,
 (array_agg(snapshot->>'vehicle_no' order by work_date desc))[1] vehicle_no,(array_agg(snapshot->>'model' order by work_date desc))[1] model,
 string_agg(distinct coalesce(snapshot->>'sourceName',snapshot->>'ownership_type'),' / ') vehicle_source,
 string_agg(distinct name,' / ') da_names,string_agg(distinct nullif(provider_employee_id,''),' / ') da_ids,
 string_agg(distinct assignment_source,', ') assignment_source,
 count(*) days,count(*) filter(where review_status='pending') pending_days,count(*) filter(where review_status='awaiting_data') awaiting_days,
 count(*) filter(where review_status in ('automatic','saved') and assignment_source<>'not_required') accepted_days,
 count(*) filter(where assignment_source='not_required') not_required_days,
 sum(delivered) delivered,sum(c_return) c_return,sum(swa) swa,
 string_agg(distinct reason,'; ') reason,max(minimum_deliveries) minimum_deliveries
 from filtered group by vehicle_id,station_code,case when p_group='day' then work_date end
), numbered as (
 select g.*,row_number() over(order by
 case when p_direction='asc' then case p_sort when 'delivered' then delivered when 'c_return' then c_return when 'swa' then swa when 'pending_days' then pending_days when 'days' then days end end asc nulls last,
 case when p_direction<>'asc' then case p_sort when 'delivered' then delivered when 'c_return' then c_return when 'swa' then swa when 'pending_days' then pending_days when 'days' then days end end desc nulls last,
 case when p_direction='asc' then case p_sort when 'vehicle' then vehicle_no when 'station' then station_code when 'date' then work_date::text end end asc nulls last,
 case when p_direction<>'asc' then case p_sort when 'vehicle' then vehicle_no when 'station' then station_code when 'date' then work_date::text end end desc nulls last,
 vehicle_no,station_code,vehicle_id,work_date) position from grouped g
), page as (select * from numbered order by position offset greatest(p_offset,0) limit least(greatest(p_limit,1),100))
select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(page) order by position) from page),'[]'),
 'total',(select count(*) from grouped),'summary',(select jsonb_build_object('days',count(*),'vehicles',count(distinct vehicle_id),'delivered',sum(delivered),'cReturn',sum(c_return),'swa',sum(swa),'pending',count(*) filter(where review_status='pending'),'awaiting',count(*) filter(where review_status='awaiting_data'),'automatic',count(*) filter(where review_status='automatic'),'accepted',count(*) filter(where review_status in ('automatic','saved') and assignment_source<>'not_required')) from filtered),
 'sources',coalesce((select jsonb_agg(x order by x->>'label') from (select distinct jsonb_build_object('value',coalesce(snapshot->>'sourceCode',snapshot->>'ownership_type',''),'label',coalesce(snapshot->>'sourceName',snapshot->>'ownership_type','Not recorded')) x from raw) v),'[]'),
 'models',coalesce((select jsonb_agg(m order by m) from (select distinct coalesce(snapshot->>'model','Not recorded') m from raw) v),'[]'),
 'trackingFrom',(select min(effective_from) from public.fleet_da_mapping_periods where company_id=p_company and station_code=any(p_stations)),
 'minimumDeliveries',coalesce((select assignment_min_deliveries from public.fleet_control_settings where company_id=p_company),5));
$$;
revoke all on function public.fleet_da_delivery_report(uuid,text[],date,date,jsonb,integer,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.fleet_da_delivery_report(uuid,text[],date,date,jsonb,integer,integer,text,text,text) to service_role;
commit;
