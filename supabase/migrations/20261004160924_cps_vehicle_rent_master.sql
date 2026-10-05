-- Dated vehicle rates and deployment snapshots. No model prices in the CPS engine.
create table public.fleet_vehicle_rent_rates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  vehicle_id uuid not null references public.fleet_vehicles(id),
  monthly_rent numeric(12,2) not null check(monthly_rent >= 0),
  effective_from date not null,
  effective_to date check(effective_to >= effective_from),
  reason text not null check(length(trim(reason)) between 3 and 500),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique(company_id,vehicle_id,effective_from)
);
create index fleet_vehicle_rent_period on public.fleet_vehicle_rent_rates(company_id,vehicle_id,effective_from,effective_to);
alter table public.fleet_vehicle_rent_rates enable row level security;
revoke all on public.fleet_vehicle_rent_rates from anon, authenticated;
grant all on public.fleet_vehicle_rent_rates to service_role;

create table public.fleet_vehicle_cost_placements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  vehicle_id uuid not null references public.fleet_vehicles(id),
  station_code text not null,
  ownership_type text not null,
  deployed boolean not null,
  effective_from date not null,
  effective_to date check(effective_to >= effective_from),
  recorded_at timestamptz not null default now(),
  unique(company_id,vehicle_id,effective_from)
);
create index fleet_vehicle_cost_placement_period on public.fleet_vehicle_cost_placements(company_id,station_code,effective_from,effective_to);
alter table public.fleet_vehicle_cost_placements enable row level security;
revoke all on public.fleet_vehicle_cost_placements from anon, authenticated;
grant all on public.fleet_vehicle_cost_placements to service_role;

-- Initial rates authorized for DropX's existing own fleet, from 1 September 2026 as requested.
-- Unspecified models remain unset and visible as a CPS configuration gap.
insert into public.fleet_vehicle_rent_rates(company_id,vehicle_id,monthly_rent,effective_from,reason)
select v.company_id,v.id,
  case when v.model ~* 'mahindra.*(jeeto|jito)' then 15000 else 12000 end,
  greatest(date '2026-09-01',v.created_at::date),
  'Initial own-vehicle rent configured for CPS'
from public.fleet_vehicles v join public.companies c on c.id=v.company_id
where upper(c.name)='DROPX LOGISTICS' and lower(coalesce(v.ownership_type,'own'))='own'
  and (v.model ~* 'mahindra.*(jeeto|jito)|piaggio.*ape' or upper(v.fuel_type) in ('EV','ELECTRIC'));

insert into public.fleet_vehicle_cost_placements(company_id,vehicle_id,station_code,ownership_type,deployed,effective_from)
select v.company_id,v.id,upper(trim(coalesce(v.station_code,''))),lower(coalesce(v.ownership_type,'own')),
  coalesce(v.deployment_status,'deployed')='deployed' and not exists(
    select 1 from public.fleet_vehicle_status_master s where s.company_id=v.company_id and s.status_key=v.status and s.is_terminal),
  greatest(date '2026-09-01',v.created_at::date)
from public.fleet_vehicles v join public.companies c on c.id=v.company_id
where upper(c.name)='DROPX LOGISTICS';

create function public.fleet_record_cps_placement() returns trigger
language plpgsql security invoker set search_path='' as $$
declare d date := (now() at time zone 'Asia/Kolkata')::date;
begin
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
end; $$;
revoke all on function public.fleet_record_cps_placement() from public,anon,authenticated;
create trigger fleet_vehicle_cps_placement after insert or update on public.fleet_vehicles
for each row execute function public.fleet_record_cps_placement();

create table public.fleet_vehicle_rent_changes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  vehicle_id uuid not null references public.fleet_vehicles(id),
  effective_from date not null,
  monthly_rent numeric(12,2) not null,
  previous_rates jsonb not null,
  reason text not null,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
alter table public.fleet_vehicle_rent_changes enable row level security;
revoke all on public.fleet_vehicle_rent_changes from anon,authenticated;
grant select,insert on public.fleet_vehicle_rent_changes to service_role;

-- Atomic revisions keep the old rate up to the day before the new one. The
-- vehicle lock also serializes simultaneous edits and prevents overlapping rates.
create function public.fleet_save_vehicle_rent(p_company uuid,p_vehicle uuid,p_amount numeric,p_from date,p_reason text,p_actor uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_id uuid; next_date date;
begin
  if p_amount is null or p_amount<0 or p_amount>9999999 or p_amount<>round(p_amount,2) or p_from is null
    or length(trim(coalesce(p_reason,''))) not between 3 and 500 then raise exception 'Enter a valid monthly rent, effective date and reason'; end if;
  perform 1 from public.fleet_vehicles where company_id=p_company and id=p_vehicle for update;
  if not found then raise exception 'Vehicle not found in this company'; end if;
  insert into public.fleet_vehicle_rent_changes(company_id,vehicle_id,effective_from,monthly_rent,previous_rates,reason,changed_by)
  select p_company,p_vehicle,p_from,p_amount,coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb),trim(p_reason),p_actor
  from public.fleet_vehicle_rent_rates r where r.company_id=p_company and r.vehicle_id=p_vehicle;
  select min(effective_from) into next_date from public.fleet_vehicle_rent_rates
    where company_id=p_company and vehicle_id=p_vehicle and effective_from>p_from;
  update public.fleet_vehicle_rent_rates set effective_to=p_from-1
    where company_id=p_company and vehicle_id=p_vehicle and effective_from<p_from and coalesce(effective_to,p_from)>=p_from;
  insert into public.fleet_vehicle_rent_rates(company_id,vehicle_id,monthly_rent,effective_from,effective_to,reason,updated_by)
  values(p_company,p_vehicle,p_amount,p_from,next_date-1,trim(p_reason),p_actor)
  on conflict(company_id,vehicle_id,effective_from) do update set monthly_rent=excluded.monthly_rent,
    reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now()
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.fleet_save_vehicle_rent(uuid,uuid,numeric,date,text,uuid) from public,anon,authenticated;
grant execute on function public.fleet_save_vehicle_rent(uuid,uuid,numeric,date,text,uuid) to service_role;

create function public.ops_cps_vehicle_costs(p_company uuid,p_from date,p_through date,p_stations text[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_company is null or p_stations is null or cardinality(p_stations)>150 or p_from is null or p_through is null
    or p_through<p_from or p_through-p_from>30 or date_trunc('month',p_from)<>date_trunc('month',p_through)
    or p_through>(now() at time zone 'Asia/Kolkata')::date then raise exception 'Invalid CPS scope'; end if;
  with days as materialized (
    select v.id,v.vehicle_no,v.model,p.station_code,d::date work_date,r.monthly_rent,
      case when r.id is not null then
        round(r.monthly_rent*extract(day from d)/extract(day from (date_trunc('month',d)+interval '1 month - 1 day')),2)
        -round(r.monthly_rent*(extract(day from d)-1)/extract(day from (date_trunc('month',d)+interval '1 month - 1 day')),2)
      end amount
    from public.fleet_vehicle_cost_placements p
    join public.fleet_vehicles v on v.company_id=p.company_id and v.id=p.vehicle_id
    join public.stations s on s.company_id=p.company_id and s.station_code=p.station_code and s.is_active and not coalesce(s.hide_from_location_list,false)
    cross join lateral generate_series(greatest(p_from,p.effective_from),least(p_through,coalesce(p.effective_to,p_through)),interval '1 day') d
    left join lateral(select * from public.fleet_vehicle_rent_rates r where r.company_id=p.company_id and r.vehicle_id=p.vehicle_id
      and r.effective_from<=d::date and coalesce(r.effective_to,d::date)>=d::date order by r.effective_from desc limit 1) r on true
    where p.company_id=p_company and p.station_code=any(p_stations) and p.deployed and p.ownership_type in ('own','rented','leased')
  )
  select jsonb_build_object(
    'breakup',coalesce((select jsonb_agg(jsonb_build_object('station_code',station_code,'work_date',work_date,'head','Van',
      'sub_head','Vehicle rent · '||vehicle_no,'source','Fleet Vehicle Master','amount',amount)) from days where amount is not null),'[]'::jsonb),
    'vehicles',coalesce((select jsonb_agg(t) from (select id vehicle_id,vehicle_no,model,station_code,monthly_rent,
      min(work_date) from_date,max(work_date) through_date,count(*) days,sum(amount) amount
      from days group by id,vehicle_no,model,station_code,monthly_rent)t),'[]'::jsonb),
    'gaps',coalesce((select jsonb_agg(jsonb_build_object('key','vehicle-rent|'||vehicle_no||'|'||station_code,'kind','Vehicle rent missing',
      'station_code',station_code,'provider_id',vehicle_no,'dropx_id','','name',model,'first_date',from_date,'last_date',through_date,
      'days',days,'deliveries',0,'known_cost',0,'owner','Fleet team','href','https://fleet.dropxlogistics.com/fleet-control?section=masters&master=vehicle_master'))
      from (select vehicle_no,model,station_code,min(work_date) from_date,max(work_date) through_date,count(*) days
        from days where monthly_rent is null group by vehicle_no,model,station_code)t),'[]'::jsonb)
  ) into result;
  return result;
end; $$;
revoke all on function public.ops_cps_vehicle_costs(uuid,date,date,text[]) from public,anon,authenticated;
grant execute on function public.ops_cps_vehicle_costs(uuid,date,date,text[]) to service_role;
