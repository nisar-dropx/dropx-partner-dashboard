import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const bankFile = read("./bank-file/route.ts");
const redownload = read("./bank-file/re-download/route.ts");
const response = read("./bank-response/route.ts");
const status = read("./payment-status/route.ts");
const history = read("./payment-history/route.ts");
const fedOne = read("../../../../lib/workforce-payout-bank-file.ts");
const ledger = read("../../../../../supabase/migrations/20261010210000_helper_payout_bank_payment_ledger.sql");
const publication = read("../../../../../supabase/migrations/20261010200000_helper_payout_publication_notifications.sql");

test("bank APIs opt into Helper ledgers without changing the Workforce default", () => {
  for (const route of [bankFile, redownload, response, status, history]) {
    assert.match(route, /"workforce" \| "helpers"/);
    assert.match(route, /String\(value \?\? "workforce"\)/);
  }
  assert.match(bankFile, /loadHelperPayoutRows\(/);
  assert.match(bankFile, /year < 1900 \|\| year > 9999/);
  assert.match(bankFile, /current_target_amount: Math\.round\(target \* 100\) \/ 100/);
  assert.match(bankFile, /current_snapshot_hash: helperPayoutPublicationSnapshotHash/);
  assert.match(bankFile, /JSON\.stringify\(\{[\s\S]*?valueDate,[\s\S]*?payoutRows[\s\S]*?\}\)/);
  assert.doesNotMatch(bankFile, /payoutRows:\s*authoritativeRows/);
  const fingerprintStart = bankFile.indexOf("const requestFingerprint =");
  const fingerprintEnd = bankFile.indexOf('.digest("hex")', fingerprintStart);
  assert.ok(fingerprintStart >= 0 && fingerprintEnd > fingerprintStart);
  assert.doesNotMatch(
    bankFile.slice(fingerprintStart, fingerprintEnd),
    /\baudience\b/,
    "the canonical hash must remain compatible with existing Workforce batches"
  );
  assert.match(bankFile, /rpc\("helper_replay_payout_payment_row_batch"/);
  assert.ok(
    bankFile.indexOf('rpc("helper_replay_payout_payment_row_batch"')
      < bankFile.indexOf("loadHelperPayoutRows("),
    "committed Helper batches must replay before mutable live payouts are loaded"
  );
  assert.match(bankFile, /rpc\("helper_create_payout_payment_row_batch"/);
  assert.match(bankFile, /rpc\("workforce_create_payout_payment_row_batch"/);
  assert.match(bankFile, /referencePrefix: audience === "helpers" \? "HP" : "WP"/);
  assert.match(redownload, /rpc\("helper_get_payout_payment_redownload"/);
  assert.match(redownload, /buildBatchWorkbook\(batchItems, audience\)/);
  assert.match(response, /form\.get\("audience"\)/);
  assert.match(response, /referencePrefix: audience === "helpers" \? "HP" : "WP"/);
  assert.match(response, /rpc\("helper_finalize_payout_payment_response"/);
  assert.match(status, /rpc\("helper_cancel_payout_payment_items"/);
  assert.match(status, /rpc\("helper_transition_payout_payment_item"/);
  assert.match(status, /rpc\("helper_set_payout_payment_hold"/);
  assert.match(history, /from\("helper_payout_payment_items"\)/);
  assert.match(history, /from\("helper_payout_payment_hold_events"\)/);
  assert.match(history, /from\("helper_payout_payment_batches"\)/);
  assert.match(fedOne, /referencePrefix\?: "WP" \| "HP"/);
  assert.match(fedOne, /referencePrefix === "HP"[\s\S]*?\^HP/);
});

test("Helper bank ledger is isolated, location-scoped and publication-backed", () => {
  for (const table of [
    "helper_payout_payment_batches",
    "helper_payout_payment_response_imports",
    "helper_payout_payment_items",
    "helper_payout_payment_events",
    "helper_payout_payment_hold_events"
  ]) {
    assert.match(ledger, new RegExp(`create table public\\.${table}`));
    assert.match(ledger, new RegExp(`alter table public\\.${table} force row level security`));
  }
  assert.match(publication, /create table if not exists public\.helper_payout_publications/);
  assert.match(publication, /helper_payout_publications_company_id_id_uidx/);
  assert.match(ledger, /references public\.helper_payout_publications\(company_id, id\)/);
  assert.match(ledger, /publication\.snapshot #>> '\{item,net_amount\}'/);
  assert.match(ledger, /v_publication\.snapshot_hash/);
  assert.match(ledger, /eligibility_code := 'publication_outdated'/);
  assert.match(ledger, /review\.status[\s\S]*?in \('under_review','approved'\)/);
  assert.match(ledger, /location_id_snapshot uuid not null/);
  assert.doesNotMatch(ledger, /helper_payout_payment_allocations/);
  assert.doesNotMatch(ledger, /workforce_payout_mapping_(?:relocks|revision_state)/);
});

test("Helper bank lifecycle enforces active, PAN, hold and delta-payment gates", () => {
  assert.match(ledger, /v_helper\.is_active is distinct from true/);
  assert.match(ledger, /onboarding_status[\s\S]*?<> 'active'/);
  assert.match(ledger, /verification\.profile_type = 'worker'/);
  assert.match(ledger, /eligibility_code := 'pan_not_linked'/);
  assert.match(ledger, /eligibility_code := 'payment_on_hold'/);
  assert.match(ledger, /balance_payable := greatest\(current_target_amount - paid_amount, 0\)/);
  assert.match(ledger, /when paid_amount > 0 then 'Partially Paid'/);
  assert.match(ledger, /where status = 'processing'/);
  assert.match(ledger, /create or replace function public\.helper_payout_input_processing_locked/);
  assert.match(ledger, /item\.location_id_snapshot = p_station_id/);
  assert.match(ledger, /create trigger helper_payment_allocations_90_processing_guard/);
  assert.match(ledger, /execute function public\.guard_helper_payout_allocation_processing\(\)/);
  assert.match(ledger, /daterange\(old\.effective_from, coalesce\(old\.effective_to, 'infinity'::date\), '\[\]'\)/);
  assert.match(ledger, /daterange\(new\.effective_from, coalesce\(new\.effective_to, 'infinity'::date\), '\[\]'\)/);
  assert.match(ledger, /reference_no ~ '\^HP/);
  assert.match(ledger, /create or replace function public\.helper_payout_payment_reference\(\s*p_helper_id uuid/);
  assert.match(ledger, /replace\(coalesce\(p_helper_id::text, ''\), '-', ''\)/);
  assert.match(ledger, /debit_remarks_snapshot = 'NET PAY'/);
  assert.match(ledger, /credit_remarks_snapshot = location_code_snapshot/);
  assert.match(ledger, /value_date between date '1900-01-01' and date '9999-12-31'/);
});

test("all Helper payment mutations are service-only and audited", () => {
  for (const rpc of [
    "helper_preview_payout_payment_rows",
    "helper_replay_payout_payment_row_batch",
    "helper_create_payout_payment_row_batch",
    "helper_finalize_payout_payment_response",
    "helper_transition_payout_payment_item",
    "helper_set_payout_payment_hold",
    "helper_cancel_payout_payment_items",
    "helper_get_payout_payment_redownload"
  ]) {
    assert.match(ledger, new RegExp(`create or replace function public\\.${rpc}`));
    assert.match(ledger, new RegExp(`grant execute on function public\\.${rpc}[\\s\\S]*?to service_role`));
  }
  assert.match(ledger, /payment_instruction_created/);
  assert.match(ledger, /bank_file_generated/);
  assert.match(ledger, /bank_response_imported/);
  assert.match(ledger, /payment_cancelled_bulk/);
  assert.match(ledger, /guard_helper_payout_payment_item_ledger/);
});

test("paid UTRs are claimed atomically across Workforce and Helper ledgers", () => {
  assert.match(ledger, /create table public\.payout_bank_paid_transaction_registry/);
  assert.match(ledger, /primary key \(company_id, normalized_utr\)/);
  assert.match(ledger, /create trigger workforce_payout_payment_items_90_paid_transaction_claim/);
  assert.match(ledger, /create trigger helper_payout_payment_items_90_paid_transaction_claim/);
  assert.match(ledger, /execute function public\.claim_payout_bank_paid_transaction\(\)/);
  assert.match(ledger, /This UTR\/CIN is already recorded for another paid instruction/);
});

test("terminal Helper payment RPCs serialize batch status recomputation", () => {
  const functionBody = (name) => {
    const start = ledger.indexOf(`create or replace function public.${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const end = ledger.indexOf("$function$;", start);
    assert.notEqual(end, -1, `unterminated ${name}`);
    return ledger.slice(start, end);
  };

  for (const name of [
    "helper_finalize_payout_payment_response",
    "helper_transition_payout_payment_item",
    "helper_cancel_payout_payment_items"
  ]) {
    const body = functionBody(name);
    const helperLock = body.indexOf("from public.helpers helper");
    const batchLock = body.indexOf("from public.helper_payout_payment_batches batch");
    const itemLock = [
      body.indexOf("perform 1 from public.helper_payout_payment_items item", batchLock),
      body.indexOf("select item.* into v_item from public.helper_payout_payment_items item", batchLock)
    ].filter((position) => position >= 0).sort((left, right) => left - right)[0] ?? -1;
    assert.ok(helperLock >= 0, `${name} must lock Helper rows`);
    assert.ok(batchLock > helperLock, `${name} must lock batches after Helpers`);
    assert.ok(itemLock > batchLock, `${name} must lock items after batches`);
    assert.match(
      body.slice(batchLock, itemLock),
      /order by batch\.id for update/,
      `${name} must lock affected batches deterministically`
    );
  }
});

test("Helper payment retries serialize before authoritative replay checks", () => {
  const functionBody = (name) => {
    const start = ledger.indexOf(`create or replace function public.${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const end = ledger.indexOf("$function$;", start);
    assert.notEqual(end, -1, `unterminated ${name}`);
    return ledger.slice(start, end);
  };

  const replayTargets = new Map([
    ["helper_create_payout_payment_row_batch", "select batch.* into v_existing"],
    ["helper_finalize_payout_payment_response", "select imported.* into v_existing"],
    ["helper_transition_payout_payment_item", "select event.* into v_existing"],
    ["helper_set_payout_payment_hold", "select hold.* into v_existing"],
    ["helper_cancel_payout_payment_items", "select event.* into v_existing"]
  ]);
  for (const [name, replayTarget] of replayTargets) {
    const body = functionBody(name);
    const advisoryLock = body.indexOf("pg_catalog.pg_advisory_xact_lock");
    const replayCheck = body.indexOf(replayTarget);
    assert.ok(advisoryLock >= 0, `${name} must take an idempotency mutex`);
    assert.ok(replayCheck > advisoryLock, `${name} must lock before its replay lookup`);
  }

  const finalize = functionBody("helper_finalize_payout_payment_response");
  assert.match(finalize, /helper-payout-payment-response-operation:/);
  assert.match(finalize, /helper-payout-payment-response-file:/);
  assert.match(finalize, /least\(v_operation_lock_key, v_file_lock_key\)/);
  assert.match(finalize, /greatest\(v_operation_lock_key, v_file_lock_key\)/);

  for (const name of [
    "helper_transition_payout_payment_item",
    "helper_cancel_payout_payment_items"
  ]) {
    assert.match(
      functionBody(name),
      /helper-payout-payment-event-operation:/,
      `${name} must serialize the shared payment-event operation ID namespace`
    );
  }
  assert.match(
    functionBody("helper_cancel_payout_payment_items"),
    /v_existing\.actor_user_id <> p_actor_user_id/,
    "bulk-cancellation replay must remain bound to its original actor"
  );
});

test("Helper allocation guard locks subjects before checking processing items", () => {
  const start = ledger.indexOf(
    "create or replace function public.guard_helper_payout_allocation_processing()"
  );
  assert.notEqual(start, -1);
  const end = ledger.indexOf("$function$;", start);
  assert.notEqual(end, -1);
  const body = ledger.slice(start, end);
  const helperLock = body.indexOf("perform 1 from public.helpers helper");
  const processingCheck = body.indexOf("from public.helper_payout_payment_items item");
  assert.ok(helperLock >= 0);
  assert.ok(processingCheck > helperLock);
  assert.match(body.slice(helperLock, processingCheck), /order by helper\.company_id, helper\.id for update/);
});

test("Helper Processing freezes every live calculation and publication source", () => {
  assert.match(
    ledger,
    /create or replace function public\.workforce_payout_payment_interval_is_processing[\s\S]*?public\.workforce_payout_payment_items[\s\S]*?public\.helper_payout_payment_items/
  );
  assert.match(ledger, /create trigger helpers_90_payout_processing_guard/);
  assert.match(ledger, /create trigger helper_payout_publications_01_processing_guard/);
  assert.match(ledger, /item\.location_id_snapshot = p_station_id/);
  assert.match(ledger, /create trigger workforce_payout_review_submissions_01_helper_processing_guard/);
  assert.match(ledger, /v_subject_type = ''helper''[\s\S]*?helper_assert_payout_not_processing/);

  for (const table of [
    "stations",
    "workforce_deduction_heads",
    "workforce_additional_payment_fields",
    "payment_method_components",
    "payment_fields",
    "payment_methods"
  ]) {
    assert.match(ledger, new RegExp(`'${table}'`));
  }
  for (const table of [
    "helper_payment_allocations",
    "helper_payout_attendance_values",
    "helper_additional_payment_values",
    "helper_payout_deduction_values"
  ]) {
    assert.match(
      ledger,
      new RegExp(`\\$helper_source_truncate_guards\\$[\\s\\S]*?'${table}'`),
      `${table} must have a processing-aware TRUNCATE backstop`
    );
  }
  assert.match(ledger, /biometric_enrolments_helper_processing_insert/);
  assert.match(ledger, /attendance_daily_helper_processing_insert/);
  assert.match(ledger, /connect_profile_verifications_helper_processing_update/);

  const functionBody = (name) => {
    const start = ledger.indexOf(`create or replace function public.${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const end = ledger.indexOf("$function$;", start);
    assert.notEqual(end, -1, `unterminated ${name}`);
    return ledger.slice(start, end);
  };
  for (const name of [
    "guard_helper_payout_company_source_processing",
    "guard_helper_payout_period_source_processing",
    "guard_helper_payout_source_truncate_processing"
  ]) {
    const body = functionBody(name);
    assert.doesNotMatch(
      body,
      /from public\.helpers helper[\s\S]*?for update/,
      `${name} must not invert master-row -> Helper lock ordering`
    );
    assert.match(body, /lock_workforce_payment_allocation_company/);
    assert.match(body, /helper_payout_payment_items/);
  }
});
