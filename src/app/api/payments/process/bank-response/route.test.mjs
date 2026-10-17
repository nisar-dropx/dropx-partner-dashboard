import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const route = read("./route.ts");
const panel = read("../../../../../components/payment-process-panel.tsx");
const page = read("../../../../payments/process/page.tsx");
const legacyProcessAction = read("../../../../payments/process/actions.ts");
const workforceDialog = read("../../../../../components/workforce-payout-bank-dialog.tsx");
const workforceRoute = read("../../workforce-payouts/bank-response/route.ts");
const migration = read("../../../../../../supabase/migrations/20261017123000_central_bank_response_finalizer.sql");
const partialMigration = read("../../../../../../supabase/migrations/20261017150000_central_bank_response_partial_rows.sql");

test("central bank import accepts multiple bounded files and reports each file independently", () => {
  assert.match(route, /const MAX_FILES = 20;/);
  assert.match(route, /const MAX_FILE_BYTES = 10 \* 1024 \* 1024;/);
  assert.match(route, /const MAX_TOTAL_BYTES = 50 \* 1024 \* 1024;/);
  assert.match(route, /const MAX_RESPONSE_ROWS_PER_FILE = 5000;/);
  assert.match(route, /const MAX_RESPONSE_ROWS_PER_REQUEST = 20_000;/);
  assert.match(route, /form\.getAll\("bank_response_files"\)/);
  assert.match(route, /files\.length > MAX_FILES/);
  assert.match(route, /totalBytes > MAX_TOTAL_BYTES/);
  assert.match(route, /file\.size > MAX_FILE_BYTES/);
  assert.match(route, /prepared\.dataRowCount === 0[\s\S]*?No payment response rows were found below the bank response headers/);
  assert.match(route, /for \(const file of files\)[\s\S]*?processFile\(\{ authorization, bytes, companyId, file, prepared \}\)/);
  assert.match(route, /results\.push\(\{ error: errorMessage\(error\), fileName: file\.name, ok: false \}\)/);

  assert.match(panel, /fetch\("\/api\/payments\/process\/bank-response"/);
  assert.match(panel, /name="bank_response_files"/);
  assert.match(panel, /\bmultiple\b/);
  assert.match(panel, /Select up to 20 Federal Bank enquiry files/);
  assert.match(panel, /finalizeResults\.map/);
});

test("central finalization is edit-only and applies each ledger's location and feature gate", () => {
  assert.match(route, /authorization\.readOnly \|\| !hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(route, /hasPermission\(input\.authorization, "workforce_payouts", "edit"\)/);
  assert.match(route, /canEditPayouts && inLocationScope\(input\.authorization, workforce\.location_id_snapshot\)/);
  assert.match(route, /canEditPayouts && inLocationScope\(input\.authorization, helper\.location_id_snapshot\)/);
  assert.match(route, /ledger === "payroll"[\s\S]*?inLocationScope\(input\.authorization, payroll\.location_id\)/);
  assert.match(route, /canProcessPayment\(input\.authorization, paymentRequest, owner\)/);
  assert.match(route, /row\.ledger === "people_payroll"[\s\S]*?location_id: row\.location_id/);
  assert.match(migration, /person\.location_id/i);
  assert.match(migration, /left join public\.hr_payroll_run_people person/i);
  assert.match(route, /authorization\.hasAllLocationAccess/);
  assert.match(route, /authorization\.locationScopeIds/);

  assert.match(page, /canEdit=\{pagePermission\.canEdit && !authorization\.readOnly\}/);
  assert.match(page, /hasAllLocationAccess \|\| Boolean\(request\.location_id && locationScopeIds\.includes\(request\.location_id\)\)/);
  assert.match(panel, /action=\{canEdit \?/);
});

test("ownership is resolved across all ledgers and a collision becomes a row error", () => {
  assert.match(route, /rpc\("resolve_central_bank_response_references", \{[\s\S]*?p_company_id: companyId,[\s\S]*?p_references: normalized/);
  for (const ledger of ["workforce", "helpers", "payment_requests", "people_payroll"]) {
    assert.match(migration, new RegExp(`'${ledger}'`));
  }
  for (const table of ["workforce_payout_payment_items", "helper_payout_payment_items", "payment_requests", "hr_payroll_bank_lines"]) {
    assert.match(migration, new RegExp(`public\\.${table}`));
  }
  assert.match(route, /prepared\.legacyReferenceCandidates/);
  assert.doesNotMatch(
    route,
    /candidatesWithoutExactOwner/,
    "bare DropX aliases must still be resolved when an exact generic or payroll owner exists"
  );
  assert.match(route, /uniqueOwner\(ownerMaps\.paymentRequests/);
  assert.match(route, /uniqueOwner\(ownerMaps\.payroll/);
  assert.match(route, /resolveCentralBankRowOwner\(\{/);
  assert.match(route, /Do not reveal whether an ambiguous reference exists outside/);
  assert.match(route, /parsePreparedFedOneResponseRowsPartially\(prepared, permittedReferences, rowAliases\)/);
});

test("one partial central RPC is issued per accepted file with all four ledger subsets", () => {
  assert.equal(route.match(/rpc\("finalize_central_bank_response_partially"/g)?.length, 1);
  assert.match(route, /p_payment_request_rows: rowsByLedger\.payment_requests\.map\(centralBankRpcRow\)/);
  assert.match(route, /p_workforce_rows: rowsByLedger\.workforce\.map\(centralBankRpcRow\)/);
  assert.match(route, /p_helper_rows: rowsByLedger\.helpers\.map\(centralBankRpcRow\)/);
  assert.match(route, /p_payroll_rows: rowsByLedger\.payroll\.map\(centralBankRpcRow\)/);
  assert.match(route, /databaseResult\.payment_request_events/);
  assert.match(route, /paymentRequestEvents\.map\(\(event\) => sendPaymentRequestSideEffects/);
  assert.match(route, /paidRows: resultCount\(databaseResult, "paid"\)/);
  assert.match(route, /failedRows/);
  assert.match(route, /replayedFile: databaseResult\.replayed === true/);
  assert.match(panel, /Already imported · original result:/);
  assert.match(route, /rejectedRows: resultCount\(databaseResult, "rejected"\)/);
  assert.match(route, /resultCount\(databaseResult, "replayed_items"\)/);
  assert.match(route, /unknownRows: resultCount\(databaseResult, "unknown"\)/);
  assert.match(route, /totalCancelled = resultCount\(databaseResult, "cancelled"\)/);
});

test("mixed files finalize valid rows while returning row-specific failures for red UI display", () => {
  assert.match(route, /parsePreparedFedOneResponseRowsPartially\(prepared, permittedReferences, rowAliases\)/);
  assert.match(route, /rpc\("finalize_central_bank_response_partially"/);
  assert.match(route, /databaseResult\.row_errors/);
  assert.match(route, /rowErrors:/);
  assert.match(route, /successfullyMatchedRows/);
  assert.match(route, /skipped: Math\.max\(0, prepared\.dataRowCount - successfullyMatchedRows\.length\)/);
  assert.match(panel, /rowErrors\?: Array/);
  assert.match(panel, /result\.rowErrors\.map/);
  assert.match(panel, /Row \{rowError\.rowNumber\}/);
  assert.match(panel, /rowError\.referenceNo/);
  assert.match(panel, /rowError\.message/);
  assert.match(panel, /color: "#b91c1c"/);
});

test("route payload matches the service-only central finalizer contract", () => {
  assert.match(
    migration,
    /create or replace function public\.finalize_central_bank_response\(\s*p_company_id uuid,\s*p_actor_user_id uuid,\s*p_operation_id uuid,\s*p_file_sha256 text,\s*p_file_name text,\s*p_workforce_rows jsonb,\s*p_helper_rows jsonb,\s*p_payment_request_rows jsonb,\s*p_payroll_rows jsonb\s*\)/i
  );
  assert.match(migration, /public\.finalize_owned_payout_payment_response\(/);
  assert.match(migration, /public\.hr_sync_paid_pay_documents\(/);
  assert.match(migration, /create or replace function public\.resolve_central_bank_response_references\(\s*p_company_id uuid,\s*p_references jsonb\s*\)/i);
  assert.match(migration, /grant execute on function public\.resolve_central_bank_response_references\(uuid, jsonb\)[\s\S]*?to service_role;/i);
  assert.match(migration, /revoke all on function public\.finalize_central_bank_response[\s\S]*?from public, anon, authenticated, service_role;/i);
  assert.match(migration, /grant execute on function public\.finalize_central_bank_response[\s\S]*?to service_role;/i);
  assert.match(
    partialMigration,
    /create or replace function public\.finalize_central_bank_response_partially\(\s*p_company_id uuid,\s*p_actor_user_id uuid,\s*p_operation_id uuid,\s*p_file_sha256 text,\s*p_file_name text,\s*p_workforce_rows jsonb,\s*p_helper_rows jsonb,\s*p_payment_request_rows jsonb,\s*p_payroll_rows jsonb\s*\)/i
  );
  assert.match(partialMigration, /revoke all on function public\.finalize_central_bank_response_partially[\s\S]*?from public, anon, authenticated, service_role;/i);
  assert.match(partialMigration, /grant execute on function public\.finalize_central_bank_response_partially[\s\S]*?to service_role;/i);
  assert.match(migration, /create unique index[\s\S]*?on public\.central_bank_response_imports\(company_id, operation_id\)/i);
  assert.match(migration, /create unique index[\s\S]*?on public\.central_bank_response_imports\(company_id, file_sha256, normalized_payload_hash\)/i);
});

test("existing Workforce and legacy Process upload handlers remain available", () => {
  assert.match(workforceDialog, /\/api\/payments\/workforce-payouts\/bank-response/);
  assert.match(workforceDialog, /bank_response_file/);
  assert.match(workforceRoute, /finalize_owned_payout_payment_response/);
  assert.match(legacyProcessAction, /export async function finalizePaymentProcess/);
  assert.match(legacyProcessAction, /formData\.get\("bank_response_file"\)/);
});
