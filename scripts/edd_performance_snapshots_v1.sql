-- EDD Performance (assigned/delivered/returned/held) snapshots + sweep
-- run tracking.
--
-- Unlike the ageing snapshot, a performance pull for one station is a
-- single-day query with no bulk enrichment pass — cheap enough that
-- amazon-edd-worker's 15-minute cron refreshes every allowed station
-- sequentially in one invocation (see eddPerformanceSweep.ts), rather than
-- ageing's one-station-per-minute spread. This stores the latest ("today")
-- snapshot per station so the dashboard reads instantly, refreshed by:
--   - the 15-minute cron (see amazon-edd-worker/wrangler.toml), and
--   - a manual per-station "Refresh" button, or "Refresh all" (network-wide
--     sweep) on the Delivery Performance page.
--
-- Run once in the Supabase SQL Editor for the project amazon-edd-worker's
-- SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY secrets point at.

create table if not exists public.edd_performance_snapshots (
  id uuid primary key default gen_random_uuid(),
  station_code text not null,
  window_from date not null,
  window_to date not null,
  fetched_at timestamptz not null,
  assigned integer not null default 0,
  delivered integer not null default 0,
  returned integer not null default 0,
  held integer not null default 0,
  delivered_pct numeric not null default 0,
  returned_pct numeric not null default 0,
  held_pct numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (station_code)
);

create table if not exists public.edd_performance_runs (
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

create index if not exists edd_performance_runs_status_idx on public.edd_performance_runs (status);
