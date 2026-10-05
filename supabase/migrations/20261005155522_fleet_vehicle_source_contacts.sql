alter table public.fleet_vehicles
  add column da_name text,
  add column da_contact_number text,
  add column vendor_name text,
  add column vendor_contact_number text;
alter table public.fleet_vehicles add constraint fleet_vehicle_contacts_valid check (
  (da_name is null or length(da_name)<=160) and (vendor_name is null or length(vendor_name)<=160)
  and (da_contact_number is null or da_contact_number ~ '^\+?[0-9]{7,15}$')
  and (vendor_contact_number is null or vendor_contact_number ~ '^\+?[0-9]{7,15}$')
);
comment on column public.fleet_vehicles.da_name is 'ODCD owner-driver name; separate from rental vendor identity.';
comment on column public.fleet_vehicles.vendor_name is 'Rented vehicle provider name.';
