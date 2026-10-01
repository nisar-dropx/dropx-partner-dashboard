-- Persist the first accepted moving fix for station-start geofence controls.
alter table public.fleet_daily_km add column if not exists first_moving_latitude numeric;
alter table public.fleet_daily_km add column if not exists first_moving_longitude numeric;

comment on column public.fleet_daily_km.first_moving_latitude is
  'Latitude of the first accepted moving GPS fix for the vehicle-day.';
comment on column public.fleet_daily_km.first_moving_longitude is
  'Longitude of the first accepted moving GPS fix for the vehicle-day.';
