-- Upgrade for edd_performance_snapshots_v2_add_packages_and_daily.sql.
--
-- Redefines "assigned" to mean packages actually dispatched to a driver or
-- store (delivered + returned + held) — a package still sitting at the
-- station with no driver/store attached yet (e.g. state INDUCTED/AT_STATION)
-- hadn't started its delivery attempt, so counting it as "assigned" understated
-- the real delivery percentage and mislabeled station backlog as driver
-- underperformance. That backlog is now its own column, shown separately.
--
-- Adds:
--   - edd_performance_snapshots.yet_to_dispatch
--   - edd_performance_daily.yet_to_dispatch
--
-- Existing rows default to 0 (they predate this distinction, so their
-- `assigned` was computed under the old, broader definition — a discontinuity
-- in the archive from this date forward, same as every prior column addition
-- here since there's no way to recompute a day's own historical packages).
--
-- Safe to run even on a fresh database that never had v1/v2 applied.

alter table public.edd_performance_snapshots
  add column if not exists yet_to_dispatch integer not null default 0;

alter table public.edd_performance_daily
  add column if not exists yet_to_dispatch integer not null default 0;
