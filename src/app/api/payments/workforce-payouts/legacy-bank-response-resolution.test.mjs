import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./bank-response/route.ts", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../../../../../supabase/migrations/20261013120000_legacy_payout_bank_response_reference_resolution.sql", import.meta.url),
  "utf8"
).toLowerCase();

test("bare DropX bank rows are resolved per row before the existing mixed finalizer", () => {
  assert.match(route, /prepared\.legacyReferenceCandidates/);
  assert.match(route, /rpc\("resolve_owned_payout_legacy_response_references"/);
  assert.match(route, /row_number: candidate\.rowNumber/);
  assert.match(route, /debit_amount_paise: candidate\.debitAmountPaise/);
  assert.match(route, /status: candidate\.status/);
  assert.match(route, /utr_cin: candidate\.utrCin/);
  assert.match(route, /new Map<number, string>\(\)/);
  assert.match(route, /parsePreparedDropxFedOneResponse\(prepared, ownedReferences, rowReferenceAliases\)/);
  assert.match(route, /resolved payment reference no longer belongs to this company/);
});

test("resolver uses immutable Workforce and Helper ledgers with exact ID and amount", () => {
  assert.match(migration, /from public\.workforce_payout_payment_items item/);
  assert.match(migration, /from public\.helper_payout_payment_items item/);
  assert.match(migration, /payout_bank_reference_dropx_canonical\(item\.dropx_id_snapshot\) = v_dropx_id/);
  assert.match(migration, /item\.status = 'processing'/);
  assert.equal(
    (migration.match(/round\(item\.instruction_amount \* 100, 0\)::bigint = v_input\.debit_amount_paise/g) ?? []).length,
    4,
    "both processing ledgers and both paid-replay ledgers must match the exact immutable instruction amount"
  );
});

test("account and IFSC disambiguate multiple instructions but are not mandatory equality gates", () => {
  assert.match(migration, /bank_account_no_snapshot\) = v_credit_account[\s\S]*?then 2 else 0/);
  assert.match(migration, /ifsc_snapshot\) = v_ifsc[\s\S]*?then 1 else 0/);
  assert.match(migration, /if v_candidate_count = 1 then[\s\S]*?resolution_state := 'resolved'/);
  assert.match(migration, /if v_best_score > 0 and v_best_count = 1 then/);
  assert.match(migration, /match %s payment processing instructions/);
});

test("paid replay wins only on exact normalized UTR, DropX ID and amount", () => {
  const replay = migration.indexOf("same-file or equivalent re-uploads");
  const processing = migration.indexOf("'workforce'::text as audience", replay + 1);
  assert.ok(replay >= 0 && processing > replay);
  assert.match(migration.slice(replay), /v_status = 'paid'/);
  assert.match(migration.slice(replay), /item\.status = 'paid'/);
  assert.match(migration.slice(replay), /regexp_replace\([\s\S]*?coalesce\(item\.utr_cin, ''\)[\s\S]*?\) = v_utr/);
  assert.match(migration, /historical payment evidence is ambiguous, so nothing was finalized/);
});

test("unowned bank references stay skippable while owned zero matches are actionable", () => {
  assert.match(migration, /if v_owned_count = 0 then[\s\S]*?resolution_state := 'unrelated'/);
  assert.match(migration, /no payment processing instruction has the exact bank amount/);
  assert.match(migration, /nothing was finalized/);
  assert.match(migration, /revoke all on function public\.resolve_owned_payout_legacy_response_references\(uuid,jsonb\)/);
  assert.match(migration, /grant execute on function public\.resolve_owned_payout_legacy_response_references\(uuid,jsonb\)[\s\S]*?to service_role/);
  assert.doesNotMatch(migration, /to (?:public|anon|authenticated)\s*;/);
});
