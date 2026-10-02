alter table public.fleet_vehicles
  add column if not exists deployment_status text not null default 'deployed',
  add column if not exists current_location_type text not null default 'station',
  add column if not exists current_location_code text,
  add column if not exists current_location_label text,
  add column if not exists current_location_updated_at timestamptz,
  add column if not exists current_location_updated_by uuid;

update public.fleet_vehicles
set
  current_location_code = coalesce(nullif(current_location_code, ''), station_code),
  current_location_label = coalesce(nullif(current_location_label, ''), station_code),
  current_location_updated_at = coalesce(current_location_updated_at, updated_at, created_at, now())
where current_location_code is null
   or current_location_label is null
   or current_location_updated_at is null;

alter table public.fleet_vehicles
  drop constraint if exists fleet_vehicles_deployment_status_check,
  add constraint fleet_vehicles_deployment_status_check
    check (deployment_status in ('deployed', 'not_deployed')),
  drop constraint if exists fleet_vehicles_current_location_type_check,
  add constraint fleet_vehicles_current_location_type_check
    check (current_location_type in ('station', 'ho', 'workshop', 'in_transit', 'other'));

create index if not exists fleet_vehicles_deployment_location_idx
  on public.fleet_vehicles(company_id, deployment_status, current_location_code);

comment on column public.fleet_vehicles.station_code is
  'Assigned operating station. This remains stable when a vehicle is temporarily not deployed or physically elsewhere.';
comment on column public.fleet_vehicles.deployment_status is
  'Whether the vehicle is currently deployed to operations: deployed or not_deployed.';
comment on column public.fleet_vehicles.current_location_label is
  'Current physical location entered by Fleet. May be a station, HO, workshop, transit point, or another named place.';
