import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workforce-payout-table.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../app/payments/workforce-payouts/page.tsx", import.meta.url), "utf8");

test("payout breakup identifies an aggregate attendance value by quantity and effective range", () => {
  assert.match(source, /Uploaded attendance range/);
  assert.match(source, /range\.quantity/);
  assert.match(source, /range\.effectiveFrom/);
  assert.match(source, /range\.effectiveTo/);
});

test("notification submit sends the signed page snapshot instead of requesting a full worksheet recalculation", () => {
  assert.match(pageSource, /const publicationSnapshotHash = audience === ["']workforce["'][\s\S]*?workforcePayoutPublicationSnapshotHash\(/);
  assert.match(pageSource, /publicationSnapshotHash,/);
  assert.match(pageSource, /locationSetHash:[\s\S]*?workforcePayoutLocationSetHash/);
  assert.match(pageSource, /publicationDependencyHash:\s*audience\s*===\s*["']workforce["']\s*\?\s*dependencyHash/);
  assert.match(source, /calculationSnapshot:\s*audience === ["']workforce["'][\s\S]*?\?\s*buildWorkforcePayoutPublicationSnapshot\(/);
  assert.match(source, /row\.publicationDependencyHash\s*\?\?\s*["']["']/);
});

test("notification submit names missing locations even when payout filters hide their rows", () => {
  assert.match(pageSource, /publicationLocations:[\s\S]*?publishableLocationsBySubject/);
  assert.match(source, /missingPayoutNotificationLocations\(rows,\s*reviewSelectedRows,\s*audience\)/);
  assert.match(source, /selectedRow\.publicationLocations/);
  assert.match(source, /Missing locations:[\s\S]*?Clear or change the filters/);
});

test("every monthly viewer receives payment status while bank action details stay permission-gated", () => {
  assert.match(pageSource, /const canLoadPaymentSummaries = period\.mode === ["']monthly["'];/);
  assert.match(pageSource, /loadWorkforcePayoutBanks\(companyId, canProcessPayments\)/);
  assert.match(pageSource, /loadError \|\| !canLoadPaymentSummaries[\s\S]*?withPayoutPaymentSummaries\([\s\S]*?includeProcessingActionDetails: canProcessPayments/);
  assert.match(pageSource, /includeProcessingActionDetails[\s\S]*?\? loadProcessingItems\(\)[\s\S]*?: Promise\.resolve\(\{ data: \[\] as ProcessingPaymentItem\[\], error: null \}\)/);
  assert.match(source, /row\.paymentSummary\?\.status !== ["']Payment Processing["']/);
});

test("payout workspace keeps search and every filter directly visible while grouping secondary actions", () => {
  assert.match(source, /className="payout-search-strip"[\s\S]*?type="search"/);
  assert.match(source, /className="payout-filter-panel"[\s\S]*?label="Location"[\s\S]*?label="Designation"[\s\S]*?label="Provider"[\s\S]*?label="Payment method"[\s\S]*?label="Mapping status"[\s\S]*?label="Status"/);
  assert.match(source, /<PayoutActionMenu label="Bank & payment">/);
  assert.match(source, /className="payout-selection-bar"/);
  assert.match(source, /className="payout-selection-hint"/);
});

test("global payout actions are hidden without payout edit permission", () => {
  assert.match(source, /\{canEdit \? <div className="payout-global-actions">[\s\S]*?Export full CSV[\s\S]*?<\/div> : null\}/);
});

test("payout overview consolidates columns and moves history controls into the expanded detail", () => {
  assert.match(source, /const tableColumnCount = showSelection \? 11 : 10/);
  assert.match(source, />Assignment<\/th>/);
  assert.match(source, />Gross \/ deductions<\/th>/);
  assert.match(source, /className="payout-row-open-cell"[\s\S]*?expanded \? "Close" : "Breakup"/);
  assert.match(source, /className="payout-detail-header"[\s\S]*?PaymentAllocationHistoryButton[\s\S]*?WorkforcePayoutBulkHold[\s\S]*?WorkforcePayoutPaymentHistoryButton/);
  assert.match(source, /canViewPaymentHistory && row\.reviewSubjectId && row\.locationId && row\.paymentSummary[\s\S]*?canManageStatus=\{canProcessPayments\}/);
});

test("individual hold and unhold live beside row history instead of inside payment history", () => {
  assert.match(source, /const canManageIndividualHold = canProcessPayments[\s\S]*?canViewPaymentHistory[\s\S]*?canChangePayoutHold\(row\)[\s\S]*?!individualHoldBlockedByProcessing/);
  assert.match(source, /canManageIndividualHold \? <WorkforcePayoutBulkHold[\s\S]*?mode="single"/);
  assert.match(source, /holdItems=\{isPayoutOnHold\(row\) \|\| !individualHoldTarget \? \[\] : \[individualHoldTarget\]\}/);
  assert.match(source, /releaseItems=\{isPayoutOnHold\(row\) && individualHoldTarget \? \[individualHoldTarget\] : \[\]\}/);
});
