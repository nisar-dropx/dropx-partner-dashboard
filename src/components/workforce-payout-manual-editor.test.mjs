import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workforce-payout-manual-editor.tsx", import.meta.url), "utf8");
const tableSource = readFileSync(new URL("./workforce-payout-table.tsx", import.meta.url), "utf8");

test("manual editor receives selected payouts and supports several independently editable lines", () => {
  assert.match(source, /selectedRows:\s*WorkforcePayoutManualSelection\[\]/);
  assert.match(source, /createWorkforcePayoutManualLines\(selectedRows, fromDate, toDate\)/);
  assert.match(source, /Add line/);
  assert.match(source, /lines\.map\(\(line, index\)/);
  assert.match(source, /Input type for line/);
  assert.match(source, /Field for line/);
  assert.match(source, /From date for line/);
  assert.match(source, /To date for line/);
  assert.match(source, /Value for line/);
});

test("manual editor exposes Set, Clear and apply-to-all actions", () => {
  assert.match(source, /<option value="UPSERT">Set value<\/option>/);
  assert.match(source, /<option value="CLEAR">Clear stored value<\/option>/);
  assert.match(source, /applyWorkforcePayoutManualLineToAll\(current, lineId, selectedRows\)/);
  assert.match(source, />\s*Apply to all\s*</);
  assert.match(source, /action === "CLEAR" \? "" : line\.value/);
});

test("manual editor reuses bulk upload preview and commit with generated CSV", () => {
  assert.match(source, /buildWorkforcePayoutManualCsv\(lines\)/);
  assert.match(source, /new File\(\[csv\],[\s\S]*?\.csv/);
  assert.match(source, /body\.set\("mode", mode\)/);
  assert.match(source, /body\.set\("effective_from", fromDate\)/);
  assert.match(source, /body\.set\("effective_to", toDate\)/);
  assert.match(source, /body\.set\("input_source", "manual"\)/);
  assert.match(source, /body\.set\("manual_operation_id", operationIdRef\.current\)/);
  assert.match(source, /if \(!operationIdRef\.current\) operationIdRef\.current = crypto\.randomUUID\(\)/);
  assert.match(source, /mode === "commit"[\s\S]*?operationIdRef\.current = ""/);
  assert.match(source, /fetch\("\/api\/payments\/workforce-payouts\/bulk-upload", \{ method: "POST", body \}\)/);
  assert.match(source, /submit\("preview"\)/);
  assert.match(source, /submit\("commit"\)/);
  assert.match(source, /mode === "commit" && \(!preview\?\.canCommit \|\| preview\.importId\)/);
  assert.match(source, /Preview and validate the current input lines before applying them/);
  assert.match(source, /role="alertdialog"/);
});

test("manual editor loads its scoped field catalog and warns about published selections", () => {
  assert.match(source, /\/api\/payments\/workforce-payouts\/manual-inputs\/catalog/);
  assert.match(source, /already published/i);
  assert.match(source, /historical snapshot/i);
  assert.match(source, /updated revision/i);
  assert.match(source, /preview\?\.warnings/);
  assert.match(source, /Applied with/);
  assert.match(source, /selectedField\.calculation/);
  assert.match(source, /selectedField\.valueMeaning/);
  assert.match(source, /notification \(\?:queued\|failed\)/);
});

test("manual editor does not exclude already-published selected rows", () => {
  assert.match(source, /disabled=\{!selectedRows\.length\}/);
  assert.match(source, /createWorkforcePayoutManualLines\(selectedRows, fromDate, toDate\)/);
  assert.doesNotMatch(source, /createWorkforcePayoutManualLines\(selectedRows\.filter/);
});

test("manual editor dialogs trap focus, hide the inactive layer and restore the launcher", () => {
  assert.match(source, /function trapDialogFocus/);
  assert.match(source, /onKeyDown=\{trapDialogFocus\}/);
  assert.match(source, /inert=\{confirmationOpen \|\| undefined\}/);
  assert.match(source, /launcherRef\.current\?\.focus\(\)/);
});

test("Workforce payout selection exposes manual editing independently of notification publishability", () => {
  assert.match(tableSource, /const canManuallyEdit = canEdit && audience === "workforce"/);
  assert.match(tableSource, /\|\| \(canManuallyEdit && canManuallyEditPayout\(row\)\)/);
  assert.match(tableSource, /<WorkforcePayoutManualEditor/);
  assert.match(tableSource, /buttonLabel="Edit payout inputs"/);
  assert.match(tableSource, /manualSelectedRows\.map/);
  assert.match(tableSource, /if \(!reviewSelectedRows\.length \|\| reviewState\.busy\) return/);
  assert.match(tableSource, /Send Notification[\s\S]*?reviewSelectedRows\.length/);
});
