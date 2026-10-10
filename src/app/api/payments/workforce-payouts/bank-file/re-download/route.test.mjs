import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const component = readFileSync(
  new URL("../../../../../../components/workforce-payout-bank-redownload-button.tsx", import.meta.url),
  "utf8"
);
const table = readFileSync(
  new URL("../../../../../../components/workforce-payout-table.tsx", import.meta.url),
  "utf8"
);
const page = readFileSync(
  new URL("../../../../../payments/workforce-payouts/page.tsx", import.meta.url),
  "utf8"
);
const migration = readFileSync(
  new URL("../../../../../../../supabase/migrations/20261010160000_workforce_payout_processing_bank_redownload.sql", import.meta.url),
  "utf8"
);

test("bulk re-download is authorized, exact-selection only, and read-only", () => {
  assert.match(route, /sameOrigin\(request\)/);
  assert.match(route, /hasPermission\(authorization, payoutPageCode, "edit"\)/);
  assert.match(route, /hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(route, /authorization\.hasAllLocationAccess/);
  assert.match(route, /MAX_REQUEST_BYTES = 4 \* 1024 \* 1024/);
  assert.match(route, /uniquePaymentItemIds\(body\.paymentItemIds\)/);
  assert.match(route, /completeCalendarMonth\(periodStart, periodEnd\)/);
  assert.match(route, /rpc\("workforce_get_payout_payment_redownload"/);
  assert.match(route, /returnedIds\.size !== paymentItemIds\.length/);
  assert.doesNotMatch(route, /workforce_create_payout_payment/);
  assert.doesNotMatch(route, /refreshWorkforcePayoutPublicationJobs/);
  assert.doesNotMatch(route, /\.from\([^)]*\)[\s\S]{0,200}\.(?:update|insert|delete)\(/);
});

test("bulk re-download preserves immutable instructions and separates original batches", () => {
  assert.match(route, /new Map<string, RedownloadItem\[\]>\(\)/);
  assert.match(route, /groups\.get\(batchId\)/);
  assert.match(route, /buildWorkforceFedOneWorkbook/);
  assert.match(route, /instruction_amount/);
  assert.match(route, /reference_no/);
  assert.match(route, /bank_account_no/);
  assert.match(route, /credit_remarks/);
  assert.match(route, /debit_remarks/);
  assert.match(route, /new JSZip\(\)/);
  assert.match(route, /archive\.file\(batchFilename/);
  assert.match(route, /const suffix = UUID\.test\(batchId\) \? batchId : "batch"/);
  assert.doesNotMatch(route, /batchId\.slice\(0,\s*8\)/);
  assert.match(route, /orderedGroups\.length === 1/);
  assert.match(route, /Content-Type": "application\/zip"/);
  assert.match(route, /X-Workforce-Payout-Redownload": "true"/);
});

test("dashboard loads bank-action details with one paginated period query scoped to visible payout rows", () => {
  assert.match(page, /\.from\("workforce_payout_payment_items"\)[\s\S]{0,500}\.eq\("company_id", companyId\)[\s\S]{0,300}\.eq\("period_start", fromDate\)[\s\S]{0,200}\.eq\("period_end", toDate\)[\s\S]{0,200}\.eq\("status", "processing"\)/);
  assert.match(page, /\.range\(offset, offset \+ 999\)/);
  assert.match(page, /visiblePayoutKeys\.has\([\s\S]{0,150}item\.workforce_id[\s\S]{0,150}item\.location_id_snapshot/);
  assert.match(page, /includeProcessingActionDetails[\s\S]{0,100}\? loadProcessingItems\(\)/);
  assert.doesNotMatch(page, /chunkedValues\(visiblePayoutKeys/);
});

test("database snapshot rejects stale, terminal, cross-period, and legacy combined items", () => {
  assert.match(migration, /language plpgsql[\s\S]*?stable[\s\S]*?security definer/i);
  assert.match(migration, /array_agg\(distinct requested\.item_id order by requested\.item_id\)/i);
  assert.match(migration, /item\.company_id = p_company_id[\s\S]*?item\.period_start = p_period_start[\s\S]*?item\.period_end = p_period_end/i);
  assert.match(migration, /item\.status <> 'processing'/i);
  assert.match(migration, /batch\.status not in \('processing', 'partially_finalized'\)/i);
  assert.match(migration, /allocation_check\.allocation_count <> 1/i);
  assert.match(migration, /allocation_check\.matching_station_count <> 1/i);
  assert.match(migration, /allocation_check\.allocated_amount <> item\.instruction_amount/i);
  assert.match(migration, /grant execute[\s\S]*?to service_role/i);
  assert.doesNotMatch(migration, /\b(update|insert into|delete from)\s+public\.workforce_payout_payment_/i);
});

test("dashboard warns against duplicate bank submission before re-downloading selected processing items", () => {
  assert.match(table, /Number\(row\.paymentSummary\.processingInstructionAmount \?\? 0\) > 0/);
  assert.match(table, /const processingPaymentItemIds = useMemo/);
  assert.match(table, /<WorkforcePayoutBankRedownloadButton/);
  assert.match(table, /paymentItemIds=\{processingPaymentItemIds\}/);
  assert.match(component, /\/api\/payments\/workforce-payouts\/bank-file\/re-download/);
  assert.match(component, /paymentItemIds: exactPaymentItemIds/);
  assert.match(component, /original bank references, amounts, beneficiary details and value dates/i);
  assert.match(component, /Do not submit both the original file and this downloaded copy to the bank/i);
  assert.match(component, /different original batches[\s\S]*?ZIP containing separate bank files/i);
});
