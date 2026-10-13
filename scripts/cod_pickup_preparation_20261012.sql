-- User-approved initial next-day preparation cutoff: 4 pm IST.
-- Stored per station and editable in COD Pickup Master; no runtime fallback hour.
begin;
alter table public.cod_station_settings add column if not exists next_day_preparation_from time;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.cod_station_settings'::regclass and conname='cod_next_day_preparation_valid') then
    alter table public.cod_station_settings add constraint cod_next_day_preparation_valid
      check (next_day_preparation_from is null or pickup_rule <> 'Next Day' or next_day_preparation_from >= pickup_window_end);
  end if;
end $$;
update public.cod_station_settings
set next_day_preparation_from='16:00', updated_at=now()
where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and pickup_configured and pickup_rule='Next Day'
  and next_day_preparation_from is null and pickup_window_end <= '16:00';
commit;
select station_code, pickup_window_end, next_day_preparation_from
from public.cod_station_settings
where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and pickup_configured and pickup_rule='Next Day' order by station_code;
