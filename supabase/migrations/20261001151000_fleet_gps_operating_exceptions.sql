-- Persist operational characteristics already returned by WheelsEye history.
alter table public.fleet_daily_km add column if not exists max_speed numeric;
alter table public.fleet_daily_km add column if not exists moving_minutes integer;
alter table public.fleet_daily_km add column if not exists late_night boolean not null default false;
alter table public.fleet_daily_km add column if not exists first_moving_at timestamptz;
alter table public.fleet_daily_km add column if not exists last_moving_at timestamptz;

create index if not exists fleet_daily_km_late_night_idx
  on public.fleet_daily_km(company_id, movement_date desc)
  where late_night = true;

comment on column public.fleet_daily_km.late_night is
  'True when accepted GPS movement is recorded from 22:00 through 04:59 IST.';
