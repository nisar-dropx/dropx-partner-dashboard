import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import {
  WORKFORCE_FEDONE_HEADERS,
  WORKFORCE_FEDONE_RESPONSE_HEADERS,
  buildWorkforceFedOneRows,
  buildWorkforceFedOneWorkbook,
  formatWorkforceFedOneValueDate,
  isValidWorkforceBankAccount,
  isValidWorkforceBankIfsc,
  isValidWorkforceBankReference,
  normalizeWorkforceBankAccount,
  normalizeWorkforceBankIfsc,
  normalizeWorkforceBankReference,
  parseWorkforceFedOneResponse
} from "./workforce-payout-bank-file.ts";

function instruction(overrides = {}) {
  return {
    amountPaise: 1_234_567,
    beneficiaryAccountNumber: "001234567890",
    beneficiaryEmail: "worker@example.com",
    beneficiaryIfsc: "FDRL0000123",
    beneficiaryName: "A Worker",
    locationCode: "nlrf",
    referenceNo: "wpd111092026v1",
    ...overrides
  };
}

function responseWorkbook(rows, options = {}) {
  const workbook = XLSX.utils.book_new();
  const preamble = options.preamble ?? [];
  const headers = options.headers ?? [...WORKFORCE_FEDONE_RESPONSE_HEADERS];
  const sheet = XLSX.utils.aoa_to_sheet([...preamble, headers, ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Transaction Enquiry");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

test("builds the exact FedOne upload columns and fixed Workforce payment remarks", () => {
  const bytes = buildWorkforceFedOneWorkbook({
    debitAccountNumber: "100000000001",
    valueDate: "2026-10-09",
    instructions: [
      instruction(),
      instruction({
        amountPaise: 5_000,
        beneficiaryAccountNumber: "9876543210",
        beneficiaryEmail: null,
        beneficiaryIfsc: "hdfc0000123",
        beneficiaryName: "Another Worker",
        locationCode: "KOZA",
        referenceNo: "WPD222092026V2"
      })
    ]
  });
  const workbook = XLSX.read(bytes, { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["Sheet1"]);
  const sheet = workbook.Sheets.Sheet1;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  assert.deepEqual(rows[0], [...WORKFORCE_FEDONE_HEADERS]);
  assert.deepEqual(rows[1], [
    "IFT",
    "100000000001",
    12345.67,
    "09/10/2026",
    "001234567890",
    "A Worker",
    "FDRL0000123",
    "worker@example.com",
    "",
    "NLRF",
    "NET PAY",
    "WPD111092026V1"
  ]);
  assert.deepEqual(rows[2], [
    "NEFT",
    "100000000001",
    50,
    "09/10/2026",
    "9876543210",
    "Another Worker",
    "HDFC0000123",
    "",
    "",
    "KOZA",
    "NET PAY",
    "WPD222092026V2"
  ]);
  assert.equal(sheet.C2.t, "n", "bank amounts must be numeric cells");
  assert.equal(sheet.B2.t, "s", "bank account numbers must remain text cells");
  assert.equal(sheet.E2.t, "s", "beneficiary account numbers must remain text cells");
});

test("keeps separate location instructions for the same beneficiary as distinct bank lines", () => {
  const rows = buildWorkforceFedOneRows({
    debitAccountNumber: "100000000001",
    valueDate: "2026-10-10",
    instructions: [
      instruction({
        amountPaise: 47_401,
        beneficiaryName: "SIDDIQUE M",
        locationCode: "KBWE",
        referenceNo: "WPT1013092026V2"
      }),
      instruction({
        amountPaise: 7_112_556,
        beneficiaryName: "SIDDIQUE M",
        locationCode: "KLZA",
        referenceNo: "WPT1013092026V3"
      })
    ]
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => ({
    account: row["Beneficiary Account Number"],
    amount: row["Transaction Amount"],
    creditRemarks: row["Credit Remarks"],
    reference: row["Unique Customer Reference Number"]
  })), [
    { account: "001234567890", amount: 474.01, creditRemarks: "KBWE", reference: "WPT1013092026V2" },
    { account: "001234567890", amount: 71125.56, creditRemarks: "KLZA", reference: "WPT1013092026V3" }
  ]);
});

test("maps every instruction deterministically and validates financial inputs", () => {
  const [row] = buildWorkforceFedOneRows({
    debitAccountNumber: " 100 200 ",
    valueDate: "29/02/2028",
    instructions: [instruction({
      beneficiaryAccountNumber: " 0012 34567890 ",
      beneficiaryIfsc: " fdrl 0000123 ",
      referenceNo: " wp d111092026v1 "
    })]
  });
  assert.equal(row["Transaction Type"], "IFT");
  assert.equal(row["Debit Account Number"], "100200");
  assert.equal(row["Beneficiary Account Number"], "001234567890");
  assert.equal(row["IFSC Code"], "FDRL0000123");
  assert.equal(row["Unique Customer Reference Number"], "WPD111092026V1");
  assert.equal(row["Debit Remarks"], "NET PAY");
  assert.equal(formatWorkforceFedOneValueDate("2026-09-30"), "30/09/2026");
  assert.throws(() => formatWorkforceFedOneValueDate("2026-02-29"), /real date/i);
  assert.throws(() => buildWorkforceFedOneRows({ debitAccountNumber: "1000", valueDate: "2026-10-09", instructions: [] }), /at least one/i);
  assert.throws(() => buildWorkforceFedOneRows({
    debitAccountNumber: "1000",
    valueDate: "2026-10-09",
    instructions: [instruction({ amountPaise: 1.5 })]
  }), /integer number of paise/i);
  assert.throws(() => buildWorkforceFedOneRows({
    debitAccountNumber: "1000",
    valueDate: "2026-10-09",
    instructions: [instruction({ amountPaise: 0 })]
  }), /positive/i);
});

test("rejects malformed Federal Bank account, IFSC and Workforce reference identifiers", () => {
  assert.equal(isValidWorkforceBankAccount(" 0012\u00a03456 "), true);
  assert.equal(isValidWorkforceBankAccount("0012-3456"), false);
  assert.equal(isValidWorkforceBankIfsc(" fdrl\u200b 0000123 "), true);
  assert.equal(isValidWorkforceBankIfsc("FDRL1000123"), false, "the fifth IFSC character must be zero");
  assert.equal(isValidWorkforceBankReference(" wp d111092026v1 "), true);
  assert.equal(isValidWorkforceBankReference("WPD111132026V1"), false, "the embedded payment month must be real");

  assert.throws(() => buildWorkforceFedOneRows({
    debitAccountNumber: "0012-3456",
    valueDate: "2026-10-09",
    instructions: [instruction()]
  }), /Debit Account Number must contain 4 to 30 letters or digits/i);
  assert.throws(() => buildWorkforceFedOneRows({
    debitAccountNumber: "00123456",
    valueDate: "2026-10-09",
    instructions: [instruction({ beneficiaryAccountNumber: "123-456" })]
  }), /Beneficiary Account Number must contain 4 to 30 letters or digits/i);
  assert.throws(() => buildWorkforceFedOneRows({
    debitAccountNumber: "00123456",
    valueDate: "2026-10-09",
    instructions: [instruction({ beneficiaryIfsc: "FDRL1000123" })]
  }), /IFSC Code must use the standard 11-character format/i);
  assert.throws(() => buildWorkforceFedOneRows({
    debitAccountNumber: "00123456",
    valueDate: "2026-10-09",
    instructions: [instruction({ referenceNo: "WPD111132026V1" })]
  }), /Unique Customer Reference Number is invalid/i);
});

test("parses a Transaction Enquiry workbook with normalized identifiers and exact paise", () => {
  const bytes = responseWorkbook([
    [" wp d111092026v1 ", " 0012 3456 7890 ", " fdrl 0000123 ", "₹1,234.50", " paid ", " UTR 123 ", "Success"],
    ["WPD222092026V1", "9988776655", "HDFC0000456", 50, "Cancelled", "", "Returned by bank"]
  ], { preamble: [["Federal Bank Transaction Enquiry"], []] });
  const rows = parseWorkforceFedOneResponse(bytes);

  assert.deepEqual(rows, [
    {
      rowNumber: 4,
      referenceNo: "WPD111092026V1",
      creditAccount: "001234567890",
      ifsc: "FDRL0000123",
      debitAmountPaise: 123450,
      status: "PAID",
      utrCin: "UTR 123",
      remarks: "Success"
    },
    {
      rowNumber: 5,
      referenceNo: "WPD222092026V1",
      creditAccount: "9988776655",
      ifsc: "HDFC0000456",
      debitAmountPaise: 5000,
      status: "CANCELLED",
      utrCin: "",
      remarks: "Returned by bank"
    }
  ]);
  assert.equal(normalizeWorkforceBankReference(" wp 1 "), "WP1");
  assert.equal(normalizeWorkforceBankAccount(" 001 002 "), "001002");
  assert.equal(normalizeWorkforceBankIfsc(" fdrl 1 "), "FDRL1");
});

test("detects duplicate normalized customer references before finalization", () => {
  const bytes = responseWorkbook([
    ["WPD111092026V1", "001234", "FDRL0001", 100, "PAID", "UTR1", ""],
    [" wp d111092026v1 ", "001234", "FDRL0001", 100, "PAID", "UTR2", ""]
  ]);
  assert.throws(
    () => parseWorkforceFedOneResponse(bytes),
    /Rows 2 and 3: duplicate Customer Ref\. No\. “WPD111092026V1”/i
  );
});

test("returns clear errors for missing headers, invalid amounts and formulas", () => {
  assert.throws(
    () => parseWorkforceFedOneResponse(responseWorkbook([], { headers: ["Customer Ref. No.", "Debit Amount"] })),
    /headers were not found.*Credit Account.*System Processing Remarks/i
  );

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [...WORKFORCE_FEDONE_RESPONSE_HEADERS],
    ["WPD111092026V1", "001234", "FDRL0001", "1,000.001", "", "", ""]
  ]);
  sheet.D2 = { t: "n", f: "500+500", v: 1000 };
  XLSX.utils.book_append_sheet(workbook, sheet, "Transaction Enquiry");
  const bytes = new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

  assert.throws(() => parseWorkforceFedOneResponse(bytes), (error) => {
    assert.match(error.message, /Row 2: formulas are not accepted in Debit Amount/i);
    assert.match(error.message, /Row 2: Status is required/i);
    return true;
  });
});

test("rejects malformed identifiers in a bank response before finalization", () => {
  const bytes = responseWorkbook([
    ["WPD111132026V1", "0012-3456", "FDRL1000123", 100, "PAID", "UTR1", ""]
  ]);
  assert.throws(() => parseWorkforceFedOneResponse(bytes), (error) => {
    assert.match(error.message, /Customer Ref\. No\. is not a valid Workforce payment reference/i);
    assert.match(error.message, /Credit Account must contain 4 to 30 letters or digits/i);
    assert.match(error.message, /IFSC Code must use the standard 11-character format/i);
    return true;
  });
});

test("rejects an empty response and duplicate required response headers", () => {
  assert.throws(() => parseWorkforceFedOneResponse(responseWorkbook([])), /No payment response rows/i);
  const duplicateHeaders = [...WORKFORCE_FEDONE_RESPONSE_HEADERS, "Customer Ref. No."];
  assert.throws(
    () => parseWorkforceFedOneResponse(responseWorkbook([
      ["WP1", "1", "FDRL1", 1, "PAID", "U", "", "WP1"]
    ], { headers: duplicateHeaders })),
    /duplicate required column.*Customer Ref\. No\./i
  );
});
