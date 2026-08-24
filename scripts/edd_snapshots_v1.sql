-- EDD Dashboard live snapshots + nightly refresh run tracking.
--
-- amazon-edd-worker's full bulk-enrichment pass (batchGetPackageSummary
-- across every backlog row) takes ~60-90s per station, too slow to run
-- synchronously on every page load. This stores the latest snapshot per
-- station so the dashboard reads instantly, refreshed by:
--   - a daily 08:00 IST cron (see amazon-edd-worker/wrangler.toml), which
--     works through every station one at a time via edd_snapshot_runs
--     (same "one station per tick" spreading cash-recon-worker's CIA
--     snapshot cron already uses, to stay well under any single
--     invocation's time budget), and
--   - a manual "Refresh live" button on the EDD dashboard page, which
--     refreshes just the station being viewed.
--
-- Run once in the Supabase SQL Editor for the project amazon-edd-worker's
-- SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY secrets point at.

create table if not exists public.edd_station_snapshots (
  id uuid primary key default gen_random_uuid(),
  station_code text not null,
  fetched_at timestamptz not null,
  today_ymd date not null,
  window_from date not null,
  window_to date not null,
  total_count integer not null default 0,
  buckets jsonb not null default '{}'::jsonb,
  by_date jsonb not null default '[]'::jsonb,
  packages jsonb not null default '[]'::jsonb,
  session_source text,
  account_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (station_code)
);

create table if not exists public.edd_snapshot_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running', -- running | completed | failed
  station_codes text[] not null,
  next_index integer not null default 0,
  stations_ok integer not null default 0,
  stations_failed integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_error text
);

create index if not exists edd_snapshot_runs_status_idx on public.edd_snapshot_runs (status);
