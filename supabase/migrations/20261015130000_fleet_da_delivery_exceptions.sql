begin;
alter table public.fleet_control_settings add column assignment_auto_delivery boolean not null default true;
create function public.fleet_da_review_policy_log() returns trigger language plpgsql set search_path='' as $$
declare ctx jsonb;actor uuid;
begin
 begin ctx:=(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-fleet-audit')::jsonb;actor:=nullif(ctx->>'actorId','')::uuid;exception when others then actor:=null;end;
 if actor is not null and not exists(select 1 from public.profiles where id=actor and company_id=new.company_id) then actor:=null;end if;
 insert into public.fleet_system_logs(company_id,event_kind,entity,entity_id,action,actor_user_id,actor_label,route,before_values,after_values)
 values(new.company_id,'change','fleet_control_settings',new.company_id::text,'update',actor,coalesce((select full_name from public.profiles where id=actor and company_id=new.company_id),'System'),ctx->>'route',jsonb_build_object('assignment_auto_delivery',old.assignment_auto_delivery),jsonb_build_object('assignment_auto_delivery',new.assignment_auto_delivery));
 return new;
end;$$;
create trigger fleet_da_review_policy_log after update of assignment_auto_delivery on public.fleet_control_settings for each row when(old.assignment_auto_delivery is distinct from new.assignment_auto_delivery) execute function public.fleet_da_review_policy_log();
-- Previous-day, evidence-based review. Manual confirmations are never overwritten.
-- A default is effective only from its recorded change date; never apply today's default retrospectively.
create table public.fleet_da_default_periods (
 company_id uuid not null references public.companies(id), vehicle_id uuid not null references public.fleet_vehicles(id),
 effective_from date not null, effective_to date, station_code text not null,
 provider_employee_id text not null, name text not null, updated_by uuid not null,
 primary key(company_id,vehicle_id,effective_from), check(effective_to is null or effective_to>=effective_from)
);
alter table public.fleet_da_default_periods enable row level security;
revoke all on public.fleet_da_default_periods from public,anon,authenticated;
grant select,insert,update,delete on public.fleet_da_default_periods to service_role;
insert into public.fleet_da_default_periods(company_id,vehicle_id,effective_from,station_code,provider_employee_id,name,updated_by)
select company_id,vehicle_id,(updated_at at time zone 'Asia/Kolkata')::date,station_code,upper(trim(provider_employee_id)),name,updated_by from public.fleet_vehicle_da_defaults;
create function public.fleet_capture_da_default_period() returns trigger language plpgsql set search_path='' as $$
declare d date:=(now() at time zone 'Asia/Kolkata')::date;
begin
 if tg_op<>'INSERT' then
  update public.fleet_da_default_periods set effective_to=d where company_id=old.company_id and vehicle_id=old.vehicle_id and effective_to is null;
 end if;
 if tg_op<>'DELETE' then
  insert into public.fleet_da_default_periods(company_id,vehicle_id,effective_from,station_code,provider_employee_id,name,updated_by)
  values(new.company_id,new.vehicle_id,d,new.station_code,upper(trim(new.provider_employee_id)),new.name,new.updated_by)
  on conflict(company_id,vehicle_id,effective_from) do update set effective_to=null,station_code=excluded.station_code,provider_employee_id=excluded.provider_employee_id,name=excluded.name,updated_by=excluded.updated_by;
 end if;
 return coalesce(new,old);
end;$$;
create trigger fleet_capture_da_default_period after insert or update or delete on public.fleet_vehicle_da_defaults for each row execute function public.fleet_capture_da_default_period();

create index fleet_da_default_period_lookup on public.fleet_da_default_periods(company_id,vehicle_id,effective_from,effective_to);
create function public.fleet_da_day_review(p_company uuid,p_stations text[],p_from date,p_to date)
returns table(vehicle_id uuid,station_code text,work_date date,snapshot jsonb,review_status text,reason text,provider_employee_id text,name text,delivered numeric)
language sql stable security invoker set search_path='' as $$
with days as materialized (
 select p.vehicle_id,p.station_code,d::date work_date,p.snapshot,h.provider_employee_id,h.name
 from public.fleet_da_mapping_periods p
 cross join lateral generate_series(greatest(p.effective_from,p_from)::timestamp,least(coalesce(p.effective_to-1,p_to),p_to,(now() at time zone 'Asia/Kolkata')::date-1)::timestamp,interval '1 day') d
 left join public.fleet_da_default_periods h on h.company_id=p.company_id and h.vehicle_id=p.vehicle_id and h.station_code=p.station_code and h.effective_from<=d::date and (h.effective_to is null or h.effective_to>d::date)
 where p.company_id=p_company and p.eligible
), feed_stations as (
 select s.station_code base,s.station_code feed from public.stations s where s.company_id=p_company and s.station_code=any(p_stations)
 union
 select s.station_code,c.station_code from public.stations s join public.stations c on c.parent_station_id=s.id and c.company_id=s.company_id and c.is_active
 join public.location_models m on m.id=c.location_model_id and upper(m.code)='XPT'
 where s.company_id=p_company and s.station_code=any(p_stations)
), facts as materialized (
 select f.*,b.status batch_status from public.cps_shipment_daily f
 left join public.report_import_batches b on b.id=f.source_batch_id and b.company_id=f.company_id and b.source_type='amazon_shipments'
 where f.company_id=p_company and f.client='Amazon' and f.work_date between p_from and p_to
 and f.station_code in (select feed from feed_stations)
), evidence as (
 select d.*,
 exists(select 1 from public.fleet_vehicle_day_confirmations c where c.company_id=p_company and c.vehicle_id=d.vehicle_id and c.work_date=d.work_date) confirmed,
 exists(select 1 from public.fleet_day_assignments a where a.company_id=p_company and a.vehicle_id=d.vehicle_id and a.work_date=d.work_date and a.purpose='delivery' and a.is_active) manual,
 not exists(select 1 from feed_stations fs where fs.base=d.station_code and (
  not exists(select 1 from facts f where f.station_code=fs.feed and f.work_date=d.work_date and f.batch_status='Completed')
  or exists(select 1 from facts f where f.station_code=fs.feed and f.work_date=d.work_date and f.batch_status is distinct from 'Completed')
 )) ready,
 (select sum(f.total_delivery) from facts f join feed_stations fs on fs.feed=f.station_code and fs.base=d.station_code where f.work_date=d.work_date and upper(trim(f.provider_employee_id))=d.provider_employee_id and f.batch_status='Completed') deliveries,
 exists(select 1 from days other where other.vehicle_id<>d.vehicle_id and other.work_date=d.work_date and other.provider_employee_id=d.provider_employee_id) or
 exists(select 1 from public.fleet_day_assignments a where a.company_id=p_company and a.vehicle_id<>d.vehicle_id and a.work_date=d.work_date and a.is_active and a.purpose='delivery' and upper(trim(a.provider_employee_id))=d.provider_employee_id) conflict
 from days d where d.station_code=any(p_stations)
)
select vehicle_id,station_code,work_date,snapshot,
 case when confirmed or manual then 'saved' when not ready then 'awaiting_data' when provider_employee_id is not null and deliveries>0 and not conflict and coalesce((select assignment_auto_delivery from public.fleet_control_settings where company_id=p_company),true) then 'automatic' else 'pending' end,
 case when confirmed or manual then 'Saved mapping retained' when not ready then 'Awaiting completed Amazon report for this station and linked XPTs' when provider_employee_id is null then 'No default DA recorded for this date' when conflict then 'Default DA linked to another vehicle' when deliveries>0 then case when coalesce((select assignment_auto_delivery from public.fleet_control_settings where company_id=p_company),true) then 'Default DA has deliveries' else 'Automatic matching disabled in Fleet Masters' end else 'No deliveries on default DA ID' end,
 provider_employee_id,name,deliveries from evidence;
$$;
revoke all on function public.fleet_da_day_review(uuid,text[],date,date) from public,anon,authenticated;
grant execute on function public.fleet_da_day_review(uuid,text[],date,date) to service_role;
create or replace function public.fleet_pending_da_days(p_company uuid,p_stations text[],p_from date default null,p_to date default null,p_offset integer default 0,p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path='' as $$
 with policy as (
 select coalesce((select assignment_alert_from from public.fleet_control_settings where company_id=p_company),(select min(effective_from) from public.fleet_da_mapping_periods where company_id=p_company)) start_date
 ), reviewed as materialized (
 select r.* from policy cross join lateral public.fleet_da_day_review(p_company,p_stations,greatest(policy.start_date,coalesce(p_from,policy.start_date)),least(coalesce(p_to,(now() at time zone 'Asia/Kolkata')::date-1),(now() at time zone 'Asia/Kolkata')::date-1)) r
 ), pending as materialized (
 select * from reviewed where review_status='pending'
 ), groups as (
 select station_code,work_date,count(*) pending_count,jsonb_agg(jsonb_build_object('id',vehicle_id,'vehicle_no',snapshot->>'vehicle_no','model',snapshot->>'model','station_code',station_code,'status',snapshot->>'status','da_name',snapshot->>'da_name') order by snapshot->>'vehicle_no') vehicles from pending group by station_code,work_date
 ), page as (
 select * from groups order by work_date,station_code offset greatest(p_offset,0) limit least(greatest(p_limit,1),50)
 ) select jsonb_build_object('trackingFrom',(select start_date from policy),'today',(now() at time zone 'Asia/Kolkata')::date,
 'awaitingData',(select count(*) from reviewed where review_status='awaiting_data'),'automatic',(select count(*) from reviewed where review_status='automatic'),'totalGroups',(select count(*) from groups),'totalPending',(select count(*) from pending),'overdue',(select count(*) from pending where work_date<(now() at time zone 'Asia/Kolkata')::date),
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
 if p_date is null or p_date>=(now() at time zone 'Asia/Kolkata')::date or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 200 then raise exception 'Invalid daily confirmation';end if;
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


commit;
