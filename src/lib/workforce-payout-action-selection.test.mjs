import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildWorkforcePayoutBankSelectionIndex,
  buildWorkforcePayoutPreliminaryBalanceIndex,
  chunkPayoutRowsBySubject,
  duplicateAdvanceWorkforceIds,
  resolveWorkforcePayoutBankSelection,
  workforcePayoutMappingLockSelectionIds
} from "./workforce-payout-action-selection.ts";

const payoutTable = readFileSync(new URL("../components/workforce-payout-table.tsx", import.meta.url), "utf8");
const payoutPage = readFileSync(new URL("../app/payments/workforce-payouts/page.tsx", import.meta.url), "utf8");
const payoutLoader = readFileSync(new URL("./workforce-payout-loader.ts", import.meta.url), "utf8");

test("advance selection detects a Workforce member repeated across payout locations", () => {
  const duplicates = duplicateAdvanceWorkforceIds([
    { reviewSubjectId: "workforce-1", locationId: "station-a" },
    { reviewSubjectId: "workforce-2", locationId: "station-a" },
    { reviewSubjectId: "workforce-1", locationId: "station-b" }
  ]);

  assert.deepEqual([...duplicates], ["workforce-1"]);
});

test("advance selection also rejects duplicate loader rows for the same Workforce and location", () => {
  const duplicates = duplicateAdvanceWorkforceIds([
    { reviewSubjectId: "workforce-1", locationId: "station-a" },
    { reviewSubjectId: "workforce-1", locationId: "station-a" },
    { reviewSubjectId: "", locationId: "station-a" },
    { reviewSubjectId: null, locationId: "station-b" }
  ]);

  assert.deepEqual([...duplicates], ["workforce-1"]);
});

test("mapping unlock selection keeps one published locked entry per Workforce in first-seen order", () => {
  const rows = [
    { reviewSubjectId: " workforce-2 ", publicationLockState: "locked", locationId: "station-a" },
    { reviewSubjectId: "workforce-1", publicationLockState: "locked", locationId: "station-a" },
    { reviewSubjectId: "workforce-2", publicationLockState: "locked", locationId: "station-b" },
    { reviewSubjectId: "workforce-3", publicationLockState: "unlocked", locationId: "station-a" },
    { reviewSubjectId: "workforce-unpublished", publicationLockState: null, locationId: "station-a" },
    { reviewSubjectId: "workforce-without-publication" }
  ];

  assert.deepEqual(workforcePayoutMappingLockSelectionIds(rows, "locked"), ["workforce-2", "workforce-1"]);
});

test("mapping relock selection filters for unlocked publications and ignores missing Workforce IDs", () => {
  const rows = [
    { reviewSubjectId: "workforce-3", publicationLockState: "unlocked", locationId: "station-a" },
    { reviewSubjectId: "", publicationLockState: "unlocked", locationId: "station-a" },
    { reviewSubjectId: null, publicationLockState: "unlocked", locationId: "station-b" },
    { publicationLockState: "unlocked", locationId: "station-c" },
    { reviewSubjectId: "workforce-1", publicationLockState: "locked", locationId: "station-a" },
    { reviewSubjectId: "workforce-3", publicationLockState: "unlocked", locationId: "station-b" },
    { reviewSubjectId: "workforce-2", publicationLockState: "unlocked", locationId: "station-c" },
    { reviewSubjectId: "workforce-unpublished", publicationLockState: null, locationId: "station-a" }
  ];
  const originalRows = structuredClone(rows);

  assert.deepEqual(workforcePayoutMappingLockSelectionIds(rows, "unlocked"), ["workforce-3", "workforce-2"]);
  assert.deepEqual(rows, originalRows);
});

test("unlimited UI selections are divided into safe action requests without splitting a profile", () => {
  const rows = [
    ...Array.from({ length: 49 }, (_, index) => ({ id: `a-${index}`, reviewSubjectId: `worker-${index}` })),
    { id: "shared-a", reviewSubjectId: "shared-worker" },
    { id: "shared-b", reviewSubjectId: "shared-worker" },
    ...Array.from({ length: 51 }, (_, index) => ({ id: `b-${index}`, reviewSubjectId: `later-${index}` }))
  ];
  const chunks = chunkPayoutRowsBySubject(rows, 50);

  assert.equal(chunks.flat().length, rows.length);
  assert.ok(chunks.every((chunk) => chunk.length <= 50));
  assert.equal(chunks.filter((chunk) => chunk.some((row) => row.reviewSubjectId === "shared-worker")).length, 1);
  assert.deepEqual(chunks.flat().map((row) => row.id), rows.map((row) => row.id));
});

test("large bank selections use one indexed row pass and keep one payment amount per Workforce profile", () => {
  const rows = Array.from({ length: 12_000 }, (_, index) => ({
    id: `row-${index}`,
    reviewSubjectId: `worker-${Math.floor(index / 2)}`,
    eligible: true,
    availableToPay: Math.floor(index / 2) + 1
  }));
  let eligibilityChecks = 0;
  let amountReads = 0;
  const index = buildWorkforcePayoutBankSelectionIndex(
    rows,
    (row) => {
      eligibilityChecks += 1;
      return row.eligible;
    },
    (row) => {
      amountReads += 1;
      return row.availableToPay;
    }
  );
  const selectedRowIds = new Set(rows.map((row) => row.id));
  const selectedWorkforceIds = new Set(rows.map((row) => row.reviewSubjectId));
  const selection = resolveWorkforcePayoutBankSelection(index, selectedRowIds, selectedWorkforceIds);

  assert.equal(eligibilityChecks, rows.length);
  assert.equal(amountReads, 6_000);
  assert.equal(index.size, 6_000);
  assert.equal(selection.workforceIds.length, 6_000);
  assert.equal(selection.totalAmount, 18_003_000);
  assert.deepEqual(index.get("worker-0"), { rowIds: ["row-0", "row-1"], availableToPay: 1 });

  selectedRowIds.delete("row-9");
  const partialSelection = resolveWorkforcePayoutBankSelection(index, selectedRowIds, selectedWorkforceIds);
  assert.equal(partialSelection.workforceIds.includes("worker-4"), false);
  assert.equal(partialSelection.workforceIds.length, 5_999);
});

test("pending-publication bank selection uses a profile-level preliminary balance without duplicating ledger totals", () => {
  const balances = buildWorkforcePayoutPreliminaryBalanceIndex([
    {
      id: "worker-1|station-a",
      reviewSubjectId: "worker-1",
      netAmount: 800,
      paymentSummary: { paidAmount: 250, processingAmount: 0 }
    },
    {
      id: "worker-1|station-b",
      reviewSubjectId: "worker-1",
      netAmount: 450.25,
      paymentSummary: { paidAmount: 250, processingAmount: 0 }
    },
    {
      id: "worker-1|station-b",
      reviewSubjectId: "worker-1",
      netAmount: 450.25,
      paymentSummary: { paidAmount: 250, processingAmount: 0 }
    },
    {
      id: "worker-2|station-a",
      reviewSubjectId: "worker-2",
      netAmount: 100,
      paymentSummary: { paidAmount: 25, processingAmount: 75 }
    },
    { id: "unmapped", reviewSubjectId: null, netAmount: 9_999 }
  ]);

  assert.equal(balances.get("worker-1"), 1_000.25);
  assert.equal(balances.get("worker-2"), 0);
  assert.equal(balances.has(""), false);
});

test("payout UI separates one-row advance recovery from complete-location notification selection", () => {
  assert.match(payoutTable, /import\s*\{\s*isWorkforcePayoutDisplayPublishable\s*\}\s*from\s*["']@\/lib\/workforce-payout-publication-eligibility["']/);
  assert.match(
    payoutTable,
    /function\s+canSendPayoutForReview\(row:[^)]+,\s*audience:[^)]+\)[\s\S]*?audience\s*===\s*["']workforce["']\s*\?\s*isWorkforcePayoutDisplayPublishable\(row\.status\)\s*:\s*row\.status\s*===\s*["']Ready for review["']\s*\|\|\s*row\.status\s*===\s*["']Returned["']/,
    "Workforce selection must use shared zero-payout eligibility while Helper selection remains Ready/Returned only."
  );
  assert.match(payoutTable, /advanceSelectionConflictIds\s*=\s*useMemo\(\(\)\s*=>\s*duplicateAdvanceWorkforceIds\(advanceSelectedRows\)/);
  assert.match(payoutTable, /if\s*\(hasAdvanceSelectionConflict\)[\s\S]*?Select one location row per Workforce member[\s\S]*?return;/);
  assert.match(payoutTable, /disabled=\{!advanceSelectedRows\.length\s*\|\|\s*hasAdvanceSelectionConflict/);
  assert.match(payoutTable, /title=\{hasAdvanceSelectionConflict\s*\?\s*["']Advance deduction requires one location row per Workforce member\./);
  assert.match(payoutTable, /Send Notification requires every publishable location row/i);
  assert.doesNotMatch(payoutTable, /maxActionSelection|actionSelectionLimitReached|actionSelectionTarget/);
  assert.match(payoutTable, /setSelected\(new Set\(selectable\.map\(\(row\)\s*=>\s*row\.id\)\)\)/);
  assert.match(payoutTable, /selectedRows\.filter\(\(row\)\s*=>\s*canSendPayoutForReview\(row,\s*audience\)\)/);
  assert.match(payoutTable, /chunkPayoutRowsBySubject\(reviewSelectedRows,\s*MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION\)/);
  assert.match(payoutTable, /items:\s*chunk\.map/);
  assert.doesNotMatch(payoutTable, /bankWorkforceIds[\s\S]{0,400}\.slice\(0,\s*50\)/);
  assert.match(payoutTable, /buildWorkforcePayoutBankSelectionIndex\(\s*rows,\s*\(row\) => bankActionableIds\.has\(row\.id\)/);
  assert.match(payoutTable, /resolveWorkforcePayoutBankSelection\(\s*bankSelectionIndex,\s*selected,\s*selectedBankWorkforceIds/);
  assert.doesNotMatch(payoutTable, /const bankWorkforceIds[\s\S]{0,500}rows\.(?:filter|find)\(/);
});

test("publication-refresh-pending rows remain explicit preliminary bank candidates", () => {
  assert.match(payoutTable, /eligibilityCode\?\.trim\(\)\.toLowerCase\(\) === "publication_refresh_pending"/);
  assert.match(payoutTable, /publicationRefreshPending\(row\) && preliminaryAvailableToPay > 0/);
  assert.match(payoutTable, /row\.panAadhaarStatus !== "NOT LINKED"/);
  assert.match(payoutTable, /BANK_PAYMENT_BLOCKED_STATUSES\.has\(visibleStatus\)/);
  assert.match(payoutTable, /bankActionableIds\.has\(row\.id\)/);
  assert.match(payoutTable, /Refresh before bank file · eligibility rechecked/);
  assert.match(payoutTable, /No stale publication will be paid/);
});

test("published and mapping-unlocked payouts remain available for manual input editing", () => {
  assert.match(payoutTable, /function canManuallyEditPayout[\s\S]*?paymentSummary\?\.status !== "Payment Processing"/);
  const manualGuard = payoutTable.match(/function canManuallyEditPayout[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(manualGuard, /publicationLockState/);
  assert.match(payoutTable, /\|\| \(canManuallyEdit && canManuallyEditPayout\(row\)\)/);
});

test("selected-month enrichment and high-cardinality loader reads use bounded parallel batches", () => {
  assert.match(payoutPage, /mapWithConcurrency\(chunkedValues\(ids, 100\), 4/);
  assert.match(payoutPage, /mapWithConcurrency\(chunkedValues\(workforceIds, 250\), 3/);
  assert.match(payoutLoader, /mapWithConcurrency\(chunkedValues\(payoutInputWorkforceIds, 100\), 3/);
  assert.match(payoutLoader, /mapWithConcurrency\(jobs, 4/);
});

test("published mapping corrections are audited, company-wide and explicitly relocked", () => {
  assert.match(payoutPage, /from\("workforce_payout_mapping_unlocks"\)/);
  assert.match(payoutPage, /rpc\("workforce_payout_mapping_unlock_impacted_ids"/);
  assert.match(payoutPage, /authorization\.hasAllLocationAccess/);
  assert.match(payoutPage, /canManageMappingLocks\s*\?\s*loadOpenMappingUnlocks\(/);
  assert.ok(
    payoutPage.indexOf("const canManageMappingLocks") < payoutPage.indexOf("? loadOpenMappingUnlocks("),
    "The all-location edit gate must run before service-role open-correction data is loaded."
  );
  assert.match(payoutPage, /publicationLockState/);
  assert.match(payoutTable, /Unlock mapping \(/);
  assert.match(payoutTable, /Relock &amp; republish/);
  assert.match(payoutTable, /\/api\/payments\/workforce-payouts\/mapping-locks/);
  assert.match(payoutTable, /role="alertdialog"/);
  assert.match(payoutTable, /crypto\.randomUUID\(\)/);
  assert.match(payoutTable, /last stable payout remains in DropX One as revising/i);
  assert.match(payoutTable, /silent payout revision in Dashboard and DropX One/i);
});
