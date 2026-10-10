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
  assert.match(pageSource, /publicationSnapshotHash:\s*publicationSnapshot[\s\S]*?workforcePayoutPublicationSnapshotHash\(publicationSnapshot\)/);
  assert.match(pageSource, /locationSetHash:[\s\S]*?workforcePayoutLocationSetHash/);
  assert.match(pageSource, /publicationDependencyHash:\s*audience\s*===\s*["']workforce["']\s*\?\s*dependencyHash/);
  assert.match(source, /calculationSnapshot:\s*buildWorkforcePayoutPublicationSnapshot\(/);
  assert.match(source, /row\.publicationDependencyHash\s*\?\?\s*["']["']/);
});

test("notification submit names missing locations even when payout filters hide their rows", () => {
  assert.match(pageSource, /publicationLocations:[\s\S]*?publishableLocationsBySubject/);
  assert.match(source, /missingPayoutNotificationLocations\(rows,\s*reviewSelectedRows\)/);
  assert.match(source, /selectedRow\.publicationLocations/);
  assert.match(source, /Missing locations:[\s\S]*?Clear or change the filters/);
});

test("payout editors receive authoritative processing status without receiving bank action access", () => {
  assert.match(pageSource, /const canLoadPaymentSummaries = audience === ["']workforce["'][\s\S]*?period\.mode === ["']monthly["'][\s\S]*?&& canEdit;/);
  assert.match(pageSource, /loadWorkforcePayoutBanks\(companyId, canProcessPayments\)/);
  assert.match(pageSource, /loadError \|\| !canLoadPaymentSummaries[\s\S]*?withPayoutPaymentSummaries\([\s\S]*?includeProcessingActionDetails: canProcessPayments/);
  assert.match(pageSource, /includeProcessingActionDetails[\s\S]*?\? loadProcessingItems\(\)[\s\S]*?: Promise\.resolve\(\{ data: \[\] as ProcessingPaymentItem\[\], error: null \}\)/);
  assert.match(source, /row\.paymentSummary\?\.status !== ["']Payment Processing["']/);
});
