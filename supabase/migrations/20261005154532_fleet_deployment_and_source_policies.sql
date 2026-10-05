-- Source-specific requirements remain configurable in Fleet Masters.
alter table public.document_types add column if not exists fleet_ownership_types text[] not null default array['own','odcd','rented'];
alter table public.fleet_vehicle_status_master add column if not exists ownership_types text[] not null default array['own','odcd','rented'];
alter table public.document_types add constraint fleet_document_sources check (cardinality(fleet_ownership_types)>0 and fleet_ownership_types <@ array['own','odcd','rented']);
alter table public.fleet_vehicle_status_master add constraint fleet_status_sources check (cardinality(ownership_types)>0 and ownership_types <@ array['own','odcd','rented']);
update public.document_types set fleet_ownership_types=array['own'] where document_module='fleet' and upper(code) not in ('FLEET_REGISTRATION','FLEET_INSURANCE','FLEET_PUC');
insert into public.fleet_vehicle_status_master(company_id,status_key,label,helper_text,tone,is_operational,is_terminal,requires_reason,requires_expected_date,sort_order,ownership_types)
select distinct company_id,'on_leave','On Leave','Owner-driver is on leave','info',false,false,false,true,35,array['odcd'] from public.fleet_vehicle_status_master
on conflict(company_id,status_key) do nothing;

alter table public.fleet_vehicles add column deployment_date date;
update public.fleet_vehicles v set deployment_date=coalesce((select min(p.effective_from) from public.fleet_vehicle_cost_placements p where p.company_id=v.company_id and p.vehicle_id=v.id),(v.created_at at time zone 'Asia/Kolkata')::date,(now() at time zone 'Asia/Kolkata')::date);
alter table public.fleet_vehicles alter column deployment_date set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.fleet_vehicles alter column deployment_date set not null;

-- Correct only the first recorded interval; subsequent transfers and rent changes remain intact.
create or replace function public.fleet_validate_deployment() returns trigger
language plpgsql set search_path='' as $$
declare first_end date; scope text[];
begin
 if new.deployment_date>(now() at time zone 'Asia/Kolkata')::date then raise exception 'Deployment date cannot be in the future'; end if;
 if tg_op='UPDATE' and new.deployment_date is distinct from old.deployment_date then
  select effective_to into first_end from public.fleet_vehicle_cost_placements where company_id=new.company_id and vehicle_id=new.id order by effective_from limit 1;
  if first_end is not null and new.deployment_date>first_end then raise exception 'Deployment date must precede the first recorded transfer'; end if;
  select effective_to into first_end from public.fleet_vehicle_rent_rates where company_id=new.company_id and vehicle_id=new.id order by effective_from limit 1;
  if first_end is not null and new.deployment_date>first_end then raise exception 'Deployment date must precede the first rent change'; end if;
 end if;
 if tg_op='INSERT' or new.status is distinct from old.status or new.ownership_type is distinct from old.ownership_type then
  select ownership_types into scope from public.fleet_vehicle_status_master where company_id=new.company_id and status_key=new.status and is_active;
  if scope is not null and not (case when new.ownership_type='leased' then 'rented' else coalesce(new.ownership_type,'own') end=any(scope)) then raise exception 'This status is not available for this vehicle source'; end if;
 end if;
 return new;
end; $$;
create trigger fleet_validate_deployment before insert or update on public.fleet_vehicles for each row execute function public.fleet_validate_deployment();

create or replace function public.fleet_correct_deployment() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.deployment_date is not distinct from old.deployment_date then return new; end if;
 update public.fleet_vehicle_cost_placements set effective_from=new.deployment_date,recorded_at=now()
 where id=(select id from public.fleet_vehicle_cost_placements where company_id=new.company_id and vehicle_id=new.id order by effective_from limit 1);
 update public.fleet_vehicle_rent_rates set effective_from=new.deployment_date,updated_at=now(),reason='Deployment start date corrected in Fleet'
 where id=(select id from public.fleet_vehicle_rent_rates where company_id=new.company_id and vehicle_id=new.id order by effective_from limit 1);
 return new;
end; $$;
create trigger fleet_correct_deployment after update of deployment_date on public.fleet_vehicles for each row execute function public.fleet_correct_deployment();
revoke all on function public.fleet_validate_deployment(),public.fleet_correct_deployment() from public,anon,authenticated;
grant execute on function public.fleet_validate_deployment(),public.fleet_correct_deployment() to service_role;

CREATE OR REPLACE FUNCTION public.fleet_record_cps_placement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare d date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if tg_op='INSERT' then d:=new.deployment_date; end if;
  if tg_op='UPDATE' and row(new.station_code,new.ownership_type,new.deployment_status,new.status)
    is not distinct from row(old.station_code,old.ownership_type,old.deployment_status,old.status) then return new; end if;
  update public.fleet_vehicle_cost_placements set effective_to=d-1
    where company_id=new.company_id and vehicle_id=new.id and effective_from<d and effective_to is null;
  insert into public.fleet_vehicle_cost_placements(company_id,vehicle_id,station_code,ownership_type,deployed,effective_from)
  values(new.company_id,new.id,upper(trim(coalesce(new.station_code,''))),lower(coalesce(new.ownership_type,'own')),
    coalesce(new.deployment_status,'deployed')='deployed' and not exists(
      select 1 from public.fleet_vehicle_status_master s where s.company_id=new.company_id and s.status_key=new.status and s.is_terminal),d)
  on conflict(company_id,vehicle_id,effective_from) do update set station_code=excluded.station_code,
    ownership_type=excluded.ownership_type,deployed=excluded.deployed,recorded_at=now();
  return new;
end; $function$;


create or replace function public.fleet_sync_vehicle_rent() returns trigger
language plpgsql set search_path = '' as $$
declare current_rate public.fleet_vehicle_rent_rates%rowtype;
  effective_day date := (now() at time zone 'Asia/Kolkata')::date;
  next_day date;
  monthly numeric := case when new.rent_period='monthly' then new.rent_amount end;
  daily numeric := case when new.rent_period='daily' then new.rent_amount end;
begin
  if tg_op='INSERT' or not exists(select 1 from public.fleet_vehicle_rent_rates where company_id=new.company_id and vehicle_id=new.id) then effective_day:=new.deployment_date; end if;
  if tg_op='UPDATE' and new.rent_amount is not distinct from old.rent_amount
    and new.rent_period is not distinct from old.rent_period then return new; end if;
  select * into current_rate from public.fleet_vehicle_rent_rates
    where company_id=new.company_id and vehicle_id=new.id and effective_from<=effective_day
      and coalesce(effective_to,effective_day)>=effective_day order by effective_from desc limit 1;
  if found and current_rate.monthly_rent is not distinct from monthly
    and current_rate.daily_rent is not distinct from daily then return new; end if;
  if current_rate.id is null and monthly is null and daily is null then return new; end if;
  select min(effective_from) into next_day from public.fleet_vehicle_rent_rates
    where company_id=new.company_id and vehicle_id=new.id and effective_from>effective_day;
  update public.fleet_vehicle_rent_rates set effective_to=effective_day-1
    where company_id=new.company_id and vehicle_id=new.id and effective_from<effective_day
      and coalesce(effective_to,effective_day)>=effective_day;
  insert into public.fleet_vehicle_rent_rates(company_id,vehicle_id,monthly_rent,daily_rent,effective_from,effective_to,reason)
    values(new.company_id,new.id,monthly,daily,effective_day,next_day-1,'Vehicle rent updated in Fleet')
    on conflict(company_id,vehicle_id,effective_from) do update set
      monthly_rent=excluded.monthly_rent,daily_rent=excluded.daily_rent,reason=excluded.reason,updated_at=now();
  return new;
end; $$;

create or replace function public.fleet_vehicle_rent_daily(p_company uuid,p_from date,p_through date,p_stations text[])
returns table(vehicle_id uuid,vehicle_no text,model text,station_code text,work_date date,
  monthly_rent numeric,daily_rent numeric,amount numeric,updated_at timestamptz)
language sql stable set search_path='' as $$
  select v.id,v.vehicle_no,v.model,p.station_code,d::date,r.monthly_rent,r.daily_rent,
    case when r.daily_rent is not null then r.daily_rent
      when r.monthly_rent is not null then
        round(r.monthly_rent*extract(day from d)/extract(day from (date_trunc('month',d)+interval '1 month - 1 day')),2)
        -round(r.monthly_rent*(extract(day from d)-1)/extract(day from (date_trunc('month',d)+interval '1 month - 1 day')),2)
    end,r.updated_at
  from public.fleet_vehicle_cost_placements p
  join public.fleet_vehicles v on v.company_id=p.company_id and v.id=p.vehicle_id
  join public.stations s on s.company_id=p.company_id and s.station_code=p.station_code
    and s.is_active and not coalesce(s.hide_from_location_list,false)
  cross join lateral generate_series(greatest(p_from,p.effective_from,v.deployment_date),least(p_through,coalesce(p.effective_to,p_through)),interval '1 day') d
  left join lateral(select * from public.fleet_vehicle_rent_rates r
    where r.company_id=p.company_id and r.vehicle_id=p.vehicle_id
      and r.effective_from<=d::date and coalesce(r.effective_to,d::date)>=d::date
    order by r.effective_from desc limit 1) r on true
  where p.company_id=p_company and (p_stations is null or p.station_code=any(p_stations))
    and p.deployed and p.ownership_type in ('own','rented','leased','odcd');
$$;
revoke all on function public.fleet_vehicle_rent_daily(uuid,date,date,text[]) from public,anon,authenticated;
grant execute on function public.fleet_vehicle_rent_daily(uuid,date,date,text[]) to service_role;

