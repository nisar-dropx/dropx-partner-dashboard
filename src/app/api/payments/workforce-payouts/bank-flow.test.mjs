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
const bulkHold = readFileSync(new URL("../../../../components/workforce-payout-bulk-hold.tsx", import.meta.url), "utf8");
const bulkCancellation = readFileSync(new URL("../../../../components/workforce-payout-bulk-cancellation.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../../../app/payments/workforce-payouts/page.tsx", import.meta.url), "utf8");
const snapshot = readFileSync(new URL("../../../../lib/workforce-payout-publication-snapshot.ts", import.meta.url), "utf8");
const lifecycleMigration = readFileSync(new URL("../../../../../supabase/migrations/20261009172942_workforce_payout_manual_status_and_holds.sql", import.meta.url), "utf8");
const rowSelectionMigration = readFileSync(new URL("../../../../../supabase/migrations/20261010130000_workforce_payout_location_row_bank_selection.sql", import.meta.url), "utf8");
const bulkCancellationMigration = readFileSync(new URL("../../../../../supabase/migrations/20261010150000_workforce_payout_bulk_processing_cancellation.sql", import.meta.url), "utf8");

test("bank-file creation is company-scoped, privileged, transport-bounded and idempotent without a row cap", () => {
  assert.match(bankFileRoute, /sameOrigin\(request\)/);
  assert.match(bankFileRoute, /hasPermission\(authorization, payoutPageCode, "edit"\)/);
  assert.match(bankFileRoute, /hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(bankFileRoute, /accessSurface === "ops" \|\| hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(bankFileRoute, /!hasPermission\(authorization, payoutPageCode, "edit"\) \|\| !canUsePaymentActions/);
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
  assert.match(bankFileRoute, /limit: 10_000/);
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
  assert.match(bankResponseRoute, /accessSurface === "ops" \|\| hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(bankResponseRoute, /!hasPermission\(authorization, payoutPageCode, "edit"\) \|\| !canUsePaymentActions/);
  assert.match(bankResponseRoute, /authorization\.hasAllLocationAccess/);
  assert.match(bankResponseRoute, /MAX_FILE_BYTES = 10 \* 1024 \* 1024/);
  assert.match(bankResponseRoute, /MAX_RESPONSE_ROWS = 5000/);
  assert.match(bankResponseRoute, /REFERENCE_LOOKUP_CHUNK_SIZE = 50/);
  assert.match(bankResponseRoute, /REFERENCE_LOOKUP_CONCURRENCY = 4/);
  assert.match(bankResponseRoute, /\.xlsx\?/);
  assert.match(bankResponseRoute, /createHash\("sha256"\)/);
  assert.match(bankResponseRoute, /p_operation_id: operationId/);
  assert.match(bankResponseRoute, /p_file_sha256: fileSha256/);
  assert.match(bankResponseRoute, /prepareDropxFedOneResponse\(bytes\)/);
  assert.match(bankResponseRoute, /debit_account: row\.debitAccount \?\? ""/);
  assert.match(bankResponseRoute, /credit_account: row\.creditAccount/);
  assert.match(bankResponseRoute, /ifsc: row\.ifsc/);
  assert.match(bankResponseRoute, /value_date: row\.valueDate \?\? ""/);
  assert.match(bankResponseRoute, /debit_amount_paise: row\.debitAmountPaise/);
  assert.match(bankResponseRoute, /utr_cin: row\.utrCin/);
  assert.match(bankResponseRoute, /remarks: row\.remarks/);
  assert.match(bankResponseRoute, /from\(lookup\.table\)[\s\S]*?\.eq\("company_id", companyId\)[\s\S]*?\.in\("reference_no", lookup\.references\)/);
  assert.match(bankResponseRoute, /parsePreparedDropxFedOneResponse\(prepared, ownedReferences, rowReferenceAliases\)/);
  assert.match(bankResponseRoute, /rpc\("finalize_owned_payout_payment_response"/);
  assert.match(bankResponseRoute, /p_workforce_rows: normalizedRows\(parsed\.workforceRows\)/);
  assert.match(bankResponseRoute, /p_helper_rows: normalizedRows\(parsed\.helperRows\)/);
  assert.match(bankResponseRoute, /skipped: parsed\.skippedRows\.length/);
  assert.match(bankResponseRoute, /skipped: responseRowCount/);
  assert.match(bankDialog, /Matching Workforce and Helper references are finalized together from either tab/);
  assert.match(bankDialog, /Skipped \$\{skippedCount\} unrelated bank reference/);
});

test("payment history is page-viewable, location-scoped, company-scoped and masks account numbers", () => {
  assert.match(historyRoute, /hasPermission\(authorization, pageCode, "access"\)/);
  assert.doesNotMatch(historyRoute, /hasPermission\(authorization, pageCode, "edit"\)/);
  assert.doesNotMatch(historyRoute, /hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(historyRoute, /!authorization\.hasAllLocationAccess && !authorization\.locationScopeIds\.some/);
  assert.match(historyRoute, /\.eq\("company_id", companyId\)/);
  assert.match(historyRoute, /`••••\$\{account\.slice\(-4\)\}`/);
  assert.match(historyRoute, /redownloadable: String\(batch\?\.status \?\? ""\) === "processing"/);
  assert.match(historyRoute, /from\("workforce_payout_payment_hold_events"\)/);
  assert.match(historyRoute, /rpc\("workforce_payout_source_payment_is_on_hold"/);
  assert.match(historyRoute, /onHold: profileOnHold \|\| sourceOnHold/);
  assert.match(bulkHold, /audience === "workforce" && \(action === "release_hold" \|\| !item\.workforceId\) \? item\.sourceTargets : \[\]/);
});

test("payment history identifies split bank lines by their immutable location code", () => {
  assert.match(historyRoute, /const stationId = String\(params\.get\("stationId"\)/);
  assert.match(historyRoute, /\.eq\("location_id_snapshot", stationId\)/);
  assert.match(historyRoute, /location_id_snapshot,location_code_snapshot/);
  assert.match(historyRoute, /locationCode: text\(item\.location_code_snapshot\)/);
  assert.match(historyButton, /locationCode: string/);
  assert.match(historyButton, /new URLSearchParams\(\{ audience, workforceId, stationId, periodStart, periodEnd \}\)/);
  assert.match(historyButton, /<th>Location<\/th>/);
  assert.match(historyButton, /<td>\{entry\.locationCode \|\| "—"\}<\/td>/);
});

test("manual status changes and holds are privileged and reasoned, with hold actions beside row history", () => {
  assert.match(paymentStatusRoute, /sameOrigin\(request\)/);
  assert.match(paymentStatusRoute, /hasPermission\(authorization, pageCode, "edit"\)/);
  assert.match(paymentStatusRoute, /hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(paymentStatusRoute, /accessSurface === "ops" \|\| hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(paymentStatusRoute, /!hasPermission\(authorization, pageCode, "edit"\) \|\| !canUsePaymentActions/);
  assert.match(paymentStatusRoute, /authorization\.hasAllLocationAccess/);
  assert.match(paymentStatusRoute, /remarks\.length < 3 \|\| remarks\.length > 1000/);
  assert.match(paymentStatusRoute, /rpc\("workforce_transition_payout_payment_item"/);
  assert.match(paymentStatusRoute, /rpc\("workforce_set_payout_payment_hold"/);
  assert.doesNotMatch(historyButton, /Mark on hold|Release hold/);
  assert.match(table, /canManageIndividualHold \? <WorkforcePayoutBulkHold/);
  assert.match(table, /mode="single"/);
  assert.match(bulkHold, /Hold remarks/);
  assert.match(bulkHold, /Unhold remarks/);
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

test("one processing instruction can be finalized manually with complete audited bank evidence", () => {
  assert.match(paymentStatusRoute, /actions = new Set\(\[[^\]]*"finalize"/);
  assert.match(paymentStatusRoute, /action === "finalize"/);
  assert.match(paymentStatusRoute, /positiveMoney\(body\.amount\)/);
  assert.match(paymentStatusRoute, /boundedText\(body\.debitAccount, 128\)/);
  assert.match(paymentStatusRoute, /boundedText\(body\.creditAccount, 128\)/);
  assert.match(paymentStatusRoute, /boundedText\(body\.creditIfsc, 64\)/);
  assert.match(paymentStatusRoute, /validDate\(valueDate\)/);
  assert.match(paymentStatusRoute, /meaningfulBankReference\(body\.utrCin\)/);
  assert.match(paymentStatusRoute, /boundedText\(body\.bankRemarks, 1000\)/);
  assert.match(paymentStatusRoute, /rpc\("workforce_finalize_payout_payment_item_manually"/);
  assert.match(paymentStatusRoute, /rpc\("helper_finalize_payout_payment_item_manually"/);
  assert.match(historyButton, /onClick=\{\(\) => chooseFinalize\(entry\)\}[^>]*>Finalize<\/button>/);
  assert.match(historyButton, /Paid amount/);
  assert.match(historyButton, /Debit account/);
  assert.match(historyButton, /Credit account/);
  assert.match(historyButton, /Credit IFSC/);
  assert.match(historyButton, /UTR\/CIN/);
  assert.match(historyButton, /Value date/);
  assert.match(historyButton, /Bank remarks/);
  assert.match(historyButton, /amount <= maximum/);
  assert.match(historyButton, /entry\.maxAmount \?\? entry\.instructionAmount \?\? entry\.amount/);
  assert.match(historyButton, /lower amount leaves the balance payable and marks the payout Partially Paid/);
});

test("payment history presents immutable bank evidence in the requested columns", () => {
  assert.match(historyRoute, /status,bank_response_status,bank_account_no_snapshot/);
  assert.match(historyRoute, /bank_response_status[\s\S]*?MANUAL_PAID[\s\S]*?bank_processing_remarks/);
  assert.match(historyButton, /<th>Location<\/th>/);
  assert.match(historyButton, /<td>\{entry\.locationCode \|\| "—"\}<\/td>/);
  assert.doesNotMatch(historyButton, /locationLabel\(entry\)/);
  assert.match(historyButton, /<th>Debit A\/c<\/th>/);
  assert.match(historyButton, /debitAccountDisplay\(entry\)/);
  assert.match(historyButton, /<th>Credit A\/c<\/th>/);
  assert.match(historyButton, /entry\.creditAccount \|\| "—"/);
  assert.match(historyButton, /<th>Credit IFSC<\/th>/);
  assert.match(historyButton, /entry\.creditIfsc \|\| "—"/);
  assert.match(historyButton, /<th>Value Date<\/th>/);
  assert.match(historyButton, /dateOnly\(entry\.valueDate\)/);
  assert.match(historyButton, /<th>Generated on<\/th>/);
  assert.match(historyButton, /<th>Finalized on<\/th>/);
});

test("selected processing rows can be cancelled atomically with one mandatory remark", () => {
  assert.match(page, /"id,workforce_id,location_id_snapshot,instruction_amount"/);
  assert.match(page, /"id,helper_id,location_id_snapshot,instruction_amount"/);
  assert.match(page, /from\("workforce_payout_payment_allocations"\)/);
  assert.match(page, /const isExactLocationInstruction = allocations\.length === 1/);
  assert.match(page, /allocations\[0\]\?\.station_id[\s\S]*?item\.location_id_snapshot/);
  assert.match(page, /Math\.round\(allocationAmount \* 100\) === Math\.round\(instructionAmount \* 100\)/);
  assert.match(page, /processingPaymentItemId: processingInstruction\?\.id \?\? null/);
  assert.match(page, /processingInstructionAmount: processingInstruction\?\.instructionAmount \?\? null/);
  assert.match(page, /\.eq\("status", "processing"\)/);
  assert.match(table, /function canCancelProcessingPayment/);
  assert.match(table, /processingInstructionAmount \?\? 0/);
  assert.match(table, /const processingSelectedRows = useMemo\(\(\) => selectedRows\.filter\(canCancelProcessingPayment\)/);
  assert.match(table, /amount: Number\(row\.paymentSummary\?\.processingInstructionAmount \?\? 0\)/);
  assert.match(table, /bankActionableIds\.has\(row\.id\) \|\| canCancelProcessingPayment\(row\)/);
  assert.match(table, /<WorkforcePayoutBulkCancellation/);
  assert.match(bulkCancellation, /paymentItemIds: items\.map\(\(item\) => item\.paymentItemId\)/);
  assert.match(bulkCancellation, /Cancellation remarks/);
  assert.match(bulkCancellation, /same remark is recorded against every selected payment/);
  assert.match(paymentStatusRoute, /MAX_REQUEST_BYTES = 4 \* 1024 \* 1024/);
  assert.match(paymentStatusRoute, /Array\.isArray\(body\.paymentItemIds\)/);
  assert.match(paymentStatusRoute, /new Set\(paymentItemIds\)\.size !== paymentItemIds\.length/);
  assert.match(paymentStatusRoute, /rpc\("workforce_cancel_payout_payment_items"/);
  assert.match(bulkCancellationMigration, /array_agg\(distinct requested\.item_id order by requested\.item_id\)/);
  assert.match(bulkCancellationMigration, /workforce\.id in \([\s\S]*?order by workforce\.id[\s\S]*?for update/);
  assert.match(bulkCancellationMigration, /order by item\.id[\s\S]*?for update/);
  assert.match(bulkCancellationMigration, /Every selected payment must still be Payment Processing\. No payments were cancelled/);
  assert.match(bulkCancellationMigration, /Every selected payment must be one exact location instruction\. Legacy combined instructions cannot be bulk-cancelled/);
  assert.match(bulkCancellationMigration, /update public\.workforce_payout_payment_items item[\s\S]*?item\.id = any\(v_item_ids\)/);
  assert.match(bulkCancellationMigration, /with batch_counts as \([\s\S]*?batch_states as \([\s\S]*?update public\.workforce_payout_payment_batches batch/);
  assert.match(bulkCancellationMigration, /insert into public\.workforce_payout_payment_events[\s\S]*?select[\s\S]*?'payment_cancelled_manually'/);
  assert.doesNotMatch(bulkCancellationMigration, /workforce_transition_payout_payment_item\(/);
  assert.doesNotMatch(bulkCancellationMigration, /\bfor\s+\w+\s+in\s+select\b/i);
  assert.match(bulkCancellationMigration, /event_type, event_data, actor_user_id[\s\S]*?'payment_cancelled_bulk'/);
  assert.match(bulkCancellationMigration, /grant execute on function public\.workforce_cancel_payout_payment_items[\s\S]*?to service_role/);
  assert.doesNotMatch(bulkCancellationMigration, /to (?:public|anon|authenticated)\s*;/);
});

test("the UI pays only eligible location rows and displays row-specific ledger balances", () => {
  assert.match(page, /"helper_preview_payout_payment_rows"[\s\S]{0,100}"workforce_preview_payout_payment_rows"/);
  assert.match(page, /`\$\{String\(preview\.workforce_id\)\.toLowerCase\(\)\}\|\$\{String\(preview\.station_id\)\.toLowerCase\(\)\}`/);
  assert.match(page, /const canLoadPaymentSummaries = period\.mode === "monthly"[\s\S]*?&& canEdit/);
  assert.match(page, /loadError \|\| !canLoadPaymentSummaries/);
  assert.match(page, /includeProcessingActionDetails: canProcessPayments/);
  assert.match(page, /const \[reviewed, paymentEnriched\] = await Promise\.all/);
  assert.match(page, /const canUsePaymentActions = accessSurface === "ops"[\s\S]*?hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(page, /canProcessPayments = period\.mode === "monthly"[\s\S]*?authorization\.hasAllLocationAccess[\s\S]*?canUsePaymentActions/);
  assert.match(page, /"helper_payout_payment_items" : "workforce_payout_payment_items"[\s\S]{0,300}instruction_amount/);
  assert.match(table, /publicationPaymentReady === true/);
  assert.match(table, /row\.paymentSummary\?\.eligible === true/);
  assert.match(table, /row\.dropxStatus\.trim\(\)\.toLowerCase\(\) === "active"/);
  assert.match(table, /row\.paymentSummary\?\.status !== "Payment Processing"/);
  assert.match(table, /resolveWorkforcePayoutBankSelection\(\s*bankSelectionIndex,\s*selected\s*\)/);
  assert.match(actionSelection, /index\.set\(row\.id,/);
  assert.match(actionSelection, /selectedByPayoutIdentity/);
  assert.match(actionSelection, /const payoutIdentity = `\$\{entry\.workforceId\}\|\$\{entry\.stationId\}`/);
  assert.doesNotMatch(table, /complete profile/i);
  assert.match(bankDialog, /Only current Active \{subjectLabel\} profiles are eligible/);
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
  assert.match(
    table,
    /const canRefreshCandidate = audience === "workforce"[\s\S]*?publicationRefreshPending\(row\)[\s\S]*?preliminaryAvailableToPay > 0/
  );
  assert.match(table, /row\.paymentSummary\?\.status !== "Payment Processing"/);
  assert.match(table, /visibleStatus === "payment processing"/);
  assert.match(table, /visibleStatus === "payment on hold"/);
  assert.match(table, /audience === "workforce" && visibleStatus === "pan not linked"/);
  assert.match(table, /audience === "helpers" \|\| row\.panAadhaarStatus !== "NOT LINKED"/);
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
