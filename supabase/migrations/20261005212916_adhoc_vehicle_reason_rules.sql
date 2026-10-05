-- Configurable reason policies. Product roles and source designations are resolved by code.
create table public.fleet_adhoc_reason_rules (
 company_id uuid not null references public.companies(id), reason_key text not null, label text not null,
 source_code text, required_status text, effect_status text, block_rent boolean not null default false,
 approval_steps jsonb, contact_role_code text, sort_order int not null, is_active boolean not null default true,
 primary key(company_id,reason_key), unique(company_id,label)
);
alter table public.fleet_adhoc_reason_rules enable row level security;
revoke all on public.fleet_adhoc_reason_rules from anon,authenticated;
grant all on public.fleet_adhoc_reason_rules to service_role;
alter table public.payment_requests add column adhoc_reason_key text,
 add column adhoc_vehicle_id uuid references public.fleet_vehicles(id), add column adhoc_deployment_date date,
 add column adhoc_vehicle_snapshot jsonb, add column adhoc_approval_steps jsonb;
create table public.fleet_vehicle_day_availability (
 request_id uuid primary key references public.payment_requests(id), company_id uuid not null references public.companies(id),
 vehicle_id uuid not null references public.fleet_vehicles(id), work_date date not null, status text not null,
 block_rent boolean not null default false, created_by uuid references public.profiles(id), created_at timestamptz not null default now(),
 revoked_at timestamptz
);
create unique index fleet_one_active_replacement on public.fleet_vehicle_day_availability(company_id,vehicle_id,work_date) where revoked_at is null;
alter table public.fleet_vehicle_day_availability enable row level security;
revoke all on public.fleet_vehicle_day_availability from anon,authenticated;
grant all on public.fleet_vehicle_day_availability to service_role;
insert into public.fleet_adhoc_reason_rules(company_id,reason_key,label,source_code,required_status,effect_status,block_rent,contact_role_code,sort_order)
select c.id,r.* from public.companies c cross join (values
 ('company_breakdown','Company Vehicle Breakdown','OWN','breakdown',null,false,'OPERATIONS_FLTM',1),
 ('vendor_absent','Vehicle Vendor Absent','VNV',null,'on_leave',false,null,2),
 ('vendor_breakdown','Vendor Vehicle Breakdown','VNV',null,'breakdown',false,null,3),
 ('odcd_absent','ODCD Vehicle Absent','ODCD',null,'on_leave',true,null,4),
 ('odcd_breakdown','ODCD Vehicle Breakdown','ODCD',null,'breakdown',true,null,5),
 ('high_volume','High Volume',null,null,null,false,null,6)
) r(reason_key,label,source_code,required_status,effect_status,block_rent,contact_role_code,sort_order)
where exists(select 1 from public.payment_heads h where h.company_id=c.id and h.code='VAN_ADHOC');
update public.fleet_adhoc_reason_rules r set approval_steps=jsonb_build_array(
 jsonb_build_object('id','company-fleet','step_order',1,'is_required',true,'candidates',jsonb_build_array(jsonb_build_object('role_id',fm.id,'scope','company'))),
 jsonb_build_object('id','company-business','step_order',2,'is_required',true,'candidates',jsonb_build_array(jsonb_build_object('role_id',bh.id,'scope','company'),jsonb_build_object('role_id',nh.id,'scope','company')))
) from public.user_roles fm,public.user_roles bh,public.user_roles nh
where r.reason_key='company_breakdown' and fm.company_id=r.company_id and fm.code='OPERATIONS_FLTM'
 and bh.company_id=r.company_id and bh.code='OPERATIONS_BH' and nh.company_id=r.company_id and nh.code='OPERATIONS_NH';

create function public.fleet_validate_adhoc_request() returns trigger language plpgsql set search_path='' as $$
declare rule public.fleet_adhoc_reason_rules; v public.fleet_vehicles; source text; station text;
begin
 if new.adhoc_reason_key is null then return new; end if;
 if tg_op='UPDATE' and old.status<>'draft' and (new.adhoc_reason_key,new.adhoc_vehicle_id,new.adhoc_deployment_date) is not distinct from (old.adhoc_reason_key,old.adhoc_vehicle_id,old.adhoc_deployment_date) then return new; end if;
 if tg_op='UPDATE' and old.status<>'draft' then raise exception 'The replacement reason, vehicle and date cannot be changed after submission. Cancel and raise a corrected request.'; end if;
 if not exists(select 1 from public.payment_heads where company_id=new.company_id and id=new.payment_head_id and code='VAN_ADHOC') then raise exception 'Vehicle reasons apply only to ad hoc vans.'; end if;
 select * into rule from public.fleet_adhoc_reason_rules where company_id=new.company_id and reason_key=new.adhoc_reason_key and is_active;
 if not found then raise exception 'This ad hoc reason is unavailable. Refresh and try again.'; end if;
 if new.adhoc_deployment_date is null then raise exception 'Deployment date is required.'; end if;
 select station_code into station from public.stations where company_id=new.company_id and id=new.location_id;
 if station is null then raise exception 'Station unavailable.'; end if;
 if rule.source_code is null then new.adhoc_vehicle_id:=null;new.adhoc_vehicle_snapshot:=null;return new;end if;
 select * into v from public.fleet_vehicles where company_id=new.company_id and id=new.adhoc_vehicle_id for update;
 if not found or v.station_code<>station or v.deployment_status<>'deployed' or v.deployment_date>new.adhoc_deployment_date then raise exception 'Select a deployed vehicle at this station for the request date.';end if;
 select coalesce(d.code,'OWN') into source from public.fleet_vehicle_sources s left join public.designations d on d.id=s.designation_id where s.company_id=new.company_id and s.id=v.source_id and s.is_active;
 if source is distinct from rule.source_code then raise exception 'Vehicle source does not match the selected reason.';end if;
 if exists(select 1 from public.fleet_vehicle_status_master where company_id=new.company_id and status_key=v.status and is_terminal) then raise exception 'This vehicle is no longer active.';end if;
 if rule.required_status is not null and v.status is distinct from rule.required_status then raise exception 'No matching breakdown recorded. Contact the Fleet Manager to update Fleet first.';end if;
 if exists(select 1 from public.fleet_vehicle_day_availability where company_id=new.company_id and vehicle_id=v.id and work_date=new.adhoc_deployment_date and revoked_at is null) then raise exception 'A replacement request already exists for this vehicle and date.';end if;
 new.adhoc_vehicle_snapshot:=jsonb_build_object('number',v.vehicle_no,'model',v.model,'partner',coalesce(v.da_name,v.vendor_name),'source',source,'status',v.status,'reason',rule.label,'date',new.adhoc_deployment_date);
 new.adhoc_approval_steps:=rule.approval_steps;
 return new;
end $$;
create trigger fleet_validate_adhoc before insert or update of adhoc_reason_key,adhoc_vehicle_id,adhoc_deployment_date,status on public.payment_requests for each row execute function public.fleet_validate_adhoc_request();
create function public.fleet_record_adhoc_day() returns trigger language plpgsql set search_path='' as $$
declare rule public.fleet_adhoc_reason_rules;
begin
 if new.adhoc_vehicle_id is null or new.status='draft' then return new;end if;
 select * into rule from public.fleet_adhoc_reason_rules where company_id=new.company_id and reason_key=new.adhoc_reason_key;
 if tg_op='INSERT' or (tg_op='UPDATE' and old.status='draft') then
 insert into public.fleet_vehicle_day_availability(request_id,company_id,vehicle_id,work_date,status,block_rent,created_by)
 values(new.id,new.company_id,new.adhoc_vehicle_id,new.adhoc_deployment_date,coalesce(rule.effect_status,'breakdown'),rule.block_rent,new.requested_by);
 else
 update public.fleet_vehicle_day_availability set revoked_at=case when lower(coalesce(new.status,'')) in ('cancelled','rejected') or upper(coalesce(new.approval_status,'')) in ('CANCELLED','REJECTED') then coalesce(revoked_at,now()) else null end where request_id=new.id and company_id=new.company_id;
 end if;
 return new;
end $$;
create trigger fleet_record_adhoc_day after insert or update of status,approval_status on public.payment_requests for each row execute function public.fleet_record_adhoc_day();
revoke all on function public.fleet_validate_adhoc_request() from public,anon,authenticated;
revoke all on function public.fleet_record_adhoc_day() from public,anon,authenticated;

-- The daily ledger is the single rent eligibility input; rejecting/cancelling releases it.
create or replace function public.fleet_vehicle_rent_daily(p_company uuid,p_from date,p_through date,p_stations text[])
returns table(vehicle_id uuid,vehicle_no text,model text,station_code text,work_date date,monthly_rent numeric,daily_rent numeric,amount numeric,updated_at timestamptz)
language sql stable set search_path='' as $$
 select v.id,v.vehicle_no,v.model,p.station_code,d::date,r.monthly_rent,r.daily_rent,
 case when exists(select 1 from public.fleet_vehicle_day_availability a where a.company_id=p.company_id and a.vehicle_id=p.vehicle_id and a.work_date=d::date and a.block_rent and a.revoked_at is null) then 0::numeric
 when r.daily_rent is not null then r.daily_rent
 when r.monthly_rent is not null then round(r.monthly_rent*extract(day from d)/extract(day from (date_trunc('month',d)+interval '1 month - 1 day')),2)-round(r.monthly_rent*(extract(day from d)-1)/extract(day from (date_trunc('month',d)+interval '1 month - 1 day')),2) end,r.updated_at
 from public.fleet_vehicle_cost_placements p join public.fleet_vehicles v on v.company_id=p.company_id and v.id=p.vehicle_id
 join public.stations s on s.company_id=p.company_id and s.station_code=p.station_code and s.is_active and not coalesce(s.hide_from_location_list,false)
 cross join lateral generate_series(greatest(p_from,p.effective_from,v.deployment_date),least(p_through,coalesce(p.effective_to,p_through)),interval '1 day') d
 left join lateral(select * from public.fleet_vehicle_rent_rates r where r.company_id=p.company_id and r.vehicle_id=p.vehicle_id and r.effective_from<=d::date and coalesce(r.effective_to,d::date)>=d::date order by r.effective_from desc limit 1)r on true
 where p.company_id=p_company and (p_stations is null or p.station_code=any(p_stations)) and p.deployed and p.ownership_type in ('own','rented','leased','odcd');
$$;
