-- Explain pending vehicle-days without altering mapping or delivery evidence.
create or replace function public.fleet_pending_da_days(p_company uuid,p_stations text[],p_from date default null,p_to date default null,p_offset integer default 0,p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path='' as $$
 with policy as (
 select coalesce((select assignment_alert_from from public.fleet_control_settings where company_id=p_company),(select min(effective_from) from public.fleet_da_mapping_periods where company_id=p_company)) start_date
 ), reviewed as materialized (
 select r.* from policy cross join lateral public.fleet_da_delivery_rows(p_company,p_stations,greatest(policy.start_date,coalesce(p_from,policy.start_date)),least(coalesce(p_to,(now() at time zone 'Asia/Kolkata')::date-1),(now() at time zone 'Asia/Kolkata')::date-1)) r
 ), pending as materialized (
 select * from reviewed where review_status='pending'
 ), groups as (
 select station_code,work_date,count(*) pending_count,jsonb_agg(jsonb_build_object('id',vehicle_id,'vehicle_no',snapshot->>'vehicle_no','model',snapshot->>'model','station_code',station_code,'status',snapshot->>'status','da_name',snapshot->>'da_name','reason',reason,'delivered',delivered,'provider_employee_id',provider_employee_id) order by snapshot->>'vehicle_no') vehicles from pending group by station_code,work_date
 ), page as (
 select * from groups order by work_date,station_code offset greatest(p_offset,0) limit least(greatest(p_limit,1),50)
 ) select jsonb_build_object('trackingFrom',(select start_date from policy),'today',(now() at time zone 'Asia/Kolkata')::date,
 'awaitingData',(select count(*) from reviewed where review_status='awaiting_data'),'automatic',(select count(*) from reviewed where review_status='automatic'),'totalGroups',(select count(*) from groups),'totalPending',(select count(*) from pending),'overdue',(select count(*) from pending where work_date<(now() at time zone 'Asia/Kolkata')::date),
 'pendingVehicles',(select count(distinct vehicle_id) from pending),
 'pendingReasons',jsonb_build_object('missingId',(select count(*) from pending where nullif(trim(provider_employee_id),'') is null),'conflict',(select count(*) from pending where reason like 'DA ID conflicts%'),'belowMinimum',(select count(*) from pending where nullif(trim(provider_employee_id),'') is not null and reason not like 'DA ID conflicts%' and delivered<minimum_deliveries)),
 'stationCodes',coalesce((select jsonb_agg(distinct station_code) from public.fleet_da_mapping_periods where company_id=p_company and station_code=any(p_stations) and eligible),'[]'::jsonb),
 'pendingDates',coalesce((select jsonb_agg(jsonb_build_object('date',work_date,'count',n) order by work_date) from (select work_date,count(*) n from pending group by work_date) dates),'[]'::jsonb),
 'rows',coalesce((select jsonb_agg(to_jsonb(page) order by work_date,station_code) from page),'[]'::jsonb));
$$;
revoke all on function public.fleet_pending_da_days(uuid,text[],date,date,integer,integer) from public,anon,authenticated;
grant execute on function public.fleet_pending_da_days(uuid,text[],date,date,integer,integer) to service_role;
