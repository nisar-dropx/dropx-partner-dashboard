alter table public.ops_cps_production_fallback_policies drop constraint ops_cps_production_fallback_policies_mode_check;
alter table public.ops_cps_production_fallback_policies add constraint ops_cps_production_fallback_policies_mode_check check (mode in ('disabled','associate_average','associate_then_station','associate_station_company'));
