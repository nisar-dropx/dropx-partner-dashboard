import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bankFileRoute = readFileSync(new URL("./bank-file/route.ts", import.meta.url), "utf8");
const bankResponseRoute = readFileSync(new URL("./bank-response/route.ts", import.meta.url), "utf8");
const historyRoute = readFileSync(new URL("./payment-history/route.ts", import.meta.url), "utf8");
const paymentStatusRoute = readFileSync(new URL("./payment-status/route.ts", import.meta.url), "utf8");
const table = readFileSync(new URL("../../../../components/workforce-payout-table.tsx", import.meta.url), "utf8");
const actionSelection = readFileSync(new URL("../../../../lib/workforce-payout-action-selection.ts", import.meta.url), "utf8");
const historyButton = readFileSync(new URL("../../../../components/workforce-payout-payment-history-button.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../../../app/payments/workforce-payouts/page.tsx", import.meta.url), "utf8");
const snapshot = readFileSync(new URL("../../../../lib/workforce-payout-publication-snapshot.ts", import.meta.url), "utf8");
const lifecycleMigration = readFileSync(new URL("../../../../../supabase/migrations/20261009172942_workforce_payout_manual_status_and_holds.sql", import.meta.url), "utf8");

test("bank-file creation is company-scoped, privileged, transport-bounded and idempotent without a row cap", () => {
  assert.match(bankFileRoute, /sameOrigin\(request\)/);
  assert.match(bankFileRoute, /hasPermission\(authorization, payoutPageCode, "edit"\)/);
  assert.match(bankFileRoute, /hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(bankFileRoute, /authorization\.hasAllLocationAccess/);
  assert.match(bankFileRoute, /requireCompanyId\(authorization\)/);
  assert.doesNotMatch(bankFileRoute, /MAX_SELECTION/);
  assert.match(bankFileRoute, /MAX_REQUEST_BYTES = 4 \* 1024 \* 1024/);
  assert.match(bankFileRoute, /new TextEncoder\(\)\.encode\(raw\)\.byteLength > MAX_REQUEST_BYTES/);
  assert.match(bankFileRoute, /Select at least one unique Workforce profile/);
  assert.match(bankFileRoute, /completeCalendarMonth\(periodStart, periodEnd\)/);
  assert.match(bankFileRoute, /new Set\(ids\)\.size !== ids\.length/);
  assert.match(bankFileRoute, /p_operation_id: operationId/);
  assert.match(bankFileRoute, /p_request_fingerprint: requestFingerprint/);
  assert.match(bankFileRoute, /rpc\("workforce_create_payout_payment_batch"/);
  assert.match(bankFileRoute, /Cache-Control": "private, no-store"/);
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

test("the UI pays only eligible profiles, displays trustworthy ledger balances and explains blocked payouts", () => {
  assert.match(page, /rpc\("workforce_preview_payout_payments"/);
  assert.match(page, /loadError \|\| audience !== "workforce" \|\| !canProcessPayments/);
  assert.match(page, /const \[reviewed, paymentEnriched\] = await Promise\.all/);
  assert.match(page, /canProcessPayments = audience === "workforce"[\s\S]*?period\.mode === "monthly"[\s\S]*?authorization\.hasAllLocationAccess[\s\S]*?hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.doesNotMatch(page, /from\("workforce_payout_payment_items"\)[\s\S]{0,300}instruction_amount/);
  assert.match(table, /publicationPaymentReady === true/);
  assert.match(table, /row\.paymentSummary\?\.eligible === true/);
  assert.match(table, /row\.paymentSummary\?\.status !== "Payment Processing"/);
  assert.match(table, /resolveWorkforcePayoutBankSelection\(\s*bankSelectionIndex,\s*selected,\s*selectedBankWorkforceIds/);
  assert.match(actionSelection, /entry\.rowIds\.every\(\(rowId\) => selectedRowIds\.has\(rowId\)\)/);
  assert.match(table, /Select every published location row for each DropX ID/);
  assert.match(table, /Paid \{exactMoney\(row\.paymentSummary\.paidAmount\)\}/);
  assert.match(table, /Balance payable \{exactMoney\(row\.paymentSummary\.balancePayable\)\}/);
  assert.match(table, /paymentBalanceAvailable \? <span>Balance payable[\s\S]*?<span>Balance payable —<\/span>/);
  assert.match(table, /\{paymentEligibilityLabel\}/);
  assert.match(page, /eligible: preview\.eligible === true/);
  assert.match(page, /eligibilityCode: String\(preview\.eligibility_code/);
  assert.match(page, /eligibilityMessage: String\(preview\.eligibility_message/);
  assert.match(page, /status: summary\?\.status \?\? row\.status/);
  assert.match(table, /WorkforcePayoutPaymentHistoryButton/);
});

test("new publication snapshots explicitly freeze bank-payment eligibility", () => {
  assert.match(snapshot, /payment_status: row\.status/);
  assert.match(snapshot, /payment_details_available: row\.paymentDetailsAvailable/);
  assert.match(snapshot, /payment_eligible: row\.paymentDetailsAvailable/);
  assert.match(snapshot, /isWorkforcePayoutCalculationPublishable\(row\.status\)/);
});
