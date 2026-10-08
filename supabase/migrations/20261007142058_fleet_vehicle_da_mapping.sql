-- Defaults are suggestions; confirmed assignments retain their own immutable day/station/ID.
create table public.fleet_vehicle_da_defaults (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 vehicle_id uuid not null references public.fleet_vehicles(id), vehicle_no text not null,
 station_code text not null, provider_employee_id text not null check(length(trim(provider_employee_id)) between 1 and 160),
 name text not null check(length(name) between 1 and 160),
 created_by uuid not null, updated_by uuid not null, updated_at timestamptz not null default now(),
 unique(company_id,vehicle_id)
);
alter table public.fleet_vehicle_da_defaults enable row level security;
revoke all on public.fleet_vehicle_da_defaults from public,anon,authenticated;
grant select,insert,update,delete on public.fleet_vehicle_da_defaults to service_role;
create trigger fleet_system_audit after insert or update or delete on public.fleet_vehicle_da_defaults for each row execute function public.fleet_system_change_log();
alter table public.fleet_control_settings add column assignment_recent_days integer not null default 7 check(assignment_recent_days between 3 and 30);

create table public.fleet_vehicle_day_confirmations (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),
 vehicle_id uuid not null references public.fleet_vehicles(id),vehicle_no text not null,station_code text not null,
 work_date date not null,remarks text not null default '',updated_by uuid not null,updated_at timestamptz not null default now(),
 unique(company_id,vehicle_id,work_date)
);
alter table public.fleet_vehicle_day_confirmations enable row level security;
revoke all on public.fleet_vehicle_day_confirmations from public,anon,authenticated;
grant select,insert,update on public.fleet_vehicle_day_confirmations to service_role;
create trigger fleet_system_audit after insert or update on public.fleet_vehicle_day_confirmations for each row execute function public.fleet_system_change_log();

-- All selected vehicles commit together. Optimistic identity checks reject stale screens.
create function public.fleet_confirm_da_day(p_company uuid,p_actor uuid,p_date date,p_rows jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare r jsonb; a jsonb; v public.fleet_vehicles%rowtype; actual jsonb; revision timestamptz; n integer:=0;
begin
 if p_date is null or p_date>(now() at time zone 'Asia/Kolkata')::date or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 200 then raise exception 'Invalid daily confirmation';end if;
 if not exists(select 1 from public.profiles where id=p_actor and company_id=p_company) then raise exception 'Invalid actor';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_company::text||p_date::text,0));
 if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct x->>'vehicle_id') from jsonb_array_elements(p_rows) x) then raise exception 'Duplicate vehicle';end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  select * into v from public.fleet_vehicles where id=(r->>'vehicle_id')::uuid and company_id=p_company for update;
  if not found or v.station_code is distinct from r->>'station_code' or v.status in ('sold','disposed','returned') then raise exception 'Vehicle placement changed; refresh';end if;
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
   values(p_company,v.id,v.vehicle_no,v.station_code,p_date,upper(trim(a->>'provider_id')),a->>'name','shipment','delivery',left(coalesce(r->>'remarks',''),1000),p_actor,p_actor);
  end loop;
  insert into public.fleet_vehicle_day_confirmations(company_id,vehicle_id,vehicle_no,station_code,work_date,remarks,updated_by)
  values(p_company,v.id,v.vehicle_no,v.station_code,p_date,left(coalesce(r->>'remarks',''),1000),p_actor)
  on conflict(company_id,vehicle_id,work_date) do update set remarks=excluded.remarks,updated_by=p_actor,updated_at=now();
  n:=n+1;
 end loop;
 return n;
end;$$;
revoke all on function public.fleet_confirm_da_day(uuid,uuid,date,jsonb) from public,anon,authenticated;
grant execute on function public.fleet_confirm_da_day(uuid,uuid,date,jsonb) to service_role;
create function public.fleet_da_default_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from public.fleet_vehicles where id=new.vehicle_id and company_id=new.company_id and vehicle_no=new.vehicle_no and station_code=new.station_code) then raise exception 'Default vehicle placement mismatch';end if;
 if not exists(select 1 from public.profiles where id=new.updated_by and company_id=new.company_id) then raise exception 'Invalid default actor';end if;
 return new;
end;$$;
create trigger fleet_da_default_guard before insert or update on public.fleet_vehicle_da_defaults for each row execute function public.fleet_da_default_guard();
create function public.fleet_da_policy_log() returns trigger language plpgsql security invoker set search_path='' as $$
declare ctx jsonb; actor uuid;
begin
 begin ctx:=(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-fleet-audit')::jsonb;actor:=nullif(ctx->>'actorId','')::uuid;exception when others then actor:=null;end;
 if actor is not null and not exists(select 1 from public.profiles where id=actor and company_id=new.company_id) then actor:=null;end if;
 insert into public.fleet_system_logs(company_id,event_kind,entity,entity_id,action,actor_user_id,actor_label,route,before_values,after_values)
 values(new.company_id,'change','fleet_control_settings',new.company_id::text,'update',actor,coalesce((select full_name from public.profiles where id=actor and company_id=new.company_id),'System'),ctx->>'route',jsonb_build_object('assignment_recent_days',old.assignment_recent_days),jsonb_build_object('assignment_recent_days',new.assignment_recent_days));
 return new;
end;$$;
create trigger fleet_da_policy_log after update of assignment_recent_days on public.fleet_control_settings for each row when(old.assignment_recent_days is distinct from new.assignment_recent_days) execute function public.fleet_da_policy_log();
