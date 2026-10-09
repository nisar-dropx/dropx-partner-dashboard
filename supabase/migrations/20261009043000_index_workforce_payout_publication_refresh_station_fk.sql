create index if not exists workforce_payout_refresh_jobs_station_company_idx
  on public.workforce_payout_publication_refresh_jobs (company_id, station_id);
