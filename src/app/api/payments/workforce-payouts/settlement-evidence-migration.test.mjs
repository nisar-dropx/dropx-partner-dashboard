import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../../../../supabase/migrations/20261013110000_payout_payment_settlement_evidence_manual_finalize.sql", import.meta.url),
  "utf8"
).toLowerCase();

test("paid history stores immutable response evidence for Workforce and Helpers", () => {
  for (const column of [
    "settled_amount",
    "response_debit_account_no",
    "response_value_date",
    "response_credit_account_no",
    "response_ifsc",
    "finalization_remarks"
  ]) {
    assert.match(migration, new RegExp(`add column if not exists ${column}`));
  }
  assert.match(migration, /capture_workforce_payout_response_evidence/);
  assert.match(migration, /capture_helper_payout_response_evidence/);
  assert.match(migration, /after insert on public\.workforce_payout_payment_response_imports/);
  assert.match(migration, /after insert on public\.helper_payout_payment_response_imports/);
  assert.match(migration, /response_credit_account_no = coalesce[\s\S]*?v_row ->> 'credit_account'/);
  assert.match(migration, /response_value_date = case[\s\S]*?v_row ->> 'value_date'/);
});

test("partial settlement is exact, bounded and drives every future paid total", () => {
  assert.match(migration, /settled_amount > 0 and settled_amount <= instruction_amount/);
  assert.match(migration, /paid amount cannot exceed the processing instruction amount/);
  assert.match(migration, /case when v_paid < v_item\.instruction_amount then 'partially_paid'/);
  assert.match(migration, /settled_amount_snapshot/);
  assert.match(migration, /allocation_cumulative/);
  assert.match(migration, /allocation_previous/);
  assert.match(migration, /effective\.settled_amount_snapshot/);
  assert.match(migration, /sum\(item\.settled_amount\)/);
  assert.equal(
    (migration.match(/where allocation\.settled_amount_snapshot > 0/g) ?? []).length,
    2,
    "zero-value rounded allocations must not enter current ownership or paid-credit transfers"
  );
});

test("manual finalization is audited, idempotent and available to both ledgers", () => {
  assert.match(migration, /create or replace function public\.workforce_finalize_payout_payment_item_manually/);
  assert.match(migration, /create or replace function public\.helper_finalize_payout_payment_item_manually/);
  assert.match(migration, /payment_paid_manually/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /only a payment processing instruction can be finalized manually/);
  assert.match(migration, /bank_response_status = 'manual_paid'/);
  assert.match(migration, /finalization_remarks = v_remarks/);
  assert.match(migration, /grant execute on function public\.workforce_finalize_payout_payment_item_manually/);
  assert.match(migration, /grant execute on function public\.helper_finalize_payout_payment_item_manually/);
});

test("legacy response replay remains stable after adding enriched evidence fields", () => {
  assert.match(migration, /create or replace function public\.payout_bank_response_core_rows/);
  assert.match(migration, /payout_bank_response_core_rows\(v_existing\.normalized_rows\)/);
  assert.match(migration, /debit account and value date must not make[\s\S]*?legacy file look like a different payment response/);
});

test("an exact legacy replay enriches terminal evidence without a second settlement", () => {
  assert.match(
    migration,
    /create or replace function public\.enrich_workforce_payout_response_evidence_on_replay/
  );
  assert.match(
    migration,
    /create or replace function public\.enrich_helper_payout_response_evidence_on_replay/
  );
  assert.match(
    migration,
    /payout_bank_response_core_rows\(v_import\.normalized_rows\)[\s\S]*?is distinct from public\.payout_bank_response_core_rows\(p_rows\)/
  );
  assert.match(migration, /response evidence replay requires an exact stored core-row match/);
  assert.match(migration, /v_occurrences <> 4/);
  assert.match(
    migration,
    /perform public\.enrich_workforce_payout_response_evidence_on_replay\('[\s\S]*?v_existing\.id, p_rows/
  );
  assert.match(
    migration,
    /perform public\.enrich_helper_payout_response_evidence_on_replay\('[\s\S]*?v_existing\.id, p_rows/
  );
  assert.match(
    migration,
    /revoke all on function public\.enrich_workforce_payout_response_evidence_on_replay\([\s\S]*?service_role/
  );
  assert.match(
    migration,
    /revoke all on function public\.enrich_helper_payout_response_evidence_on_replay\([\s\S]*?service_role/
  );

  for (const functionName of [
    "enrich_workforce_payout_response_evidence_on_replay",
    "enrich_helper_payout_response_evidence_on_replay"
  ]) {
    const start = migration.indexOf(`create or replace function public.${functionName}`);
    const end = migration.indexOf("$function$;", start);
    assert.ok(start >= 0 && end > start, `${functionName} must be defined`);
    const body = migration.slice(start, end);
    assert.doesNotMatch(body, /set settled_amount\s*=/);
    assert.doesNotMatch(body, /insert into public\..*payment_(?:events|response_imports)/);
    assert.doesNotMatch(body, /set status\s*=/);
  }
});

test("settlement evidence is commit-time mandatory and terminal rows remain immutable", () => {
  assert.match(migration, /create constraint trigger workforce_payout_payment_items_99_settlement_evidence/);
  assert.match(migration, /create constraint trigger helper_payout_payment_items_99_settlement_evidence/);
  assert.match(migration, /deferrable initially deferred/);
  assert.match(migration, /paid payout instructions require a valid settled amount and immutable bank evidence/);
  assert.match(migration, /a terminal workforce payout payment instruction is immutable/);
  assert.match(migration, /a terminal helper payout payment instruction is immutable/);
});

test("the Workforce item guard retains cross-batch processing serialization", () => {
  assert.match(migration, /from public\.workforce workforce[\s\S]*?for update/);
  assert.match(migration, /existing\.status = 'processing'/);
  assert.match(migration, /existing\.batch_id <> new\.batch_id/);
  assert.match(migration, /a different workforce bank batch is already processing this profile and month/);
});
