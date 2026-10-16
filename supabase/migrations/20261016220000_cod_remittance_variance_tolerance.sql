-- Submitted remittances must pass the station's amount tolerance as well as timing.
begin;
alter table public.cod_station_settings
  add column if not exists remittance_variance_tolerance numeric(8,2) not null default 5
  constraint cod_remittance_variance_tolerance_nonnegative
  check (remittance_variance_tolerance >= 0 and remittance_variance_tolerance <= 999999.99);
comment on column public.cod_station_settings.remittance_variance_tolerance is
  'INR tolerance per submitted remittance. Absolute actual-minus-expected differences above this amount require attention; equality is tolerated. Default 5 INR.';
notify pgrst, 'reload schema';
commit;
