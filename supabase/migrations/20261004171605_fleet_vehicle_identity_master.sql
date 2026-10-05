-- Static vehicle identity belongs to the master, separate from daily availability.
alter table public.fleet_vehicles
 add column if not exists chassis_number text,
 add column if not exists engine_number text,
 add column if not exists manufacture_year integer check(manufacture_year between 1950 and 2100),
 add column if not exists registration_date date,
 add column if not exists purchase_date date,
 add column if not exists invoice_number text,
 add column if not exists purchase_value numeric(14,2) check(purchase_value>=0),
 add column if not exists supplier_name text,
 add column if not exists registered_owner text,
 add column if not exists payload_capacity_kg numeric(10,2) check(payload_capacity_kg>=0),
 add column if not exists master_notes text,
 add column if not exists master_updated_by uuid;
create table public.fleet_vehicle_master_changes (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 vehicle_id uuid not null references public.fleet_vehicles(id),before_values jsonb not null,after_values jsonb not null,
 actor_id uuid,changed_at timestamptz not null default now()
);
create index fleet_vehicle_master_changes_vehicle_idx on public.fleet_vehicle_master_changes(vehicle_id,changed_at desc);
create index fleet_vehicle_master_changes_company_idx on public.fleet_vehicle_master_changes(company_id);
alter table public.fleet_vehicle_master_changes enable row level security;
revoke all on public.fleet_vehicle_master_changes from anon,authenticated;
grant select,insert on public.fleet_vehicle_master_changes to service_role;
create function public.fleet_record_master_change() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 insert into public.fleet_vehicle_master_changes(company_id,vehicle_id,before_values,after_values,actor_id)
 values(new.company_id,new.id,to_jsonb(old),to_jsonb(new),new.master_updated_by);
 return new;
end;$$;
revoke all on function public.fleet_record_master_change() from public,anon,authenticated;
create trigger fleet_vehicle_master_change after update of model,fuel_type,color,ownership_type,rc_location,chassis_number,engine_number,manufacture_year,registration_date,purchase_date,invoice_number,purchase_value,supplier_name,registered_owner,payload_capacity_kg,master_notes on public.fleet_vehicles
 for each row when (old.* is distinct from new.*) execute function public.fleet_record_master_change();
insert into public.document_types(company_id,code,name,description,requires_expiry,document_module,is_active,sort_order)
select c.id,'VEHICLE_INVOICE','Vehicle purchase invoice','Original vehicle purchase invoice',false,'fleet',true,90
from public.companies c where not exists(select 1 from public.document_types d where d.company_id=c.id and d.code='VEHICLE_INVOICE');
