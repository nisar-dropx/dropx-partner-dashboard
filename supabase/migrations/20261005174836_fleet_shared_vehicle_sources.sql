-- Canonical designation identities; ownership_type remains the existing policy/cost group.
create table public.fleet_vehicle_sources (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 designation_id uuid references public.designations(id),
 ownership_type text not null check (ownership_type in ('own','odcd','rented')),
 is_active boolean not null default true,
 sort_order integer not null default 100 check(sort_order between 0 and 10000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(company_id,id), unique(company_id,designation_id),
 check(designation_id is not null or ownership_type='own')
);
create unique index fleet_vehicle_sources_own on public.fleet_vehicle_sources(company_id) where designation_id is null;
alter table public.fleet_vehicle_sources enable row level security;
revoke all on public.fleet_vehicle_sources from public,anon,authenticated;
grant all on public.fleet_vehicle_sources to service_role;
insert into public.fleet_vehicle_sources(company_id,ownership_type,sort_order)
 select distinct company_id,'own',10 from public.fleet_vehicles;
insert into public.fleet_vehicle_sources(company_id,designation_id,ownership_type,sort_order)
 select d.company_id,d.id,case when d.code='ODCD' then 'odcd' else 'rented' end,
 case d.code when 'ODCD' then 20 when 'VAN' then 30 else 40 end
 from public.designations d where d.code in ('ODCD','VAN','VNV') and d.is_active
 and exists(select 1 from public.fleet_vehicles v where v.company_id=d.company_id);
alter table public.fleet_vehicles add column source_id uuid;
alter table public.fleet_vehicles add constraint fleet_vehicle_source_company_fk foreign key(company_id,source_id) references public.fleet_vehicle_sources(company_id,id);
create index fleet_vehicles_source on public.fleet_vehicles(company_id,source_id);
update public.fleet_vehicles v set source_id=s.id from public.fleet_vehicle_sources s
 left join public.designations d on d.id=s.designation_id
 where s.company_id=v.company_id and (
 (coalesce(v.ownership_type,'own')='own' and s.designation_id is null)
 or (v.ownership_type='odcd' and d.code='ODCD')
 or (v.ownership_type in ('rented','leased') and d.code='VAN'));

create function public.fleet_vehicle_source_master_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if new.designation_id is not null and not exists(select 1 from public.designations d where d.id=new.designation_id and d.company_id=new.company_id and d.profile_destination in ('workforce','vendors')) then
  raise exception 'Choose a Workforce or Vendor designation from this company.';
 end if;
 if tg_op='UPDATE' then
  if new.company_id<>old.company_id or new.designation_id is distinct from old.designation_id then raise exception 'A linked designation cannot be changed; add a new source instead.'; end if;
  if new.ownership_type<>old.ownership_type and exists(select 1 from public.fleet_vehicles v where v.source_id=old.id) then raise exception 'This source is in use. Its vehicle policy cannot be changed.'; end if;
  if old.designation_id is null and not new.is_active then raise exception 'Own vehicles must remain available.'; end if;
 end if;
 new.updated_at=now();return new;
end; $$;
create trigger fleet_vehicle_source_master_guard before insert or update on public.fleet_vehicle_sources for each row execute function public.fleet_vehicle_source_master_guard();

create function public.fleet_vehicle_source_guard() returns trigger language plpgsql set search_path='' as $$
declare s public.fleet_vehicle_sources; changed boolean;
begin
 changed := tg_op='INSERT';
 if tg_op='UPDATE' then changed := new.source_id is distinct from old.source_id; end if;
 -- Older clients only know ownership_type; resolve its canonical default when they change it.
 if new.source_id is null or (tg_op='UPDATE' and not changed and new.ownership_type is distinct from old.ownership_type) then
  select x.* into s from public.fleet_vehicle_sources x left join public.designations d on d.id=x.designation_id
   where x.company_id=new.company_id and x.is_active and (x.designation_id is null or d.is_active)
   and ((coalesce(new.ownership_type,'own')='own' and x.designation_id is null)
     or (new.ownership_type='odcd' and d.code='ODCD')
     or (new.ownership_type in ('rented','leased') and d.code='VAN'));
  if not found then raise exception 'Choose an enabled vehicle source in Masters.'; end if;
  new.source_id=s.id;changed=true;
 else
  select * into s from public.fleet_vehicle_sources where id=new.source_id and company_id=new.company_id;
  if not found then raise exception 'Invalid vehicle source for this company.'; end if;
 end if;
 if changed and (not s.is_active or (s.designation_id is not null and not exists(select 1 from public.designations where id=s.designation_id and is_active))) then raise exception 'This vehicle source is disabled.'; end if;
 new.ownership_type=s.ownership_type;return new;
end; $$;
-- Runs before status/source policy validation.
create trigger fleet_00_vehicle_source before insert or update of source_id,ownership_type on public.fleet_vehicles for each row execute function public.fleet_vehicle_source_guard();
revoke all on function public.fleet_vehicle_source_guard(),public.fleet_vehicle_source_master_guard() from public,anon,authenticated;
grant execute on function public.fleet_vehicle_source_guard(),public.fleet_vehicle_source_master_guard() to service_role;
