-- Upgrade for edd_performance_snapshots_v1.sql — run this if
-- edd_performance_snapshots already exists (it does, per the "Could not
-- find the 'packages' column" error): "create table if not exists" in the
-- v1 script won't add a column to a table that's already there.
--
-- Adds:
--   - edd_performance_snapshots.packages — per-package detail (today only),
--     powers the "By associate" driver breakdown.
--   - edd_performance_daily — day-over-day aggregate archive, powers
--     "By date" and "Day-wise ledger". New table, starts empty.
--
-- Safe to run even on a fresh database that never had v1 applied — the
-- ALTER is a no-op if the column doesn't exist yet to skip, and the CREATE
-- is guarded the same way v1's tables are.

alter table public.edd_performance_snapshots
  add column if not exists packages jsonb not null default '[]'::jsonb;

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
