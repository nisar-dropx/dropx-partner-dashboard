begin;

-- biometric_raw_event_duplicates_archive was created via
-- `like public.biometric_raw_events including defaults including generated`
-- (20260902160000_harden_biometric_punch_delivery.sql) — that clause explicitly does NOT
-- carry over indexes, so this table has only its id unique index. Every lookup filtering by
-- (company_id, middleware_raw_event_id) — the duplicate-check query, called ~30,600 times
-- and responsible for 60%+ of this project's total database time per Supabase's own Query
-- Performance report — has been doing a full scan this whole time.
create index if not exists biometric_raw_event_duplicates_archive_company_mid_idx
  on public.biometric_raw_event_duplicates_archive (company_id, middleware_raw_event_id);

-- #2 by total time in the same Query Performance report (8.7%): edd_ingest_observations()
-- (20260909203000_edd_withdraw_missing_stock_evidence.sql) anti-joins edd_package_ledger by
-- (station_code, backlog_at) and separately (station_code, performance_at). Only the
-- (station_code, tracking_id) primary key exists today, so each call falls back to scanning
-- every row for a station rather than seeking directly on the timestamp comparison. Lower
-- confidence than the archive-table fix above (no EXPLAIN run against production), but a
-- safe, additive index that matches the function's actual filter columns.
create index if not exists edd_package_ledger_station_backlog_idx
  on public.edd_package_ledger (station_code, backlog_at);

create index if not exists edd_package_ledger_station_performance_idx
  on public.edd_package_ledger (station_code, performance_at);

commit;
