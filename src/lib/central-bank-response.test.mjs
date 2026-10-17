import assert from "node:assert/strict";
import test from "node:test";

import * as XLSX from "xlsx";

import {
  WORKFORCE_FEDONE_RESPONSE_HEADERS,
  parsePreparedFedOneResponseRows,
  prepareDropxFedOneResponse
} from "./workforce-payout-bank-file.ts";
import {
  centralBankRpcRow,
  resolveCentralBankRowOwner
} from "./central-bank-response.ts";

function responseWorkbook(rows, options = {}) {
  const workbook = XLSX.utils.book_new();
  const headers = options.headers ?? [...WORKFORCE_FEDONE_RESPONSE_HEADERS];
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  for (const [address, cell] of Object.entries(options.cells ?? {})) sheet[address] = cell;
  XLSX.utils.book_append_sheet(workbook, sheet, "Transaction Enquiry");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

test("central parser accepts company-owned references from every payment ledger and skips unrelated rows", () => {
  const prepared = prepareDropxFedOneResponse(responseWorkbook([
    ["REQAB12C34", "001234", "FDRL0000001", 100.25, "PAID", "UTR-GENERIC", "Success"],
    ["DH1011202609", "009876", "HDFC0000002", 90, "CANCELLED", "", "Rejected"],
    ["WFDF1141102026V1", "001111", "UTIB0000003", 75.5, "PAID", "UTR-WF", "Success"],
    ["UNRELATED-ROW", "", "", "not-an-amount", "", "", ""]
  ]));

  assert.deepEqual(prepared.allReferenceCandidates, [
    { referenceNo: "REQAB12C34", rowNumber: 2 },
    { referenceNo: "DH1011202609", rowNumber: 3 },
    { referenceNo: "WFDF1141102026V1", rowNumber: 4 },
    { referenceNo: "UNRELATED-ROW", rowNumber: 5 }
  ]);

  const parsed = parsePreparedFedOneResponseRows(
    prepared,
    new Set(["reqab12c34", "dh1011202609", "wfdf1141102026v1"])
  );
  assert.deepEqual(parsed.rows.map((row) => ({
    amount: row.debitAmountPaise,
    reference: row.referenceNo,
    status: row.status,
    utr: row.utrCin
  })), [
    { amount: 10_025, reference: "REQAB12C34", status: "PAID", utr: "UTR-GENERIC" },
    { amount: 9_000, reference: "DH1011202609", status: "CANCELLED", utr: "" },
    { amount: 7_550, reference: "WFDF1141102026V1", status: "PAID", utr: "UTR-WF" }
  ]);
  assert.deepEqual(parsed.skippedRows, [{ rowNumber: 5, referenceNo: "UNRELATED-ROW" }]);
});

test("central parser keeps formula, required-field, amount and unsafe-number safeguards", () => {
  const prepared = prepareDropxFedOneResponse(responseWorkbook([
    ["REQSAFE01", 99_999_999_999_999_990, "", "1,000.001", "", "", ""]
  ], {
    cells: {
      D2: { t: "n", f: "500+500", v: 1000 }
    }
  }));

  assert.throws(
    () => parsePreparedFedOneResponseRows(prepared, new Set(["REQSAFE01"])),
    (error) => {
      assert.match(error.message, /Row 2: formulas are not accepted in Debit Amount/i);
      assert.match(error.message, /Row 2: Credit Account was stored as an unsafe Excel number/i);
      assert.match(error.message, /Row 2: IFSC Code is required/i);
      assert.match(error.message, /Row 2: Status is required/i);
      return true;
    }
  );
});

test("central parser rejects duplicate normalized references and unsupported reference characters", () => {
  const duplicate = prepareDropxFedOneResponse(responseWorkbook([
    ["REQAB12", "001234", "FDRL0000001", 100, "PAID", "UTR-1", ""],
    [" req ab12 ", "001234", "FDRL0000001", 100, "PAID", "UTR-2", ""]
  ]));
  assert.throws(
    () => parsePreparedFedOneResponseRows(duplicate, new Set(["REQAB12"])),
    /Rows 2 and 3: duplicate Customer Ref\. No\. “REQAB12”/i
  );

  const unsupported = prepareDropxFedOneResponse(responseWorkbook([
    ["REQ/AB12", "001234", "FDRL0000001", 100, "PAID", "UTR-1", ""]
  ]));
  assert.throws(
    () => parsePreparedFedOneResponseRows(unsupported, new Set(["REQ/AB12"])),
    /Customer Ref\. No\. contains unsupported characters or has an invalid length/i
  );
});

test("cross-ledger reference collisions fail closed instead of choosing an owner", () => {
  assert.throws(
    () => resolveCentralBankRowOwner({
      matches: { payment_requests: true, payroll: true },
      referenceNo: " req ab12 ",
      rowNumber: 7
    }),
    (error) => {
      assert.match(error.message, /Row 7/);
      assert.match(error.message, /REQAB12/);
      assert.match(error.message, /matches multiple payment ledgers/i);
      assert.match(error.message, /Nothing from this file was finalized/i);
      return true;
    }
  );
  assert.equal(resolveCentralBankRowOwner({
    matches: { workforce: true },
    referenceNo: "WFDF1141102026V1",
    rowNumber: 2
  }), "workforce");
  assert.equal(resolveCentralBankRowOwner({
    matches: {},
    referenceNo: "BANKOTHER",
    rowNumber: 3
  }), null);
});

test("central RPC rows preserve bank evidence and normalize canceled spelling", () => {
  assert.deepEqual(centralBankRpcRow({
    rowNumber: 9,
    referenceNo: "REQAB12",
    debitAccount: "000011112222",
    creditAccount: "00009999",
    ifsc: "FDRL0000001",
    valueDate: "2026-10-17",
    debitAmountPaise: 12_345,
    status: "CANCELED",
    utrCin: "",
    remarks: "Insufficient funds"
  }), {
    row_number: 9,
    reference_no: "REQAB12",
    debit_account: "000011112222",
    credit_account: "00009999",
    ifsc: "FDRL0000001",
    value_date: "2026-10-17",
    debit_amount_paise: 12_345,
    status: "CANCELLED",
    utr_cin: "",
    remarks: "Insufficient funds"
  });
});
