-- Recorded daily eligibility prevents later transfers/status changes rewriting old obligations.
alter table public.fleet_control_settings add column assignment_alert_from date not null default (now() at time zone 'Asia/Kolkata')::date;
create table public.fleet_da_mapping_periods (
 company_id uuid not null references public.companies(id),
 vehicle_id uuid not null references public.fleet_vehicles(id),
 effective_from date not null, effective_to date,
 station_code text not null, eligible boolean not null, snapshot jsonb not null,
 recorded_at timestamptz not null default now(),
 primary key(company_id,vehicle_id,effective_from),
 check(effective_to is null or effective_to>=effective_from)
);
create index fleet_da_mapping_period_station_idx on public.fleet_da_mapping_periods(company_id,station_code,effective_from,effective_to) where eligible;
alter table public.fleet_da_mapping_periods enable row level security;
revoke all on public.fleet_da_mapping_periods from public,anon,authenticated;
grant select,insert,update on public.fleet_da_mapping_periods to service_role;

create function public.fleet_record_da_mapping_period(p_vehicle uuid) returns void language plpgsql security invoker set search_path='' as $$
declare v public.fleet_vehicles%rowtype; d date:=(now() at time zone 'Asia/Kolkata')::date; ok boolean; code text; label text; shot jsonb; prev public.fleet_da_mapping_periods%rowtype;
begin
 select * into v from public.fleet_vehicles where id=p_vehicle;
 if not found then return; end if;
 select coalesce(ds.code,s.ownership_type),coalesce(ds.name,s.ownership_type) into code,label
 from public.fleet_vehicle_sources s left join public.designations ds on ds.id=s.designation_id and ds.company_id=s.company_id where s.id=v.source_id and s.company_id=v.company_id;
 code:=coalesce(code,v.ownership_type); label:=coalesce(label,v.ownership_type);
 ok:=coalesce((select is_active and is_operational from public.fleet_vehicle_status_master where company_id=v.company_id and status_key=v.status),v.status='active')
 and coalesce(v.deployment_status,'deployed')='deployed' and nullif(v.station_code,'') is not null
 and upper(code) not in ('VNV','VAN_VENDOR','VENDOR');
 shot:=jsonb_build_object('id',v.id,'vehicle_no',v.vehicle_no,'station_code',v.station_code,'model',v.model,'status',v.status,'ownership_type',v.ownership_type,'source_id',v.source_id,'sourceCode',code,'sourceName',label,'da_name',v.da_name,'vendor_name',v.vendor_name);
 select * into prev from public.fleet_da_mapping_periods where company_id=v.company_id and vehicle_id=v.id and effective_to is null order by effective_from desc limit 1;
 if found and prev.eligible=ok and prev.snapshot=shot then return; end if;
 update public.fleet_da_mapping_periods set effective_to=d where company_id=v.company_id and vehicle_id=v.id and effective_to is null and effective_from<d;
 insert into public.fleet_da_mapping_periods(company_id,vehicle_id,effective_from,station_code,eligible,snapshot)
 values(v.company_id,v.id,d,coalesce(v.station_code,''),ok,shot)
 on conflict(company_id,vehicle_id,effective_from) do update set station_code=excluded.station_code,eligible=excluded.eligible,snapshot=excluded.snapshot,effective_to=null,recorded_at=now();
end;$$;
revoke all on function public.fleet_record_da_mapping_period(uuid) from public,anon,authenticated;
grant execute on function public.fleet_record_da_mapping_period(uuid) to service_role;
create function public.fleet_da_mapping_period_trigger() returns trigger language plpgsql security invoker set search_path='' as $$
declare vid uuid;
begin
 if tg_table_name='fleet_vehicles' then perform public.fleet_record_da_mapping_period(new.id);
 else
  for vid in select id from public.fleet_vehicles where company_id=coalesce(new.company_id,old.company_id) loop perform public.fleet_record_da_mapping_period(vid); end loop;
 end if;
 return coalesce(new,old);
end;$$;
revoke all on function public.fleet_da_mapping_period_trigger() from public,anon,authenticated;
grant execute on function public.fleet_da_mapping_period_trigger() to service_role;
create trigger fleet_da_mapping_period after insert or update of station_code,status,deployment_status,source_id,ownership_type,vehicle_no,model,da_name,vendor_name on public.fleet_vehicles for each row execute function public.fleet_da_mapping_period_trigger();
create trigger fleet_da_mapping_status_period after insert or update or delete on public.fleet_vehicle_status_master for each row execute function public.fleet_da_mapping_period_trigger();
create trigger fleet_da_mapping_source_period after insert or update or delete on public.fleet_vehicle_sources for each row execute function public.fleet_da_mapping_period_trigger();
create trigger fleet_da_mapping_designation_period after update of code,name on public.designations for each row execute function public.fleet_da_mapping_period_trigger();
select public.fleet_record_da_mapping_period(id) from public.fleet_vehicles;

-- A read-only function: a new IST day produces new pending work without cron, email or writes.
create function public.fleet_pending_da_days(p_company uuid,p_stations text[],p_from date default null,p_to date default null,p_offset integer default 0,p_limit integer default 20)
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
 select station_code,work_date,count(*) pending_count from pending group by station_code,work_date
 ), page as (
 select * from groups order by work_date,station_code offset greatest(p_offset,0) limit least(greatest(p_limit,1),50)
 ) select jsonb_build_object('trackingFrom',(select start_date from policy),'today',(now() at time zone 'Asia/Kolkata')::date,
 'totalGroups',(select count(*) from groups),'totalPending',(select count(*) from pending),'overdue',(select count(*) from pending where work_date<(now() at time zone 'Asia/Kolkata')::date),
 'stationCodes',coalesce((select jsonb_agg(distinct station_code) from public.fleet_da_mapping_periods where company_id=p_company and station_code=any(p_stations) and eligible),'[]'::jsonb),
 'rows',coalesce((select jsonb_agg(to_jsonb(page) order by work_date,station_code) from page),'[]'::jsonb));
$$;
revoke all on function public.fleet_pending_da_days(uuid,text[],date,date,integer,integer) from public,anon,authenticated;
grant execute on function public.fleet_pending_da_days(uuid,text[],date,date,integer,integer) to service_role;
create or replace function public.fleet_confirm_da_day(p_company uuid,p_actor uuid,p_date date,p_rows jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare r jsonb; a jsonb; v public.fleet_vehicles%rowtype; actual jsonb; revision timestamptz; n integer:=0;
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
  insert into public.fleet_vehicle_day_confirmations(company_id,vehicle_id,vehicle_no,station_code,work_date,remarks,updated_by)
  values(p_company,v.id,v.vehicle_no,r->>'station_code',p_date,left(coalesce(r->>'remarks',''),1000),p_actor)
  on conflict(company_id,vehicle_id,work_date) do update set remarks=excluded.remarks,updated_by=p_actor,updated_at=now();
  n:=n+1;
 end loop;
 return n;
end;$$;
revoke all on function public.fleet_confirm_da_day(uuid,uuid,date,jsonb) from public,anon,authenticated;
grant execute on function public.fleet_confirm_da_day(uuid,uuid,date,jsonb) to service_role;

create function public.fleet_da_alert_policy_log() returns trigger language plpgsql security invoker set search_path='' as $$
declare ctx jsonb; actor uuid;
begin
 begin ctx:=(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-fleet-audit')::jsonb;actor:=nullif(ctx->>'actorId','')::uuid;exception when others then actor:=null;end;
 if actor is not null and not exists(select 1 from public.profiles where id=actor and company_id=new.company_id) then actor:=null;end if;
 insert into public.fleet_system_logs(company_id,event_kind,entity,entity_id,action,actor_user_id,actor_label,route,before_values,after_values)
 values(new.company_id,'change','fleet_control_settings',new.company_id::text,'update',actor,coalesce((select full_name from public.profiles where id=actor and company_id=new.company_id),'System'),ctx->>'route',jsonb_build_object('assignment_alert_from',old.assignment_alert_from),jsonb_build_object('assignment_alert_from',new.assignment_alert_from));
 return new;
end;$$;
revoke all on function public.fleet_da_alert_policy_log() from public,anon,authenticated;
grant execute on function public.fleet_da_alert_policy_log() to service_role;
create trigger fleet_da_alert_policy_log after update of assignment_alert_from on public.fleet_control_settings for each row when(old.assignment_alert_from is distinct from new.assignment_alert_from) execute function public.fleet_da_alert_policy_log();
