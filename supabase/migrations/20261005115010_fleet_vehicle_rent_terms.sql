alter table public.fleet_vehicles
  add column rent_amount numeric(12,2),
  add column rent_period text;
alter table public.fleet_vehicles add constraint fleet_vehicle_rent_valid check (
  (rent_amount is null and rent_period is null) or
  (rent_amount is not null and rent_amount >= 0 and rent_amount <= 9999999999.99 and rent_period is not null and rent_period in ('monthly', 'daily'))
);
comment on column public.fleet_vehicles.rent_amount is 'Optional agreed vehicle rent in INR; no automatic payment creation.';
comment on column public.fleet_vehicles.rent_period is 'Billing basis: monthly or daily. Available for every vehicle source.';
