-- Auto-cleanup function: keep only today + yesterday in the PPI tables.
-- Yesterday is kept so the cron can compute trend vs previous day.
-- Call this function from the Vercel cron (dark-store-ppi route) or
-- trigger it manually: select ds_ppi_cleanup();

create or replace function ds_ppi_cleanup()
returns void language plpgsql security definer as $$
begin
  delete from ds_ppi_orders where business_date < current_date - interval '1 day';
  delete from ds_ppi_hourly where business_date < current_date - interval '1 day';
  delete from ds_ppi_daily  where business_date < current_date - interval '1 day';
  delete from ds_fetch_runs where started_at    < now()        - interval '2 days';
end;
$$;
