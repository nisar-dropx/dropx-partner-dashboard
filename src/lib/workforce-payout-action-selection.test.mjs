import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { duplicateAdvanceWorkforceIds } from "./workforce-payout-action-selection.ts";

const payoutTable = readFileSync(new URL("../components/workforce-payout-table.tsx", import.meta.url), "utf8");

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
  assert.match(payoutTable, /maxActionSelection\s*=\s*audience\s*===\s*["']workforce["']\s*\?\s*MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION\s*:\s*MAX_REVIEW_SELECTION/);
  assert.match(payoutTable, /actionSelectionTarget\s*=\s*useMemo\(\(\)\s*=>\s*selectable\.slice\(0,\s*maxActionSelection\)/);
  assert.match(payoutTable, /setSelected\(new Set\(actionSelectionTarget\.map\(\(row\)\s*=>\s*row\.id\)\)\)/);
  assert.match(payoutTable, /selectedRows\.filter\(\(row\)\s*=>\s*canSendPayoutForReview\(row,\s*audience\)\)/);
  assert.match(payoutTable, /items:\s*reviewSelectedRows\.map/);
});
