begin;
alter table public.cod_station_settings
  add column if not exists recon_age_flag_days integer not null default 1 check (recon_age_flag_days between 1 and 365),
  add column if not exists cod_status_max_age_minutes integer not null default 15 check (cod_status_max_age_minutes between 1 and 60);
comment on column public.cod_station_settings.recon_age_flag_days is 'Prominent pending TID flag threshold in IST calendar days; earlier-day cash remains overdue independently.';
comment on column public.cod_station_settings.cod_status_max_age_minutes is 'Maximum age of a live COD Status check before refresh is required; editable by station.';
commit;
