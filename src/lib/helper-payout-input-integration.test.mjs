import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const migration = source("../../supabase/migrations/20261010190000_helper_payout_inputs.sql");
const importServer = source("./helper-payout-import-server.ts");
const loader = source("./helper-payout-loader.ts");
const route = source("../app/api/payments/workforce-payouts/bulk-upload/route.ts");
const bulkComponent = source("../components/workforce-payout-bulk-upload.tsx");
const manualComponent = source("../components/workforce-payout-manual-editor.tsx");

test("Helper payout inputs use a tenant-safe parallel audit and current-value schema", () => {
  for (const table of [
    "helper_payout_import_batches",
    "helper_payout_import_rows",
    "helper_payout_attendance_values",
    "helper_additional_payment_values",
    "helper_payout_deduction_values"
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /foreign key \(company_id, helper_id\)[\s\S]*?references public\.helpers \(company_id, id\)/);
  assert.match(migration, /unique \(company_id, effective_from, effective_to, file_sha256\)/);
  assert.match(migration, /helper_payout_attendance_values_no_overlap[\s\S]*?daterange\(effective_from, effective_to, '\[\]'\) with &&/);
});

test("Helper importer revalidates allowed types, scope, allocation and processing lock atomically", () => {
  assert.match(migration, /create or replace function public\.helper_apply_payout_import/);
  assert.match(migration, /v_input_type not in \('ATTENDANCE', 'ADDITIONAL_PAYMENT', 'DEDUCTION'\)/);
  assert.match(migration, /p_allowed_location_ids is not null/);
  assert.match(migration, /attendance requires exactly one Helper payment allocation covering the complete range/);
  assert.match(migration, /helper_payout_input_processing_locked\(p_company_id, v_helper_id, v_station_id, v_from, v_to\)/);
  assert.match(migration, /cannot change because the Helper payment is Payment Processing/);
  assert.match(
    migration,
    /select distinct \(row_item ->> 'helper_id'\)::uuid[\s\S]*?order by helper\.id[\s\S]*?for update/
  );
  assert.match(migration, /No current[\s\S]*value or audit row is written until the complete payload has passed/i);
});

test("bulk/manual endpoints dispatch Helper input writes without changing the Workforce RPC", () => {
  assert.match(route, /audience === "helpers"[\s\S]*?processHelperPayoutImport/);
  assert.match(route, /audience !== "workforce"/);
  assert.match(route, /supabaseAdmin\.rpc\("workforce_apply_payout_import"/);
  assert.match(importServer, /HELPER_INPUT_TYPES = \["ATTENDANCE", "ADDITIONAL_PAYMENT", "DEDUCTION"\]/);
  assert.match(importServer, /supabaseAdmin\.rpc\("helper_apply_payout_import"/);
  assert.match(importServer, /Canonical company Helper DROPX_ID only/);
});

test("Helper loader overlays attendance, additions and manual deductions", () => {
  assert.match(loader, /from\("helper_payout_attendance_values"\)/);
  assert.match(loader, /from\("helper_additional_payment_values"\)/);
  assert.match(loader, /from\("helper_payout_deduction_values"\)/);
  assert.match(loader, /helperPayoutAttendanceInputForDate/);
  assert.match(loader, /calculateHelperPayoutAdjustments/);
  assert.match(loader, /additionalPaymentBreakdown: adjustments\.additionalPaymentBreakdown/);
  assert.match(loader, /netAmount: adjustments\.netAmount/);
});

test("existing payout editors carry an explicit audience while defaulting to Workforce", () => {
  for (const component of [bulkComponent, manualComponent]) {
    assert.match(component, /audience\?: "workforce" \| "helpers"/);
    assert.match(component, /audience = "workforce"/);
    assert.match(component, /body\.set\("audience", audience\)/);
  }
  assert.match(bulkComponent, /audience=.*encodeURIComponent\(audience\)/);
  assert.match(manualComponent, /HELPER_PAYOUT_MANUAL_INPUT_TYPES/);
  assert.match(manualComponent, /new URLSearchParams\(\{ effective_from: fromDate, effective_to: toDate, audience \}\)/);
});
