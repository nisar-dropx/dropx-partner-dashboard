import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(new URL("./provider-first-mapping-worksheet.tsx", import.meta.url), "utf8");

test("paid owner remap posts one explicit Keep or Transfer decision", () => {
  assert.match(component, /\[payment_transfer_action\]/);
  assert.match(component, /\[payment_transfer_fingerprint\]/);
  assert.match(component, /\[payment_transfer_operation_id\]/);
  assert.match(component, /choosePaidHistoryAction\("keep"\)/);
  assert.match(component, /choosePaidHistoryAction\("transfer"\)/);
  assert.match(component, /Keep paid credit with \{payment\.existingDropxId\}/);
  assert.match(component, /Transfer payment details to \{payment\.newDropxId\}/);
  assert.match(component, /disabled=\{isSaving \|\| !payment\.transferAllowed\}/);
  assert.match(component, /payment\.transferBlockedReason/);
  assert.match(component, /paymentFingerprint: payment\.paymentFingerprint/);
  assert.match(component, /operationId: payment\.operationId/);
});

test("paid-history confirmation explains immutable bank evidence", () => {
  assert.match(component, /does not create, reverse or rewrite a bank payment/);
  assert.match(component, /original bank reference and UTR remain unchanged/);
  assert.match(component, /audited paid credit is applied to the new ID/);
});

test("ambiguous consolidated paid allocations cannot select Transfer", () => {
  assert.match(component, /transferAllowed: boolean/);
  assert.match(component, /payment\.transferBlockedReason/);
  assert.match(component, /disabled=\{isSaving \|\| !payment\.transferAllowed\}/);
  assert.match(component, /choosePaidHistoryAction\("keep"\)/);
});

test("a retry reuses the confirmed ledger fingerprint and operation ID", () => {
  assert.match(component, /setPaidHistoryConfirmation\(\{ \.\.\.paidHistoryConfirmation, confirmedPaidHistoryDecisions \}\)/);
  assert.match(component, /void saveIndexes\(indexes, mappingIds, mappingActions, confirmedPaidHistoryDecisions\)/);
  assert.match(component, /else if \(result\.ok\) \{\s*setPaidHistoryConfirmation\(null\)/);
});
