import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bankFileRoute = readFileSync(new URL("./bank-file/route.ts", import.meta.url), "utf8");
const bankResponseRoute = readFileSync(new URL("./bank-response/route.ts", import.meta.url), "utf8");
const historyRoute = readFileSync(new URL("./payment-history/route.ts", import.meta.url), "utf8");
const paymentStatusRoute = readFileSync(new URL("./payment-status/route.ts", import.meta.url), "utf8");
const table = readFileSync(new URL("../../../../components/workforce-payout-table.tsx", import.meta.url), "utf8");
const bankDialog = readFileSync(new URL("../../../../components/workforce-payout-bank-dialog.tsx", import.meta.url), "utf8");
const actionSelection = readFileSync(new URL("../../../../lib/workforce-payout-action-selection.ts", import.meta.url), "utf8");
const publicationRefresh = readFileSync(new URL("../../../../lib/workforce-payout-publication-refresh.ts", import.meta.url), "utf8");
const historyButton = readFileSync(new URL("../../../../components/workforce-payout-payment-history-button.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../../../app/payments/workforce-payouts/page.tsx", import.meta.url), "utf8");
const snapshot = readFileSync(new URL("../../../../lib/workforce-payout-publication-snapshot.ts", import.meta.url), "utf8");
const lifecycleMigration = readFileSync(new URL("../../../../../supabase/migrations/20261009172942_workforce_payout_manual_status_and_holds.sql", import.meta.url), "utf8");
const rowSelectionMigration = readFileSync(new URL("../../../../../supabase/migrations/20261010130000_workforce_payout_location_row_bank_selection.sql", import.meta.url), "utf8");

test("bank-file creation is company-scoped, privileged, transport-bounded and idempotent without a row cap", () => {
  assert.match(bankFileRoute, /sameOrigin\(request\)/);
  assert.match(bankFileRoute, /hasPermission\(authorization, payoutPageCode, "edit"\)/);
  assert.match(bankFileRoute, /hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(bankFileRoute, /authorization\.hasAllLocationAccess/);
  assert.match(bankFileRoute, /requireCompanyId\(authorization\)/);
  assert.doesNotMatch(bankFileRoute, /MAX_SELECTION/);
  assert.match(bankFileRoute, /MAX_REQUEST_BYTES = 4 \* 1024 \* 1024/);
  assert.match(bankFileRoute, /new TextEncoder\(\)\.encode\(raw\)\.byteLength > MAX_REQUEST_BYTES/);
  assert.match(bankFileRoute, /Select at least one unique Workforce payout row/);
  assert.match(bankFileRoute, /completeCalendarMonth\(periodStart, periodEnd\)/);
  assert.match(bankFileRoute, /new Set\(keys\)\.size !== keys\.length/);
  assert.match(bankFileRoute, /payoutRows\.map\(\(row\) => \(\{/);
  assert.match(bankFileRoute, /p_operation_id: operationId/);
  assert.match(bankFileRoute, /p_request_fingerprint: requestFingerprint/);
  assert.match(bankFileRoute, /rpc\("workforce_create_payout_payment_row_batch"/);
  assert.match(bankFileRoute, /Cache-Control": "private, no-store"/);
});

test("bank-file creation refreshes only the selected exact-period publications before the authoritative payment gate", () => {
  assert.match(bankFileRoute, /refreshWorkforcePayoutPublicationJobs\(\{/);
  assert.match(bankFileRoute, /authorization: access\.authorization/);
  assert.match(bankFileRoute, /companyId: access\.companyId/);
  assert.match(bankFileRoute, /payoutRows,[\s\S]*?periodStart,[\s\S]*?periodEnd,/);
  assert.match(bankFileRoute, /deadlineAtMs: Date\.now\(\) \+ 240_000/);
  assert.match(bankFileRoute, /limit: 100/);
  assert.ok(
    bankFileRoute.indexOf("refreshWorkforcePayoutPublicationJobs({")
      < bankFileRoute.indexOf('rpc("workforce_create_payout_payment_row_batch"'),
    "the selected publication refresh must finish before transactional batch creation"
  );
  assert.match(bankFileRoute, /warning\.code !== "queue_status_failed"/);
  assert.match(bankFileRoute, /blockingRefreshWarning \|\| refreshResult\.failed > 0/);
  assert.match(bankFileRoute, /No payment batch was created/);
  assert.match(bankFileRoute, /authoritative second gate/);
  assert.match(publicationRefresh, /payoutRows\?: Array<\{ workforceId: string; stationId: string \}>/);
  assert.match(publicationRefresh, /rpc\("workforce_claim_selected_payout_publication_row_refresh_jobs"/);
  assert.match(publicationRefresh, /workforce_id: row\.workforceId,[\s\S]*?station_id: row\.stationId/);
});

test("bank-file re-download is permitted only for a wholly processing immutable batch", () => {
  assert.match(bankFileRoute, /batch_id/);
  assert.match(bankFileRoute, /String\(batch\.status\) !== "processing"/);
  assert.match(bankFileRoute, /items\.some\(\(item\) => String\(item\.status\) !== "processing"\)/);
  assert.match(bankFileRoute, /Only an entirely unfinalized Payment Processing batch can be downloaded again/);
  assert.match(bankFileRoute, /X-Workforce-Payout-Batch-Id/);
});

test("bank response import is privileged, bounded and file-hash idempotent", () => {
  assert.match(bankResponseRoute, /sameOrigin\(request\)/);
  assert.match(bankResponseRoute, /hasPermission\(authorization, payoutPageCode, "edit"\)/);
  assert.match(bankResponseRoute, /hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(bankResponseRoute, /authorization\.hasAllLocationAccess/);
  assert.match(bankResponseRoute, /MAX_FILE_BYTES = 10 \* 1024 \* 1024/);
  assert.match(bankResponseRoute, /\.xlsx\?/);
  assert.match(bankResponseRoute, /createHash\("sha256"\)/);
  assert.match(bankResponseRoute, /p_operation_id: operationId/);
  assert.match(bankResponseRoute, /p_file_sha256: fileSha256/);
  assert.match(bankResponseRoute, /rpc\("workforce_finalize_payout_payment_response"/);
});

test("payment history is finance-restricted, company-scoped and masks account numbers", () => {
  assert.match(historyRoute, /hasPermission\(authorization, pageCode, "edit"\)/);
  assert.match(historyRoute, /hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(historyRoute, /authorization\.hasAllLocationAccess/);
  assert.match(historyRoute, /\.eq\("company_id", companyId\)/);
  assert.match(historyRoute, /`••••\$\{account\.slice\(-4\)\}`/);
  assert.match(historyRoute, /redownloadable: String\(batch\?\.status \?\? ""\) === "processing"/);
  assert.match(historyRoute, /from\("workforce_payout_payment_hold_events"\)/);
  assert.match(historyRoute, /onHold: String\(holdEvents\[0\]\?\.action/);
});

test("payment history identifies split bank lines by their immutable location snapshot", () => {
  assert.match(historyRoute, /const stationId = String\(params\.get\("stationId"\)/);
  assert.match(historyRoute, /\.eq\("location_id_snapshot", stationId\)/);
  assert.match(historyRoute, /location_id_snapshot,location_code_snapshot/);
  assert.match(historyRoute, /from\("stations"\)/);
  assert.match(historyRoute, /\.select\("id,station_name"\)/);
  assert.match(historyRoute, /locationCode: String\(item\.location_code_snapshot/);
  assert.match(historyRoute, /locationName: locationNames\.get\(String\(item\.location_id_snapshot/);
  assert.match(historyButton, /locationCode: string/);
  assert.match(historyButton, /locationName: string/);
  assert.match(historyButton, /new URLSearchParams\(\{ workforceId, stationId, periodStart, periodEnd \}\)/);
  assert.match(historyButton, /<th>Location<\/th>/);
  assert.match(historyButton, /<td>\{locationLabel\(entry\)\}<\/td>/);
});

test("manual status changes and holds are privileged, reasoned and surfaced from payment history", () => {
  assert.match(paymentStatusRoute, /sameOrigin\(request\)/);
  assert.match(paymentStatusRoute, /hasPermission\(authorization, pageCode, "edit"\)/);
  assert.match(paymentStatusRoute, /hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(paymentStatusRoute, /authorization\.hasAllLocationAccess/);
  assert.match(paymentStatusRoute, /remarks\.length < 3 \|\| remarks\.length > 1000/);
  assert.match(paymentStatusRoute, /rpc\("workforce_transition_payout_payment_item"/);
  assert.match(paymentStatusRoute, /rpc\("workforce_set_payout_payment_hold"/);
  assert.match(historyButton, /Mark on hold/);
  assert.match(historyButton, /Release hold/);
  assert.match(historyButton, />Failed<\/button>/);
  assert.match(historyButton, />Cancelled<\/button>/);
  assert.match(historyButton, /canManageStatus && pendingAction/);
  assert.match(table, /canManageStatus=\{canProcessPayments\}/);
  assert.match(lifecycleMigration, /create table public\.workforce_payout_payment_hold_events/);
  assert.match(lifecycleMigration, /history is immutable/);
  assert.match(lifecycleMigration, /status in \('processing', 'paid', 'cancelled', 'failed'\)/);
  assert.match(lifecycleMigration, /from public\.connect_profile_verifications/);
  assert.match(lifecycleMigration, /eligibility_code := 'pan_not_linked'/);
  assert.match(lifecycleMigration, /eligibility_code := 'payment_on_hold'/);
});

test("the UI pays only eligible location rows and displays row-specific ledger balances", () => {
  assert.match(page, /rpc\("workforce_preview_payout_payment_rows"/);
  assert.match(page, /`\$\{String\(preview\.workforce_id\)\.toLowerCase\(\)\}\|\$\{String\(preview\.station_id\)\.toLowerCase\(\)\}`/);
  assert.match(page, /loadError \|\| audience !== "workforce" \|\| !canProcessPayments/);
  assert.match(page, /const \[reviewed, paymentEnriched\] = await Promise\.all/);
  assert.match(page, /canProcessPayments = audience === "workforce"[\s\S]*?period\.mode === "monthly"[\s\S]*?authorization\.hasAllLocationAccess[\s\S]*?hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.doesNotMatch(page, /from\("workforce_payout_payment_items"\)[\s\S]{0,300}instruction_amount/);
  assert.match(table, /publicationPaymentReady === true/);
  assert.match(table, /row\.paymentSummary\?\.eligible === true/);
  assert.match(table, /row\.dropxStatus\.trim\(\)\.toLowerCase\(\) === "active"/);
  assert.match(table, /row\.paymentSummary\?\.status !== "Payment Processing"/);
  assert.match(table, /resolveWorkforcePayoutBankSelection\(\s*bankSelectionIndex,\s*selected\s*\)/);
  assert.match(actionSelection, /index\.set\(row\.id,/);
  assert.match(actionSelection, /payoutRows\.push\(\{ workforceId: entry\.workforceId, stationId: entry\.stationId \}\)/);
  assert.doesNotMatch(table, /complete profile/i);
  assert.match(bankDialog, /Only current Active Workforce profiles are eligible/);
  assert.match(bankDialog, /Under Review and every other profile status are excluded/);
  assert.match(bankDialog, /Only the checked payout row and its location balance are included/);
  assert.match(bankDialog, /Other rows for the same DropX ID remain outside this bank file/);
  assert.match(table, /Paid \{exactMoney\(row\.paymentSummary\.paidAmount\)\}/);
  assert.match(table, /Balance payable \{exactMoney\(row\.paymentSummary\.balancePayable\)\}/);
  assert.match(table, /paymentBalanceAvailable \? <span>Balance payable[\s\S]*?<span>Balance payable —<\/span>/);
  assert.match(table, /\{paymentEligibilityLabel\}/);
  assert.match(page, /eligible: preview\.eligible === true/);
  assert.match(page, /eligibilityCode: String\(preview\.eligibility_code/);
  assert.match(page, /eligibilityMessage: String\(preview\.eligibility_message/);
  assert.match(page, /status: summary\?\.status \?\? row\.status/);
  assert.match(table, /WorkforcePayoutPaymentHistoryButton/);
  assert.match(table, /stationId=\{row\.locationId\}/);
  assert.match(table, /Published location net/);
  assert.match(rowSelectionMigration, /create or replace function public\.workforce_payout_payment_row_candidates/);
  assert.match(rowSelectionMigration, /allocation\.station_id = v_station_id/);
  assert.match(rowSelectionMigration, /create or replace function public\.workforce_create_payout_payment_row_batch/);
  assert.match(rowSelectionMigration, /location_id_snapshot, location_code_snapshot/);
  assert.match(rowSelectionMigration, /selection_mode', 'payout_row'/);
  assert.doesNotMatch(rowSelectionMigration, /revoke execute on function public\.workforce_create_payout_payment_batch/);
  assert.match(rowSelectionMigration, /create or replace function public\.workforce_claim_selected_payout_publication_row_refresh_jobs/);
  assert.match(rowSelectionMigration, /pair\.workforce_id = job\.workforce_id[\s\S]*?pair\.station_id = job\.station_id/);
});

test("the UI exposes refresh-pending positive balances without treating them as authoritative", () => {
  assert.match(table, /publicationRefreshPending\(row\) && preliminaryAvailableToPay > 0/);
  assert.match(table, /row\.paymentSummary\?\.status !== "Payment Processing"/);
  assert.match(table, /BANK_PAYMENT_BLOCKED_STATUSES/);
  assert.match(table, /row\.panAadhaarStatus !== "NOT LINKED"/);
  assert.match(table, /publicationRefreshCount=\{selectedBankRefreshPendingCount\}/);
  assert.match(table, /row balance and every payment eligibility rule are checked again/);
  assert.match(bankDialog, /Refresh before file generation/);
  assert.match(bankDialog, /File generation stops if any selected publication remains stale or another blocker is found/);
  assert.match(bankDialog, /Preliminary selected balance/);
  assert.match(bankDialog, /finally \{[\s\S]*?router\.refresh\(\)/);
});

test("new publication snapshots explicitly freeze bank-payment eligibility", () => {
  assert.match(snapshot, /payment_status: row\.status/);
  assert.match(snapshot, /payment_details_available: row\.paymentDetailsAvailable/);
  assert.match(snapshot, /payment_eligible: row\.paymentDetailsAvailable/);
  assert.match(snapshot, /isWorkforcePayoutCalculationPublishable\(row\.status\)/);
});
