import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  PAYMENT_RECOVERY_IMPORT_HEADERS,
  PAYMENT_RECOVERY_IMPORT_MAX_ROWS,
  buildPaymentRecoveryImportTemplate,
  normalizePaymentRecoveryTid,
  parsePaymentRecoveryWorkbook,
  paymentRecoveryWorkbookSha256
} from "./payment-recovery-import.ts";

function recoveryRow(overrides = {}) {
  const row = {
    tid: "TID-000001",
    location: "KOZA",
    debitMonth: "Jul-26",
    value: 2000,
    providerReference: "",
    reason: "Shipment loss",
    remark: "",
    ...overrides
  };
  return [
    row.tid,
    row.location,
    row.debitMonth,
    row.value,
    row.providerReference,
    row.reason,
    row.remark
  ];
}

function workbookBytes(rows, headers = PAYMENT_RECOVERY_IMPORT_HEADERS) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[...headers], ...rows]), "Upload");
  return new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}

test("parses unconfigured TID recovery cases with a stable file hash", () => {
  const bytes = workbookBytes([
    recoveryRow({
      tid: " tid-000001 ",
      location: " koza ",
      debitMonth: "jUl-26",
      value: "₹2,000.50"
    }),
    recoveryRow({
      tid: "TID-000002",
      debitMonth: "OCT-26",
      value: 1500,
      providerReference: "PROVIDER-DEBIT-002"
    })
  ]);
  const parsed = parsePaymentRecoveryWorkbook(bytes);

  assert.equal(parsed.canCommit, true);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.rows[0].tid, "tid-000001");
  assert.equal(parsed.rows[0].normalizedTid, "TID-000001");
  assert.equal(parsed.rows[0].locationCode, "KOZA");
  assert.equal(parsed.rows[0].debitMonth, "2026-07-01");
  assert.equal(parsed.rows[0].value, 2000.5);
  assert.equal(parsed.rows[0].providerReference, "");
  assert.equal(parsed.rows[1].debitMonth, "2026-10-01");
  assert.equal(parsed.rows[1].providerReference, "PROVIDER-DEBIT-002");
  assert.deepEqual(Object.keys(parsed.rows[0]), [
    "rowNumber",
    "tid",
    "normalizedTid",
    "locationCode",
    "debitMonth",
    "value",
    "providerReference",
    "reason",
    "remark"
  ]);
  assert.equal(parsed.fileSha256, paymentRecoveryWorkbookSha256(bytes));
  assert.match(parsed.fileSha256, /^[a-f0-9]{64}$/);
  assert.equal(normalizePaymentRecoveryTid(" tid 1 "), "TID1");
});

test("normalizes genuine Excel date cells to the first day of their month", () => {
  const date1904Workbook = XLSX.utils.book_new();
  date1904Workbook.Workbook = { WBProps: { date1904: true } };
  const date1904Sheet = XLSX.utils.aoa_to_sheet([
    [...PAYMENT_RECOVERY_IMPORT_HEADERS],
    recoveryRow({ tid: "TID-1904", debitMonth: 44840 })
  ]);
  date1904Sheet.C2.z = "mmm-yy";
  XLSX.utils.book_append_sheet(date1904Workbook, date1904Sheet, "Upload");
  const date1904Bytes = new Uint8Array(XLSX.write(date1904Workbook, { bookType: "xlsx", type: "buffer" }));
  assert.equal(parsePaymentRecoveryWorkbook(date1904Bytes).rows[0].debitMonth, "2026-10-01");

  const excelDate = new Date(Date.UTC(2026, 9, 8));
  const typed = parsePaymentRecoveryWorkbook(workbookBytes([
    recoveryRow({ tid: "TID-DATE", debitMonth: excelDate })
  ]));
  assert.deepEqual(typed.issues, []);
  assert.equal(typed.rows[0].debitMonth, "2026-10-01");
});

test("rejects unsafe numeric TIDs, scientific notation and formulas", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [...PAYMENT_RECOVERY_IMPORT_HEADERS],
    recoveryRow({ tid: 1_000_000_000_000_000 }),
    recoveryRow({ tid: "1.2345E+20" }),
    recoveryRow({ tid: "TID-FORMULA" }),
    recoveryRow({ tid: "TID-LITERAL", remark: "=SUM(1,2)" })
  ]);
  sheet.D4 = { t: "n", f: "1000+1000", v: 2000 };
  XLSX.utils.book_append_sheet(workbook, sheet, "Upload");
  const bytes = new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
  const parsed = parsePaymentRecoveryWorkbook(bytes);
  const messages = parsed.issues.map((issue) => issue.message).join("\n");

  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.canCommit, false);
  assert.match(messages, /TID was stored as an unsafe number or scientific notation/i);
  assert.match(messages, /Formula cells are not accepted/i);
});

test("requires a location and strict MMM-YY month text", () => {
  const parsed = parsePaymentRecoveryWorkbook(workbookBytes([
    recoveryRow({ tid: "TID-DUP", debitMonth: "2026-10-01", value: 0 }),
    recoveryRow({ tid: " tid-dup ", location: "", debitMonth: "01/10/2026", value: 12.345 })
  ]));
  const messages = parsed.issues.map((issue) => issue.message).join("\n");

  assert.equal(parsed.canCommit, false);
  assert.match(messages, /LOCATION is required/i);
  assert.match(messages, /DEBIT_MONTH must be a real Excel date or text written exactly as MMM-YY/i);
  assert.match(messages, /VALUE must be greater than zero/i);
  assert.match(messages, /at most two decimal places/i);
  assert.match(messages, /TID duplicates row 2/i);
});

test("requires the four core headers, permits omitted optional columns and reports obsolete columns", () => {
  const minimal = parsePaymentRecoveryWorkbook(workbookBytes([
    recoveryRow().slice(0, 4)
  ], ["TID", "LOCATION", "DEBIT_MONTH", "VALUE"]));
  assert.equal(minimal.canCommit, true);
  assert.equal(minimal.rows[0].providerReference, "");
  assert.equal(minimal.rows[0].reason, "");
  assert.equal(minimal.rows[0].remark, "");

  assert.throws(() => parsePaymentRecoveryWorkbook(workbookBytes([
    recoveryRow().slice(0, 3)
  ], ["TID", "LOCATION", "DEBIT_MONTH"])), /VALUE/i);

  const parsed = parsePaymentRecoveryWorkbook(workbookBytes([
    [...recoveryRow(), "AMAZON", 2000, "PAYOUT_DEDUCTION", "DROPX1001"]
  ], [
    ...PAYMENT_RECOVERY_IMPORT_HEADERS,
    "PROVIDER_CODE",
    "DEBIT_AMOUNT",
    "RECOVERY_METHOD",
    "RECOVERY_IDS"
  ]));
  const obsoleteMessages = parsed.issues.map((issue) => issue.message).join("\n");
  assert.match(obsoleteMessages, /Unknown column “PROVIDER_CODE”/i);
  assert.match(obsoleteMessages, /Unknown column “DEBIT_AMOUNT”/i);
  assert.match(obsoleteMessages, /Unknown column “RECOVERY_METHOD”/i);
  assert.match(obsoleteMessages, /Unknown column “RECOVERY_IDS”/i);
});

test("limits one workbook to 10,000 populated TIDs", () => {
  const rows = Array.from({ length: PAYMENT_RECOVERY_IMPORT_MAX_ROWS + 1 }, (_, index) => recoveryRow({
    tid: `TID-${index + 1}`
  }));
  assert.throws(
    () => parsePaymentRecoveryWorkbook(workbookBytes(rows)),
    /at most 10000 TIDs/i
  );
});

test("builds the current three-sheet template with the exact unconfigured-case headers", () => {
  const bytes = buildPaymentRecoveryImportTemplate({ exampleMonth: "2026-10-01" });
  const workbook = XLSX.read(bytes, { type: "array", cellStyles: true, cellDates: true });
  assert.deepEqual(workbook.SheetNames, ["Upload", "Examples", "Instructions"]);

  const upload = XLSX.utils.sheet_to_json(workbook.Sheets.Upload, { header: 1, defval: "" });
  assert.deepEqual(upload[0], [...PAYMENT_RECOVERY_IMPORT_HEADERS]);
  assert.equal(workbook.Sheets.Upload.A2.z, "@");
  assert.equal(workbook.Sheets.Upload.C2.z, "mmm-yy");

  const examples = XLSX.utils.sheet_to_json(workbook.Sheets.Examples, { header: 1, defval: "", raw: false });
  assert.match(examples[0][0], /EXAMPLES ONLY/i);
  assert.deepEqual(examples[1], [...PAYMENT_RECOVERY_IMPORT_HEADERS]);
  assert.equal(examples[2][2], "Oct-26");
  assert.equal(workbook.Sheets.Examples.C3.z, "mmm-yy");
  assert.equal(examples[2][4], "");
  assert.equal(examples[3][4], "PROVIDER-DEBIT-002");

  const instructions = XLSX.utils.sheet_to_json(workbook.Sheets.Instructions, { header: 1, defval: "" });
  const instructionText = instructions.flat().join("\n");
  assert.match(instructionText, /MMM-YY, for example Jul-26/i);
  assert.match(instructionText, /provider is identified automatically from this location/i);
  assert.match(instructionText, /PROVIDER_REFERENCE\nOptional/i);
  assert.match(instructionText, /scientific notation and formulas are rejected/i);
  assert.match(instructionText, /creates an unconfigured TID recovery case/i);
  assert.doesNotMatch(instructionText, /RECOVERY_METHOD|RECOVERY_IDS|DEBIT_AMOUNT/i);
});
