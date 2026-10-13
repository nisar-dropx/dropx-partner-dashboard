import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../../../../supabase/migrations/20261012160000_workforce_payout_source_identity_holds.sql", import.meta.url),
  "utf8"
).toLowerCase();

test("source hold ledger is append-only, tenant scoped and exactly replayable", () => {
  assert.match(migration, /create table public\.workforce_payout_source_payment_hold_events/);
  assert.match(migration, /foreign key \(company_id, station_id\)[\s\S]*references public\.stations\(company_id, id\)/);
  assert.match(migration, /before insert or update or delete on public\.workforce_payout_source_payment_hold_events/);
  assert.match(migration, /operation_id uuid not null/);
  assert.match(migration, /v_existing_sources is distinct from v_sources/);
  assert.match(migration, /state\.is_held is distinct from p_hold/);
});

test("source hold rejects processing payments and blocks every bank insertion path", () => {
  assert.match(migration, /item\.status = 'processing'/);
  assert.match(migration, /cancel or finalize processing before changing the hold/);
  assert.match(migration, /workforce_payout_source_payment_is_on_hold\([\s\S]*payment_status := 'on hold'/);
  assert.match(migration, /before insert on public\.workforce_payout_payment_items/);
  assert.match(migration, /cannot be included in a bank file/);
});

test("source identity includes station, provider and provider member for one exact month", () => {
  assert.match(migration, /station_id uuid not null/);
  assert.match(migration, /provider_identity_key text not null/);
  assert.match(migration, /provider_member_id_key text not null/);
  assert.match(migration, /payment holds require one exact calendar month/);
  assert.match(migration, /mapping\.effective_from <= p_period_end/);
  assert.match(migration, /coalesce\(mapping\.effective_to, p_period_end\) >= p_period_start/);
});

test("combined holds are atomic and a mapped provider alias can release the pre-mapping source", () => {
  assert.match(migration, /create or replace function public\.workforce_set_payout_combined_payment_holds/);
  assert.match(migration, /v_profile_result := public\.workforce_set_payout_payment_holds/);
  assert.match(migration, /v_source_result := public\.workforce_set_payout_source_payment_holds/);
  assert.match(migration, /workforce_payout_provider_identity_matches\([\s\S]*event\.provider_identity_key/);
});
