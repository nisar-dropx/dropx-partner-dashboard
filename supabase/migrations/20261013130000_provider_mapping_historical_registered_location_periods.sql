-- This migration version was applied to production while the change was under
-- review. The finalized, fully regression-tested function definitions live in
-- 20261013150000_provider_mapping_historical_registered_location_periods_final.sql.
-- Keeping this version preserves the remote migration ledger; fresh databases
-- receive the final definitions from the later migration.
begin;
commit;
