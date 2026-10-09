import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkforcePayoutManualLineToAll,
  buildWorkforcePayoutManualCsv,
  createWorkforcePayoutManualLines,
  normalizeWorkforcePayoutManualLineType,
  validateWorkforcePayoutManualLines
} from "./workforce-payout-manual-entry.ts";
import { parseWorkforcePayoutWorkbook } from "./workforce-payout-import.ts";
import { workforcePayoutImportFingerprint } from "./workforce-payout-import-fingerprint.ts";

const selections = [
  { id: "payout-1", dropxId: "DX-001", name: "One", location: "KTUO", status: "Ready for review" },
  { id: "payout-2", dropxId: "DX-002", name: "Two", location: "XAPH", status: "Payment published" }
];

function completedLine(overrides = {}) {
  return {
    ...createWorkforcePayoutManualLines(selections.slice(0, 1), "2026-09-01", "2026-09-30")[0],
    inputType: "DEDUCTION",
    fieldCode: "FINE",
    value: "250.50",
    remark: "Manual, checked",
    ...overrides
  };
}

test("manual payout lines start once per selected payout without inventing a field", () => {
  const lines = createWorkforcePayoutManualLines(selections, "2026-09-01", "2026-09-30");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => [line.dropxId, line.location]), [["DX-001", "KTUO"], ["DX-002", "XAPH"]]);
  assert.equal(lines[0].inputType, "");
  assert.equal(lines[0].fieldCode, "");
});

test("changing to a period-only type locks dates to the complete payout period", () => {
  const source = completedLine({ effectiveDate: "2026-09-10", effectiveTo: "2026-09-15" });
  const normalized = normalizeWorkforcePayoutManualLineType(source, "ADDITIONAL_PAYMENT", "2026-09-01", "2026-09-30");
  assert.equal(normalized.effectiveDate, "2026-09-01");
  assert.equal(normalized.effectiveTo, "2026-09-30");
  assert.equal(normalized.fieldCode, "");
});

test("apply to all fills each selected payout while retaining its identity and location", () => {
  const starters = createWorkforcePayoutManualLines(selections, "2026-09-01", "2026-09-30");
  starters[0] = completedLine();
  const filled = applyWorkforcePayoutManualLineToAll(starters, starters[0].id, selections);
  assert.equal(filled.length, 2, "the untouched starter line should be filled instead of duplicated");
  assert.deepEqual(filled.map((line) => ({
    dropxId: line.dropxId,
    location: line.location,
    type: line.inputType,
    field: line.fieldCode,
    value: line.value
  })), [
    { dropxId: "DX-001", location: "KTUO", type: "DEDUCTION", field: "FINE", value: "250.50" },
    { dropxId: "DX-002", location: "XAPH", type: "DEDUCTION", field: "FINE", value: "250.50" }
  ]);
});

test("reusing apply to all for another field always creates unique editable line ids", () => {
  const starters = createWorkforcePayoutManualLines(selections, "2026-09-01", "2026-09-30");
  starters[0] = completedLine();
  const firstCopy = applyWorkforcePayoutManualLineToAll(starters, starters[0].id, selections);
  const changedSource = firstCopy.map((line) => line.id === starters[0].id
    ? { ...line, fieldCode: "OTHER_FINE", value: "75" }
    : line);
  const secondCopy = applyWorkforcePayoutManualLineToAll(changedSource, starters[0].id, selections);
  assert.equal(secondCopy.length, 3);
  assert.equal(new Set(secondCopy.map((line) => line.id)).size, secondCopy.length);
  assert.deepEqual(secondCopy.filter((line) => line.dropxId === "DX-002").map((line) => line.fieldCode).sort(), ["FINE", "OTHER_FINE"]);
});

test("CSV uses the bulk-upload schema, unambiguous dates, escaping and blank CLEAR values", () => {
  const csv = buildWorkforcePayoutManualCsv([
    completedLine(),
    completedLine({
      id: "manual-line-2",
      selectionKey: "payout-2",
      dropxId: "DX-002",
      location: "XAPH",
      action: "CLEAR",
      value: "999",
      remark: "Remove \"wrong\" value"
    })
  ]);
  const rows = csv.trimEnd().split("\r\n");
  assert.equal(rows[0], "ACTION,DROPX_ID,LOCATION,INPUT_TYPE,FIELD_CODE,EFFECTIVE_DATE,EFFECTIVE_TO,VALUE,REMARK");
  assert.match(rows[1], /^UPSERT,DX-001,KTUO,DEDUCTION,FINE,2026-09-01,2026-09-30,250\.50,"Manual, checked"$/);
  assert.match(rows[2], /^CLEAR,DX-002,XAPH,DEDUCTION,FINE,2026-09-01,2026-09-30,,"Remove ""wrong"" value"$/);
});

test("generated CSV is accepted by the existing bulk workbook parser", () => {
  const csv = buildWorkforcePayoutManualCsv([completedLine()]);
  const parsed = parseWorkforcePayoutWorkbook(new TextEncoder().encode(csv), {
    batchFrom: "2026-09-01",
    batchTo: "2026-09-30"
  });
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.rows.map((row) => ({
    action: row.action,
    dropxId: row.dropxId,
    location: row.locationCode,
    inputType: row.inputType,
    fieldCode: row.fieldCode,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    numericValue: row.numericValue,
    remark: row.remark
  })), [{
    action: "UPSERT",
    dropxId: "DX-001",
    location: "KTUO",
    inputType: "DEDUCTION",
    fieldCode: "FINE",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30",
    numericValue: 250.5,
    remark: "Manual, checked"
  }]);
});

test("client validation catches incomplete, invalid and duplicate lines before upload", () => {
  const incomplete = createWorkforcePayoutManualLines(selections.slice(0, 1), "2026-09-01", "2026-09-30");
  assert.match(validateWorkforcePayoutManualLines(incomplete, "2026-09-01", "2026-09-30").map((issue) => issue.message).join(" "), /Select an input type/);

  const invalidProduction = completedLine({
    inputType: "PRODUCTION_UNITS",
    fieldCode: "DELIVERY",
    effectiveDate: "2026-09-10",
    effectiveTo: "2026-09-11",
    value: "-1"
  });
  const invalidMessages = validateWorkforcePayoutManualLines([invalidProduction], "2026-09-01", "2026-09-30").map((issue) => issue.message).join(" ");
  assert.match(invalidMessages, /one work date/);
  assert.match(invalidMessages, /cannot be negative/);

  const duplicate = completedLine({ id: "duplicate" });
  assert.match(validateWorkforcePayoutManualLines([completedLine(), duplicate], "2026-09-01", "2026-09-30").map((issue) => issue.message).join(" "), /duplicates another selected payout input/);
});

test("attendance hours and days remain distinct manual line identities", () => {
  const hours = completedLine({ inputType: "ATTENDANCE", fieldCode: "WORK_HOURS", value: "160" });
  const days = completedLine({ id: "days", inputType: "ATTENDANCE", fieldCode: "WORK_DAYS", value: "20" });
  assert.doesNotMatch(
    validateWorkforcePayoutManualLines([hours, days], "2026-09-01", "2026-09-30").map((issue) => issue.message).join(" "),
    /duplicates another selected payout input/
  );
});

test("manual A to B to A uses distinct operation fingerprints while retries stay idempotent", () => {
  const encoder = new TextEncoder();
  const a = encoder.encode("BONUS,100");
  const b = encoder.encode("BONUS,200");
  const firstA = workforcePayoutImportFingerprint(a, "11111111-1111-4111-8111-111111111111");
  const middleB = workforcePayoutImportFingerprint(b, "22222222-2222-4222-8222-222222222222");
  const restoredA = workforcePayoutImportFingerprint(a, "33333333-3333-4333-8333-333333333333");

  assert.notEqual(firstA, middleB);
  assert.notEqual(firstA, restoredA);
  assert.notEqual(middleB, restoredA);
  assert.equal(restoredA, workforcePayoutImportFingerprint(a, "33333333-3333-4333-8333-333333333333"));
  assert.equal(
    workforcePayoutImportFingerprint(a),
    workforcePayoutImportFingerprint(a),
    "ordinary bulk workbooks remain content-idempotent"
  );
});
