-- Auto-cleanup: keep only today + yesterday in the PPI tables.
-- Yesterday is kept so the cron can compute trend vs previous day.
-- Runs as a pg_cron job at 03:00 IST (21:30 UTC) daily.

select cron.schedule(
  'dark-store-ppi-cleanup',
  '30 21 * * *',   -- 03:00 IST
  $$
    delete from ds_ppi_orders   where business_date < current_date - interval '1 day';
    delete from ds_ppi_hourly   where business_date < current_date - interval '1 day';
    delete from ds_ppi_daily    where business_date < current_date - interval '1 day';
    delete from ds_fetch_runs   where started_at    < now()         - interval '2 days';
  $$
);
