-- Cover foreign-key lookups without changing access or financial data.
create index if not exists fleet_vehicle_rent_rates_vehicle_id_idx
  on public.fleet_vehicle_rent_rates (vehicle_id);
create index if not exists fleet_vehicle_cost_placements_vehicle_id_idx
  on public.fleet_vehicle_cost_placements (vehicle_id);
create index if not exists fleet_vehicle_rent_changes_company_id_idx
  on public.fleet_vehicle_rent_changes (company_id);
create index if not exists fleet_vehicle_rent_changes_vehicle_id_idx
  on public.fleet_vehicle_rent_changes (vehicle_id);
