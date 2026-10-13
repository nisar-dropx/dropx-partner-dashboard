-- User-approved initial DA reconciliation deadline: 9 pm IST.
-- Configuration data only. The runtime continues to read the editable station master.
-- Apply only to existing active COD setups with no deadline; preserve station overrides.
begin;
update public.cod_station_settings
set driver_recon_due_time = time '21:00', updated_at = now()
where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and is_active
  and driver_recon_due_time is null;
commit;

select station_code, driver_recon_due_time
from public.cod_station_settings
where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and is_active
order by station_code;
