-- EDD ledger: stop the every-minute full-table scans that slow the whole DB.
--
-- edd_package_ledger is ~1 GB (~520k rows; only ~215k seen in the last 7 days).
-- The edd-stock-refresh / edd-verification crons run every minute. Their
-- "missing EDD date" lookup (src/lib/ops-pulse/edd-ledger.ts) filters on three
-- JSON fields + last_seen_at, none indexed, so Postgres does a parallel seq
-- scan of the whole table each minute - and currently returns 0 rows. With
-- ~1 GB of shared buffers for a ~9 GB database, those scans evict everyone
-- else's cached pages (queries then wait on DataFileRead), which is the
-- "database hangs" symptom across all portals.
--
-- The Supabase SQL editor wraps a run in a transaction, so CREATE INDEX
-- CONCURRENTLY is not possible there. A plain CREATE INDEX blocks only WRITES
-- to edd_package_ledger while it builds (reads continue); the only writers are
-- the EDD crons, which simply retry next minute. Expect well under a minute.

set statement_timeout = '10min';

-- 1) The missing-date queue: tiny partial index (0 matching rows today).
create index if not exists edd_package_ledger_missing_edd_idx
  on public.edd_package_ledger (station_code, tracking_id)
  include (last_seen_at)
  where (source->>'ead') is null
    and (verification->>'edd') is null
    and (source->>'summaryCheckedAt') is null;

-- 2) loadEddLedger: station + last-7-days window.
create index if not exists edd_package_ledger_station_seen_idx
  on public.edd_package_ledger (station_code, last_seen_at);

-- 3) Refresh planner statistics.
analyze public.edd_package_ledger;
