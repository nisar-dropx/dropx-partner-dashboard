import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  WORKFORCE_ADVANCE_IMPORT_HEADERS,
  buildWorkforceAdvanceImportTemplate,
  normalizeWorkforceAdvanceId,
  parseWorkforceAdvanceWorkbook,
  workforceAdvanceImportBusinessKey,
  workforceAdvanceLegacyImportBusinessKey,
  workforceAdvanceWorkbookSha256
} from "./workforce-advance-import.ts";

function workbookBytes(rows, headers = WORKFORCE_ADVANCE_IMPORT_HEADERS) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[...headers], ...rows]), "Upload");
  return new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}

test("parses existing advances, preserves source IDs and builds normalized lookup keys", () => {
  const excelDate = new Date(Date.UTC(2026, 9, 2));
  const bytes = workbookBytes([
    [" dropx1001 ", "01-10-2026", 5000, 1250, "REF-1", "Bank transfer", "Existing advance"],
    [2000031112340, excelDate, "₹1,250.50", "", "UPI-2", "UPI payment", "October advance"]
  ]);
  const parsed = parseWorkforceAdvanceWorkbook(bytes);

  assert.equal(parsed.canCommit, true);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.rows[0].dropxId, "dropx1001");
  assert.equal(parsed.rows[0].normalizedDropxId, "DROPX1001");
  assert.equal(parsed.rows[0].advanceDate, "2026-10-01");
  assert.equal(parsed.rows[0].deductedAmount, 1250);
  assert.equal(parsed.rows[0].paymentMode, "bank_transfer");
  assert.equal(parsed.rows[1].dropxId, "2000031112340");
  assert.equal(parsed.rows[1].normalizedDropxId, "2000031112340");
  assert.equal(parsed.rows[1].advanceDate, "2026-10-02");
  assert.equal(parsed.rows[1].amount, 1250.5);
  assert.equal(parsed.rows[1].deductedAmount, 0);
  assert.equal(parsed.rows[1].paymentMode, "upi");
  assert.equal(parsed.fileSha256, workforceAdvanceWorkbookSha256(bytes));
  assert.match(parsed.fileSha256, /^[a-f0-9]{64}$/);
  assert.equal(normalizeWorkforceAdvanceId(" Drop x 1001 "), "DROPX1001");
});

test("honors the workbook date epoch without changing 1900 dates or date strings", () => {
  const date1904Workbook = XLSX.utils.book_new();
  date1904Workbook.Workbook = { WBProps: { date1904: true } };
  const date1904Sheet = XLSX.utils.aoa_to_sheet([
    [...WORKFORCE_ADVANCE_IMPORT_HEADERS],
    ["DROPX1904", 44840, 500, 0, "REF-1904", "Cash", ""]
  ]);
  date1904Sheet.B2.z = "dd/mm/yyyy";
  XLSX.utils.book_append_sheet(date1904Workbook, date1904Sheet, "Upload");
  const date1904Bytes = new Uint8Array(XLSX.write(date1904Workbook, { bookType: "xlsx", type: "buffer" }));
  const persistedDate1904Workbook = XLSX.read(date1904Bytes, { type: "array" });

  assert.equal(persistedDate1904Workbook.Workbook?.WBProps?.date1904, true);
  assert.equal(persistedDate1904Workbook.Sheets.Upload.B2.w, "07/10/2026");
  assert.equal(parseWorkforceAdvanceWorkbook(date1904Bytes).rows[0].advanceDate, "2026-10-07");

  const date1900Parsed = parseWorkforceAdvanceWorkbook(workbookBytes([
    ["DROPX1900", new Date(Date.UTC(2026, 9, 8)), 500, 0, "REF-1900", "Cash", ""],
    ["DROPXTEXT", "09/10/2026", 500, 0, "REF-TEXT", "Cash", ""]
  ]));

  assert.equal(date1900Parsed.rows[0].advanceDate, "2026-10-08");
  assert.equal(date1900Parsed.rows[1].advanceDate, "2026-10-09");
});

test("parses CSV input and preserves optional blank details", () => {
  const csv = [
    WORKFORCE_ADVANCE_IMPORT_HEADERS.join(","),
    "dropx2002,03/10/2026,2500,0,,,Legacy opening balance"
  ].join("\n");
  const parsed = parseWorkforceAdvanceWorkbook(new TextEncoder().encode(csv));

  assert.equal(parsed.canCommit, true);
  assert.equal(parsed.rows[0].dropxId, "dropx2002");
  assert.equal(parsed.rows[0].normalizedDropxId, "DROPX2002");
  assert.equal(parsed.rows[0].advanceDate, "2026-10-03");
  assert.equal(parsed.rows[0].reference, "");
  assert.equal(parsed.rows[0].paymentMode, "other");
});

test("reports invalid dates, non-positive or over-precise amounts and exact duplicates", () => {
  const parsed = parseWorkforceAdvanceWorkbook(workbookBytes([
    ["DROPX1", "2026-10-01", 0, 0, "", "Cash", ""],
    ["DROPX2", "02/10/2026", -1, 0, "", "Cash", ""],
    ["DROPX3", "03/10/2026", 12.345, 0, "", "Cash", ""],
    ["DROPX4", "04/10/2026", 500, 10, "REF-4", "UPI", "first"],
    ["dropx4", "04-10-2026", 500, 20, "ref-4", "upi payment", "duplicate with another remark"]
  ]));
  const messages = parsed.issues.map((issue) => issue.message).join("\n");

  assert.equal(parsed.canCommit, false);
  assert.match(messages, /ADVANCE_DATE must be a real date/i);
  assert.match(messages, /AMOUNT must be greater than zero/i);
  assert.match(messages, /at most two decimal places/i);
  assert.match(messages, /duplicates row 5/i);
});

test("validates historical deducted amounts against each advance", () => {
  const parsed = parseWorkforceAdvanceWorkbook(workbookBytes([
    ["DROPX1", "01/10/2026", 500, -1, "REF-1", "Cash", ""],
    ["DROPX2", "02/10/2026", 500, 500.001, "REF-2", "Cash", ""],
    ["DROPX3", "03/10/2026", 500, 501, "REF-3", "Cash", ""],
    ["DROPX4", "04/10/2026", 500, "not a number", "REF-4", "Cash", ""]
  ]));
  const messages = parsed.issues.map((issue) => issue.message).join("\n");

  assert.equal(parsed.canCommit, false);
  assert.match(messages, /DEDUCTED_AMOUNT cannot be negative/i);
  assert.match(messages, /DEDUCTED_AMOUNT can have at most two decimal places/i);
  assert.match(messages, /DEDUCTED_AMOUNT cannot be greater than AMOUNT/i);
  assert.match(messages, /DEDUCTED_AMOUNT must be a valid number or blank/i);
});

test("rejects formulas and obsolete columns without losing preview rows", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [...WORKFORCE_ADVANCE_IMPORT_HEADERS, "OLD_STATUS"],
    ["DROPX9", "05/10/2026", 1000, 0, "REF-9", "Cash", "", "pending"]
  ]);
  sheet.C2 = { t: "n", f: "500+500", v: 1000 };
  XLSX.utils.book_append_sheet(workbook, sheet, "Upload");
  const bytes = new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
  const parsed = parseWorkforceAdvanceWorkbook(bytes);
  const messages = parsed.issues.map((issue) => issue.message).join("\n");

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.canCommit, false);
  assert.match(messages, /Unknown column “OLD_STATUS”/i);
  assert.match(messages, /Formula cells are not accepted/i);
});

test("requires the current header contract", () => {
  assert.throws(() => parseWorkforceAdvanceWorkbook(workbookBytes([
    ["DROPX1", "01/10/2026", 500, 0, "Cash", ""]
  ], ["DROPX_ID", "ADVANCE_DATE", "AMOUNT", "DEDUCTED_AMOUNT", "PAYMENT_MODE", "REMARK"])), /REFERENCE/i);
});

test("builds a stable row key from reference or fallback business details", () => {
  const referenceKey = workforceAdvanceImportBusinessKey({
    dropxId: " drop x 1001 ",
    advanceDate: "2026-10-01",
    amount: 500,
    reference: " Bank   Ref 001 ",
    paymentMode: "bank_transfer"
  });
  const equivalentReferenceKey = workforceAdvanceImportBusinessKey({
    dropxId: "DROPX1001",
    advanceDate: "2026-11-01",
    amount: 900,
    reference: "bank ref 001",
    paymentMode: "cash"
  });
  const fallbackKey = workforceAdvanceImportBusinessKey({
    dropxId: "dropx1001",
    advanceDate: "2026-10-01",
    amount: 500,
    reference: "",
    paymentMode: "cash"
  });

  assert.match(referenceKey, /^WAI2-[a-f0-9]{32}$/);
  assert.equal(referenceKey, equivalentReferenceKey);
  assert.notEqual(referenceKey, fallbackKey);
  assert.equal(fallbackKey, workforceAdvanceImportBusinessKey({
    dropxId: "DROP X 1001",
    advanceDate: "2026-10-01",
    amount: 500,
    reference: "",
    paymentMode: "cash"
  }));
  assert.match(workforceAdvanceLegacyImportBusinessKey({
    workforceId: "00000000-0000-4000-8000-000000000005",
    advanceDate: "2026-10-01",
    amount: 500,
    reference: "",
    paymentMode: "cash"
  }), /^WAI1-[a-f0-9]{32}$/);
});

test("builds a focused workbook with safe examples and instructions", () => {
  const bytes = buildWorkforceAdvanceImportTemplate({ exampleDate: "2026-10-01" });
  const workbook = XLSX.read(bytes, { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["Upload", "Examples", "Instructions"]);

  const upload = XLSX.utils.sheet_to_json(workbook.Sheets.Upload, { header: 1, defval: "" });
  assert.deepEqual(upload[0], [...WORKFORCE_ADVANCE_IMPORT_HEADERS]);
  assert.equal(upload.length, 1);

  const examples = XLSX.utils.sheet_to_json(workbook.Sheets.Examples, { header: 1, defval: "" });
  assert.match(examples[0][0], /EXAMPLES ONLY/i);
  assert.deepEqual(examples[1], [...WORKFORCE_ADVANCE_IMPORT_HEADERS]);
  assert.equal(examples[2][1], "01/10/2026");

  const instructions = XLSX.utils.sheet_to_json(workbook.Sheets.Instructions, { header: 1, defval: "" });
  const instructionText = instructions.flat().join("\n");
  assert.match(instructionText, /DD-MM-YYYY or DD\/MM\/YYYY/i);
  assert.match(instructionText, /greater than zero/i);
  assert.match(instructionText, /DEDUCTED_AMOUNT/i);
  assert.match(instructionText, /re-saved workbook/i);
  assert.match(instructionText, /awaiting Workforce registration/i);
});
