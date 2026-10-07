-- Dated availability correction; never rewrites the current Fleet vehicle status.
alter table public.fleet_vehicle_day_confirmations add column day_status text, add column day_status_label text;
create or replace function public.fleet_pending_da_days(p_company uuid,p_stations text[],p_from date default null,p_to date default null,p_offset integer default 0,p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path='' as $$
 with policy as (
 select coalesce((select assignment_alert_from from public.fleet_control_settings where company_id=p_company),(select min(effective_from) from public.fleet_da_mapping_periods where company_id=p_company)) start_date
 ), pending as materialized (
 select p.station_code,day::date work_date,p.vehicle_id,p.snapshot
 from public.fleet_da_mapping_periods p cross join policy
 cross join lateral generate_series(greatest(p.effective_from,policy.start_date,coalesce(p_from,policy.start_date))::timestamp,
 least(coalesce(p.effective_to-1,(now() at time zone 'Asia/Kolkata')::date),coalesce(p_to,(now() at time zone 'Asia/Kolkata')::date),(now() at time zone 'Asia/Kolkata')::date)::timestamp,interval '1 day') day
 where p.company_id=p_company and p.station_code=any(p_stations) and p.eligible
 and not exists(select 1 from public.fleet_vehicle_day_confirmations c where c.company_id=p_company and c.vehicle_id=p.vehicle_id and c.work_date=day::date)
 ), groups as (
 select station_code,work_date,count(*) pending_count,jsonb_agg(jsonb_build_object('id',vehicle_id,'vehicle_no',snapshot->>'vehicle_no','model',snapshot->>'model','station_code',station_code,'status',snapshot->>'status','da_name',snapshot->>'da_name') order by snapshot->>'vehicle_no') vehicles from pending group by station_code,work_date
 ), page as (
 select * from groups order by work_date,station_code offset greatest(p_offset,0) limit least(greatest(p_limit,1),50)
 ) select jsonb_build_object('trackingFrom',(select start_date from policy),'today',(now() at time zone 'Asia/Kolkata')::date,
 'totalGroups',(select count(*) from groups),'totalPending',(select count(*) from pending),'overdue',(select count(*) from pending where work_date<(now() at time zone 'Asia/Kolkata')::date),
 'stationCodes',coalesce((select jsonb_agg(distinct station_code) from public.fleet_da_mapping_periods where company_id=p_company and station_code=any(p_stations) and eligible),'[]'::jsonb),
 'pendingDates',coalesce((select jsonb_agg(jsonb_build_object('date',work_date,'count',n) order by work_date) from (select work_date,count(*) n from pending group by work_date) dates),'[]'::jsonb),
 'rows',coalesce((select jsonb_agg(to_jsonb(page) order by work_date,station_code) from page),'[]'::jsonb));
$$;
revoke all on function public.fleet_pending_da_days(uuid,text[],date,date,integer,integer) from public,anon,authenticated;
grant execute on function public.fleet_pending_da_days(uuid,text[],date,date,integer,integer) to service_role;
create or replace function public.fleet_confirm_da_day(p_company uuid,p_actor uuid,p_date date,p_rows jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare r jsonb; a jsonb; v public.fleet_vehicles%rowtype; actual jsonb; revision timestamptz; n integer:=0; day_label text;
begin
 if p_date is null or p_date>(now() at time zone 'Asia/Kolkata')::date or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 200 then raise exception 'Invalid daily confirmation';end if;
 if not exists(select 1 from public.profiles where id=p_actor and company_id=p_company) then raise exception 'Invalid actor';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_company::text||p_date::text,0));
 if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct x->>'vehicle_id') from jsonb_array_elements(p_rows) x) then raise exception 'Duplicate vehicle';end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  select * into v from public.fleet_vehicles where id=(r->>'vehicle_id')::uuid and company_id=p_company for update;
  if not found or not (exists(select 1 from public.fleet_da_mapping_periods p where p.company_id=p_company and p.vehicle_id=v.id and p.station_code=r->>'station_code' and p.eligible and p.effective_from<=p_date and (p.effective_to is null or p.effective_to>p_date)) or (v.station_code=r->>'station_code' and v.status not in ('sold','disposed','returned') and (p_date=(now() at time zone 'Asia/Kolkata')::date or p_date<(select min(effective_from) from public.fleet_da_mapping_periods where company_id=p_company)))) then raise exception 'Vehicle placement changed; refresh';end if;
  select coalesce(jsonb_agg(id::text order by id::text),'[]') into actual from public.fleet_day_assignments where company_id=p_company and vehicle_id=v.id and work_date=p_date and purpose='delivery' and is_active;
  select updated_at into revision from public.fleet_vehicle_day_confirmations where company_id=p_company and vehicle_id=v.id and work_date=p_date;
  if revision is distinct from (r->>'expected_revision')::timestamptz then raise exception 'Confirmation changed; refresh before saving';end if;
  if actual is distinct from r->'expected_ids' then raise exception 'Assignments changed; refresh before saving';end if;
  if r->'associates' is null or jsonb_typeof(r->'associates')<>'array' or jsonb_array_length(r->'associates')>10 then raise exception 'Invalid associates';end if;
  if nullif(r->>'day_status','') is not null then
   if jsonb_array_length(r->'associates')<>0 or length(trim(coalesce(r->>'remarks','')))<3 then raise exception 'Unavailable day needs a reason and no associates';end if;
   if not exists(select 1 from public.fleet_vehicle_status_master where company_id=p_company and status_key=r->>'day_status' and is_active and not is_operational and status_key not in ('sold','disposed','returned')) then raise exception 'Unavailable day status is not configured';end if;
  end if;
 end loop;
 -- Release selected mappings first so an explicitly selected pair of vans can swap riders atomically.
 update public.fleet_day_assignments set is_active=false,updated_by=p_actor,updated_at=now()
 where company_id=p_company and work_date=p_date and purpose='delivery' and is_active and vehicle_id in (select (x->>'vehicle_id')::uuid from jsonb_array_elements(p_rows) x);
 for r in select value from jsonb_array_elements(p_rows) loop
  select * into v from public.fleet_vehicles where id=(r->>'vehicle_id')::uuid and company_id=p_company;
  for a in select value from jsonb_array_elements(r->'associates') loop
   if nullif(trim(a->>'provider_id'),'') is null or nullif(trim(a->>'name'),'') is null then raise exception 'Associate ID and name required';end if;
   insert into public.fleet_day_assignments(company_id,vehicle_id,vehicle_no,station_code,work_date,provider_employee_id,name,source,purpose,remarks,created_by,updated_by)
   values(p_company,v.id,v.vehicle_no,r->>'station_code',p_date,upper(trim(a->>'provider_id')),a->>'name','shipment','delivery',left(coalesce(r->>'remarks',''),1000),p_actor,p_actor);
  end loop;
  select label into day_label from public.fleet_vehicle_status_master where company_id=p_company and status_key=nullif(r->>'day_status','');
  insert into public.fleet_vehicle_day_confirmations(company_id,vehicle_id,vehicle_no,station_code,work_date,remarks,updated_by,day_status,day_status_label)
  values(p_company,v.id,v.vehicle_no,r->>'station_code',p_date,left(coalesce(r->>'remarks',''),1000),p_actor,nullif(r->>'day_status',''),day_label)
  on conflict(company_id,vehicle_id,work_date) do update set remarks=excluded.remarks,day_status=excluded.day_status,day_status_label=excluded.day_status_label,updated_by=p_actor,updated_at=now();
  n:=n+1;
 end loop;
 return n;
end;$$;
revoke all on function public.fleet_confirm_da_day(uuid,uuid,date,jsonb) from public,anon,authenticated;
grant execute on function public.fleet_confirm_da_day(uuid,uuid,date,jsonb) to service_role;

