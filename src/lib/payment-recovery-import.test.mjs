import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  PAYMENT_RECOVERY_IMPORT_HEADERS,
  PAYMENT_RECOVERY_IMPORT_MAX_ROWS,
  buildPaymentRecoveryImportTemplate,
  normalizePaymentRecoveryPersonId,
  normalizePaymentRecoveryTid,
  parsePaymentRecoveryWorkbook,
  paymentRecoveryWorkbookSha256,
  splitPaymentRecoveryAmountEqually
} from "./payment-recovery-import.ts";

function recoveryRow(overrides = {}) {
  const row = {
    tid: "TID-000001",
    providerCode: "AMAZON",
    location: "KOZA",
    debitDate: "01/10/2026",
    debitAmount: 2000,
    recoveryMethod: "PAYOUT_DEDUCTION",
    recoveryIds: "DROPX1001",
    providerReference: "DEBIT-001",
    reason: "Shipment loss",
    remark: "",
    ...overrides
  };
  return [
    row.tid,
    row.providerCode,
    row.location,
    row.debitDate,
    row.debitAmount,
    row.recoveryMethod,
    row.recoveryIds,
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

test("parses payout deductions and provider disputes with a stable file hash", () => {
  const bytes = workbookBytes([
    recoveryRow({
      tid: " tid-000001 ",
      providerCode: " amazon ",
      location: " koza ",
      recoveryIds: " dropx1002 ; DROPX1001\nDROPX1003 ",
      debitAmount: "₹2,000.50"
    }),
    recoveryRow({
      tid: "TID-000002",
      debitDate: "02-10-2026",
      debitAmount: 1500,
      recoveryMethod: "POST_INVOICE_DISPUTE",
      recoveryIds: ""
    })
  ]);
  const parsed = parsePaymentRecoveryWorkbook(bytes);

  assert.equal(parsed.canCommit, true);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.rows[0].tid, "tid-000001");
  assert.equal(parsed.rows[0].normalizedTid, "TID-000001");
  assert.equal(parsed.rows[0].providerCode, "AMAZON");
  assert.equal(parsed.rows[0].locationCode, "KOZA");
  assert.equal(parsed.rows[0].debitDate, "2026-10-01");
  assert.equal(parsed.rows[0].debitAmount, 2000.5);
  assert.deepEqual(parsed.rows[0].recoveryIds, ["DROPX1002", "DROPX1001", "DROPX1003"]);
  assert.equal(parsed.rows[1].recoveryMethod, "POST_INVOICE_DISPUTE");
  assert.deepEqual(parsed.rows[1].recoveryIds, []);
  assert.equal(parsed.fileSha256, paymentRecoveryWorkbookSha256(bytes));
  assert.match(parsed.fileSha256, /^[a-f0-9]{64}$/);
  assert.equal(normalizePaymentRecoveryTid(" tid 1 "), "TID1");
  assert.equal(normalizePaymentRecoveryPersonId(" dropx 1001 "), "DROPX1001");
});

test("splits an amount equally without losing a paise", () => {
  assert.deepEqual(splitPaymentRecoveryAmountEqually(100, ["dropx3", "DROPX1", "dropx2"]), [
    { dropxId: "DROPX1", amount: 33.34 },
    { dropxId: "DROPX2", amount: 33.33 },
    { dropxId: "DROPX3", amount: 33.33 }
  ]);
  assert.throws(
    () => splitPaymentRecoveryAmountEqually(0.01, ["DROPX1", "DROPX2"]),
    /at least one paise/i
  );
});

test("honors the 1904 date epoch and accepts genuine Excel date cells", () => {
  const date1904Workbook = XLSX.utils.book_new();
  date1904Workbook.Workbook = { WBProps: { date1904: true } };
  const date1904Sheet = XLSX.utils.aoa_to_sheet([
    [...PAYMENT_RECOVERY_IMPORT_HEADERS],
    recoveryRow({ tid: "TID-1904", debitDate: 44840 })
  ]);
  date1904Sheet.D2.z = "dd/mm/yyyy";
  XLSX.utils.book_append_sheet(date1904Workbook, date1904Sheet, "Upload");
  const date1904Bytes = new Uint8Array(XLSX.write(date1904Workbook, { bookType: "xlsx", type: "buffer" }));
  assert.equal(parsePaymentRecoveryWorkbook(date1904Bytes).rows[0].debitDate, "2026-10-07");

  const excelDate = new Date(Date.UTC(2026, 9, 8));
  const typed = parsePaymentRecoveryWorkbook(workbookBytes([
    recoveryRow({ tid: "TID-DATE", debitDate: excelDate })
  ]));
  assert.deepEqual(typed.issues, []);
  assert.equal(typed.rows[0].debitDate, "2026-10-08");
});

test("enforces recovery-method target rules and non-zero equal allocations", () => {
  const parsed = parsePaymentRecoveryWorkbook(workbookBytes([
    recoveryRow({ tid: "TID-1", recoveryIds: "" }),
    recoveryRow({ tid: "TID-2", recoveryMethod: "POST_INVOICE_DISPUTE", recoveryIds: "DROPX1" }),
    recoveryRow({ tid: "TID-3", recoveryMethod: "UNKNOWN", recoveryIds: "DROPX1" }),
    recoveryRow({ tid: "TID-4", debitAmount: 0.01, recoveryIds: "DROPX1,DROPX2" }),
    recoveryRow({ tid: "TID-5", recoveryIds: "DROPX1; dropx1" })
  ]));
  const messages = parsed.issues.map((issue) => issue.message).join("\n");

  assert.equal(parsed.canCommit, false);
  assert.match(messages, /RECOVERY_IDS is required for PAYOUT_DEDUCTION/i);
  assert.match(messages, /must be blank for POST_INVOICE_DISPUTE/i);
  assert.match(messages, /must be PAYOUT_DEDUCTION or POST_INVOICE_DISPUTE/i);
  assert.match(messages, /at least one paise for every Recovery ID/i);
  assert.match(messages, /lists DROPX1 more than once/i);
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
  sheet.E4 = { t: "n", f: "1000+1000", v: 2000 };
  XLSX.utils.book_append_sheet(workbook, sheet, "Upload");
  const bytes = new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
  const parsed = parsePaymentRecoveryWorkbook(bytes);
  const messages = parsed.issues.map((issue) => issue.message).join("\n");

  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.canCommit, false);
  assert.match(messages, /TID was stored as an unsafe number or scientific notation/i);
  assert.match(messages, /Formula cells are not accepted/i);
});

test("validates dates, currency precision, required codes and duplicate TIDs", () => {
  const parsed = parsePaymentRecoveryWorkbook(workbookBytes([
    recoveryRow({ tid: "TID-DUP", providerCode: "", debitDate: "2026-10-01", debitAmount: 0 }),
    recoveryRow({ tid: " tid-dup ", location: "", debitDate: "1/10/2026", debitAmount: 12.345 })
  ]));
  const messages = parsed.issues.map((issue) => issue.message).join("\n");

  assert.equal(parsed.canCommit, false);
  assert.match(messages, /PROVIDER_CODE is required/i);
  assert.match(messages, /LOCATION is required/i);
  assert.match(messages, /DEBIT_DATE must be a real date/i);
  assert.match(messages, /DEBIT_AMOUNT must be greater than zero/i);
  assert.match(messages, /at most two decimal places/i);
  assert.match(messages, /TID duplicates row 2/i);
});

test("requires the exact header contract and reports obsolete columns", () => {
  assert.throws(() => parsePaymentRecoveryWorkbook(workbookBytes([
    recoveryRow()
  ], PAYMENT_RECOVERY_IMPORT_HEADERS.filter((header) => header !== "PROVIDER_REFERENCE"))), /PROVIDER_REFERENCE/i);

  const parsed = parsePaymentRecoveryWorkbook(workbookBytes([
    [...recoveryRow(), "old"]
  ], [...PAYMENT_RECOVERY_IMPORT_HEADERS, "OLD_STATUS"]));
  assert.match(parsed.issues.map((issue) => issue.message).join("\n"), /Unknown column “OLD_STATUS”/i);
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

test("builds the current four-sheet template and formats identifier inputs as text", () => {
  const bytes = buildPaymentRecoveryImportTemplate({ exampleDate: "2026-10-01" });
  const workbook = XLSX.read(bytes, { type: "array", cellStyles: true });
  assert.deepEqual(workbook.SheetNames, ["Upload", "Examples", "Valid values", "Instructions"]);

  const upload = XLSX.utils.sheet_to_json(workbook.Sheets.Upload, { header: 1, defval: "" });
  assert.deepEqual(upload[0], [...PAYMENT_RECOVERY_IMPORT_HEADERS]);
  assert.equal(workbook.Sheets.Upload.A2.z, "@");
  assert.equal(workbook.Sheets.Upload.G2.z, "@");

  const examples = XLSX.utils.sheet_to_json(workbook.Sheets.Examples, { header: 1, defval: "" });
  assert.match(examples[0][0], /EXAMPLES ONLY/i);
  assert.deepEqual(examples[1], [...PAYMENT_RECOVERY_IMPORT_HEADERS]);
  assert.equal(examples[2][3], "01/10/2026");
  assert.equal(examples[2][5], "PAYOUT_DEDUCTION");
  assert.equal(examples[3][5], "POST_INVOICE_DISPUTE");

  const values = XLSX.utils.sheet_to_json(workbook.Sheets["Valid values"], { header: 1, defval: "" });
  assert.deepEqual(values.slice(1).map((row) => row[0]), ["PAYOUT_DEDUCTION", "POST_INVOICE_DISPUTE"]);

  const instructions = XLSX.utils.sheet_to_json(workbook.Sheets.Instructions, { header: 1, defval: "" });
  const instructionText = instructions.flat().join("\n");
  assert.match(instructionText, /DD-MM-YYYY or DD\/MM\/YYYY/i);
  assert.match(instructionText, /split equally/i);
  assert.match(instructionText, /scientific notation and formulas are rejected/i);
  assert.match(instructionText, /does not silently deduct a payout/i);
});
