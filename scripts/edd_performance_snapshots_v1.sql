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
  -- Per-package detail (trackingId/state/bucket/driver/...) for "today"
  -- only — powers the "By associate" driver breakdown. Never archived
  -- day-over-day; see edd_performance_daily below for that.
  packages jsonb not null default '[]'::jsonb,
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

-- Day-over-day archive (aggregate counts only, no per-package detail) —
-- every performance snapshot save (sweep or manual refresh) upserts one
-- row here for today, keyed on (station_code, date). Powers "By date" and
-- "Day-wise ledger". Starts empty and fills in one real day at a time from
-- whenever this is run — there is no way to backfill history from before
-- this table existed.
create table if not exists public.edd_performance_daily (
  id uuid primary key default gen_random_uuid(),
  station_code text not null,
  date date not null,
  assigned integer not null default 0,
  delivered integer not null default 0,
  returned integer not null default 0,
  held integer not null default 0,
  delivered_pct numeric not null default 0,
  returned_pct numeric not null default 0,
  held_pct numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (station_code, date)
);

create index if not exists edd_performance_daily_station_date_idx on public.edd_performance_daily (station_code, date desc);
