import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../../../../supabase/migrations/20261012190000_workforce_payout_paid_mapping_transfer.sql", import.meta.url),
  "utf8"
).toLowerCase();

test("paid remapping preserves immutable bank evidence through a separate credit ledger", () => {
  assert.match(migration, /create table public\.workforce_payout_mapping_payment_decisions/);
  assert.match(
    migration,
    /create unique index if not exists workforce_payout_payment_allocations_company_id_id_uidx\s+on public\.workforce_payout_payment_allocations\(company_id, id\)/
  );
  assert.match(migration, /create table public\.workforce_payout_payment_credit_transfers/);
  assert.match(migration, /original_reference_snapshot text not null/);
  assert.match(migration, /original_utr_cin_snapshot text not null/);
  assert.match(migration, /before update or delete on public\.workforce_payout_payment_credit_transfers/);
  assert.doesNotMatch(migration, /update public\.workforce_payout_payment_items[\s\S]{0,300}workforce_id\s*=/);
});

test("preflight requires an explicit keep or transfer decision and blocks processing", () => {
  assert.match(migration, /create or replace function public\.workforce_mapping_paid_history_preview/);
  assert.match(migration, /'has_paid_history', v_paid > 0/);
  assert.match(migration, /'payment_fingerprint', v_payment_fingerprint/);
  assert.match(migration, /'partial_period_allocation_count', v_partial_period_allocation_count/);
  assert.match(migration, /'processing_count', v_processing_count/);
  assert.match(migration, /choose transfer payment details or keep with existing id/);
  assert.match(migration, /finalize or cancel it before remapping this provider id/);
});

test("mapping replacement and paid-credit movement use one exact idempotent transaction", () => {
  assert.match(migration, /create or replace function public\.workforce_replace_joining_mapping_with_payment_decision/);
  assert.match(migration, /request_fingerprint text not null/);
  assert.match(migration, /payment_fingerprint_snapshot text not null/);
  assert.match(migration, /unique \(company_id, operation_id\)/);
  assert.match(migration, /perform public\.lock_workforce_payment_allocation_company\(p_company\)/);
  assert.match(migration, /perform public\.workforce_replace_joining_mapping\([\s\S]*insert into public\.workforce_payout_payment_credit_transfers/);
  assert.match(migration, /return v_existing\.result_snapshot \|\| jsonb_build_object\('replayed', true\)/);
  assert.match(migration, /action text not null check \(action in \('none', 'keep', 'transfer'\)\)/);
  assert.match(migration, /if v_paid <= 0 then[\s\S]*v_action := 'none'/);
  assert.match(
    migration,
    /v_actual_payment_fingerprint is distinct from v_expected_payment_fingerprint[\s\S]*payment history changed after confirmation/
  );
});

test("current paid owner drives balance and relock cannot bypass the decision", () => {
  assert.match(migration, /create or replace view public\.workforce_payout_effective_paid_allocations/);
  assert.match(migration, /workforce_payout_payment_allocation_credit_owner/);
  assert.match(migration, /union all[\s\S]*transfer\.destination_workforce_id as credited_workforce_id/);
  assert.match(migration, /later\.sequence_no > transfer\.sequence_no/);
  const effectiveView = migration.match(
    /create or replace view public\.workforce_payout_effective_paid_allocations[\s\S]*?revoke all on public\.workforce_payout_effective_paid_allocations/
  )?.[0];
  assert.ok(effectiveView);
  assert.doesNotMatch(effectiveView, /workforce_payout_payment_allocation_credit_owner\(/);
  assert.match(migration, /credited_workforce_id = v_workforce_id/);
  assert.match(migration, /guard_workforce_payout_paid_mapping_decision_on_relock/);
  assert.match(migration, /before insert on public\.workforce_payout_mapping_relocks/);
  assert.match(migration, /choose whether to transfer paid payment details or keep them with the existing dropx id/);
});

test("only finalized paid allocations move and original bank rows remain untouched", () => {
  assert.match(migration, /where item\.status = 'paid'/);
  assert.match(migration, /effective\.credited_workforce_id = v_source_workforce/);
  assert.match(migration, /effective\.period_end >= v_effective_from/);
  assert.match(migration, /v_transferred_count <> v_allocation_count or v_transferred <> v_paid/);
  assert.match(migration, /ambiguous_allocation_count/);
  assert.match(migration, /consolidated bank allocation for multiple provider ids/);
  assert.match(migration, /original bank item, beneficiary, reference and utr\/cin remain immutable/);
});

test("keep and no-history replacements may change station but paid transfer may not", () => {
  assert.match(
    migration,
    /if v_action = 'transfer'\s+and v_station_id is distinct from v_old_mapping\.station_id/
  );
  assert.match(migration, /'ambiguous_allocation_count', period\.ambiguous_allocation_count/);
  assert.match(migration, /'partial_period_allocation_count', period\.partial_period_allocation_count/);
  assert.match(
    migration,
    /if v_action = 'transfer' and v_partial_period_allocation_count > 0/
  );
  const relockGuard = migration.match(
    /create or replace function public\.guard_workforce_payout_paid_mapping_decision_on_relock\(\)[\s\S]*?\$function\$;/
  )?.[0];
  assert.ok(relockGuard);
  assert.doesNotMatch(relockGuard, /mapping\.station_id = v_old_mapping\.station_id/);
  assert.match(relockGuard, /for v_current_mapping in/);
});
