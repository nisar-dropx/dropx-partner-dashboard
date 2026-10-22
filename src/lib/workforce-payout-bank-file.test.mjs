import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import {
  WORKFORCE_FEDONE_HEADERS,
  WORKFORCE_FEDONE_RESPONSE_HEADERS,
  buildWorkforceFedOneRows,
  buildWorkforceFedOneWorkbook,
  countFedOneResponseDataRows,
  extractDropxFedOneReferenceCandidates,
  formatWorkforceFedOneValueDate,
  isValidWorkforceBankAccount,
  isValidWorkforceBankIfsc,
  isValidWorkforceBankReference,
  normalizeWorkforceBankAccount,
  normalizeWorkforceBankIfsc,
  normalizeWorkforceBankReference,
  parseDropxFedOneResponse,
  parsePreparedDropxFedOneResponse,
  prepareDropxFedOneResponse,
  parseWorkforceFedOneResponse
} from "./workforce-payout-bank-file.ts";

function instruction(overrides = {}) {
  return {
    amountPaise: 1_234_567,
    beneficiaryAccountNumber: "001234567890",
    beneficiaryEmail: "worker@example.com",
    beneficiaryIfsc: "FDRL0000123",
    beneficiaryName: "A Worker",
    creditRemarks: "d111",
    referenceNo: "wfd111092026v1",
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
        creditRemarks: "D222",
        referenceNo: "WFD222092026V2"
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
    "D111",
    "NET PAY",
    "WFD111092026V1"
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
    "D222",
    "NET PAY",
    "WFD222092026V2"
  ]);
  assert.equal(sheet.C2.t, "n", "bank amounts must be numeric cells");
  assert.equal(sheet.B2.t, "s", "bank account numbers must remain text cells");
  assert.equal(sheet.E2.t, "s", "beneficiary account numbers must remain text cells");
});

test("keeps separate location instructions for the same DropX ID as distinct bank lines", () => {
  const rows = buildWorkforceFedOneRows({
    debitAccountNumber: "100000000001",
    valueDate: "2026-10-10",
    instructions: [
      instruction({
        amountPaise: 47_401,
        beneficiaryName: "SIDDIQUE M",
        creditRemarks: "T1013",
        referenceNo: "WFT1013092026V2"
      }),
      instruction({
        amountPaise: 7_112_556,
        beneficiaryName: "SIDDIQUE M",
        creditRemarks: "T1013",
        referenceNo: "WFT1013092026V3"
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
    { account: "001234567890", amount: 474.01, creditRemarks: "T1013", reference: "WFT1013092026V2" },
    { account: "001234567890", amount: 71125.56, creditRemarks: "T1013", reference: "WFT1013092026V3" }
  ]);
});

test("requires Credit Remarks for every bank instruction", () => {
  assert.throws(
    () => buildWorkforceFedOneRows({
      debitAccountNumber: "100000000001",
      valueDate: "2026-10-10",
      instructions: [instruction({ creditRemarks: "" })]
    }),
    /Credit Remarks is required/i
  );
});

test("preserves historical WP references when a Workforce bank file is re-downloaded", () => {
  const [legacyRow] = buildWorkforceFedOneRows({
    debitAccountNumber: "100000000001",
    referencePrefix: "WF",
    valueDate: "2026-10-10",
    instructions: [instruction({ referenceNo: "WPD111092026V1" })]
  });

  assert.equal(legacyRow["Unique Customer Reference Number"], "WPD111092026V1");
  assert.equal(isValidWorkforceBankReference("WPD111092026V1", "WF"), true);
  assert.equal(isValidWorkforceBankReference("WFD2222092026V1", "WF"), true);
});

test("reuses the FedOne format for Helper references without weakening the Workforce default", () => {
  const [helperRow] = buildWorkforceFedOneRows({
    debitAccountNumber: "100000000001",
    referencePrefix: "HP",
    valueDate: "2026-10-10",
    instructions: [instruction({ creditRemarks: "D0826", referenceNo: "HPD0826092026V1" })]
  });
  assert.equal(helperRow["Credit Remarks"], "D0826");
  assert.equal(helperRow["Unique Customer Reference Number"], "HPD0826092026V1");
  assert.equal(isValidWorkforceBankReference("HPD0826092026V1", "HP"), true);
  assert.equal(isValidWorkforceBankReference("HPD0826092026V1"), false);

  const response = responseWorkbook([
    ["HPD0826092026V1", "001234567890", "FDRL0000123", 12345.67, "PAID", "HELPERUTR1", "Success"]
  ]);
  assert.equal(parseWorkforceFedOneResponse(response, { referencePrefix: "HP" })[0].referenceNo, "HPD0826092026V1");
  assert.throws(
    () => parseWorkforceFedOneResponse(response),
    /not a valid Workforce payment reference/i
  );
});

test("parses mixed Workforce and Helper responses while skipping unrelated bank references", () => {
  const response = responseWorkbook([
    ["WFF999092026V9", "bad", "bad", "not-an-amount", "", "", ""],
    ["BANK-OTHER-001", "", "", "not-an-amount", "", "", ""],
    ["WFD2222092026V1", "001234567890", "FDRL0000123", 100, "PAID", "WORKUTR1", "Success"],
    ["WPD111092026V1", "001234567891", "FDRL0000123", 75, "PAID", "LEGACYUTR1", "Success"],
    ["HPD1001102026V1", "9988776655", "HDFC0000456", 50, "CANCELLED", "", "Returned"]
  ]);

  assert.deepEqual(extractDropxFedOneReferenceCandidates(response), [
    "WFF999092026V9",
    "WFD2222092026V1",
    "WPD111092026V1",
    "HPD1001102026V1"
  ]);
  assert.deepEqual(parseDropxFedOneResponse(response, new Set([
    "WFD2222092026V1",
    "WPD111092026V1",
    "HPD1001102026V1"
  ])), {
    workforceRows: [{
      rowNumber: 4,
      referenceNo: "WFD2222092026V1",
      creditAccount: "001234567890",
      ifsc: "FDRL0000123",
      debitAmountPaise: 10000,
      status: "PAID",
      utrCin: "WORKUTR1",
      remarks: "Success"
    }, {
      rowNumber: 5,
      referenceNo: "WPD111092026V1",
      creditAccount: "001234567891",
      ifsc: "FDRL0000123",
      debitAmountPaise: 7500,
      status: "PAID",
      utrCin: "LEGACYUTR1",
      remarks: "Success"
    }],
    helperRows: [{
      rowNumber: 6,
      referenceNo: "HPD1001102026V1",
      creditAccount: "9988776655",
      ifsc: "HDFC0000456",
      debitAmountPaise: 5000,
      status: "CANCELLED",
      utrCin: "",
      remarks: "Returned"
    }],
    skippedRows: [
      { rowNumber: 2, referenceNo: "WFF999092026V9" },
      { rowNumber: 3, referenceNo: "BANK-OTHER-001" }
    ]
  });
});

test("counts legacy response rows without treating raw payment references as DropX payout candidates", () => {
  const response = responseWorkbook([
    ["G290219", "10030100584148", "FDRL0001003", 15840, "PAID", "S65099609", ""],
    ["D0826", "99887766", "FDRL0000123", 3600, "PAID", "S65099610", ""]
  ]);

  assert.equal(countFedOneResponseDataRows(response), 2);
  assert.deepEqual(extractDropxFedOneReferenceCandidates(response), []);
  assert.deepEqual(
    prepareDropxFedOneResponse(response).legacyReferenceCandidates.map((row) => ({
      amount: row.debitAmountPaise,
      dropxId: row.dropxId,
      rowNumber: row.rowNumber,
      status: row.status,
      utrCin: row.utrCin
    })),
    [
      { amount: 1_584_000, dropxId: "G290219", rowNumber: 2, status: "PAID", utrCin: "S65099609" },
      { amount: 360_000, dropxId: "D0826", rowNumber: 3, status: "PAID", utrCin: "S65099610" }
    ]
  );
});

test("does not count bank-export footer cells outside the response columns as payment rows", () => {
  const response = responseWorkbook([
    ["WFD2222092026V1", "001234567890", "FDRL0000123", 100, "PAID", "WORKUTR1", "Success"],
    ["", "", "", "", "", "", "", "Generated by Federal Bank"]
  ]);

  assert.equal(countFedOneResponseDataRows(response), 1);
  assert.deepEqual(extractDropxFedOneReferenceCandidates(response), ["WFD2222092026V1"]);
});

test("rewrites resolved bare DropX IDs by row before the existing mixed parser", () => {
  const response = responseWorkbook([
    ["DF1141", "001234", "FDRL0001", 100, "PAID", "UTR-WF", "Success"],
    ["D0826", "009999", "FDRL0002", 50, "PAID", "UTR-HP", "Success"],
    ["BANK-OTHER-001", "007777", "FDRL0003", 25, "PAID", "UTR-OTHER", "Success"]
  ]);
  const prepared = prepareDropxFedOneResponse(response);
  assert.deepEqual(
    prepared.legacyReferenceCandidates.map((candidate) => [candidate.rowNumber, candidate.dropxId]),
    [[2, "DF1141"], [3, "D0826"], [4, "BANKOTHER001"]]
  );

  assert.deepEqual(parsePreparedDropxFedOneResponse(
    prepared,
    new Set(["WFDF1141102026V1", "HPD0826102026V1"]),
    new Map([[2, "WFDF1141102026V1"], [3, "HPD0826102026V1"]])
  ), {
    workforceRows: [{
      rowNumber: 2,
      referenceNo: "WFDF1141102026V1",
      creditAccount: "001234",
      ifsc: "FDRL0001",
      debitAmountPaise: 10000,
      status: "PAID",
      utrCin: "UTR-WF",
      remarks: "Success"
    }],
    helperRows: [{
      rowNumber: 3,
      referenceNo: "HPD0826102026V1",
      creditAccount: "009999",
      ifsc: "FDRL0002",
      debitAmountPaise: 5000,
      status: "PAID",
      utrCin: "UTR-HP",
      remarks: "Success"
    }],
    skippedRows: [{ rowNumber: 4, referenceNo: "BANK-OTHER-001" }]
  });
});

test("row aliases keep two bare-ID rows separate instead of guessing one profile-wide reference", () => {
  const prepared = prepareDropxFedOneResponse(responseWorkbook([
    ["T1013", "001111", "FDRL0001", 474.01, "PAID", "UTR-1", "Success"],
    ["T1013", "001111", "FDRL0001", 71125.56, "PAID", "UTR-2", "Success"]
  ]));
  const parsed = parsePreparedDropxFedOneResponse(
    prepared,
    new Set(["WFT1013092026V2", "WFT1013092026V3"]),
    new Map([[2, "WFT1013092026V2"], [3, "WFT1013092026V3"]])
  );
  assert.deepEqual(
    parsed.workforceRows.map((row) => [row.rowNumber, row.referenceNo, row.debitAmountPaise]),
    [[2, "WFT1013092026V2", 47_401], [3, "WFT1013092026V3", 7_112_556]]
  );
});

test("mixed response parsing accepts stored beneficiary identifiers and validates only company-owned payment fields", () => {
  const malformed = responseWorkbook([
    ["WPF999092026V9", "bad", "bad", "bad", "", "", ""],
    ["HPD1001102026V1", "0012-3456", "FDRL1000123", "1.001", "", "", ""]
  ]);
  assert.throws(() => parseDropxFedOneResponse(malformed, new Set(["HPD1001102026V1"])), (error) => {
    assert.doesNotMatch(error.message, /Credit Account must contain/i);
    assert.doesNotMatch(error.message, /IFSC Code must use/i);
    assert.match(error.message, /Row 3: Debit Amount must .*at most two decimal places/i);
    assert.match(error.message, /Row 3: Status is required/i);
    assert.doesNotMatch(error.message, /Row 2:/i);
    return true;
  });

  assert.throws(
    () => parseDropxFedOneResponse(responseWorkbook([
      ["WPF999092026V9", "bad", "bad", "bad", "", "", ""]
    ]), new Set()),
    /No matching Workforce or Helper payment references/i
  );
});

test("mixed response parsing rejects duplicate DropX references after normalization", () => {
  const response = responseWorkbook([
    ["BANK-OTHER-001", "", "", "", "", "", ""],
    ["HPD1001102026V1", "9988776655", "HDFC0000456", 50, "PAID", "HELPERUTR1", ""],
    [" hp d1001102026v1 ", "9988776655", "HDFC0000456", 50, "PAID", "HELPERUTR1", ""]
  ]);
  assert.throws(
    () => parseDropxFedOneResponse(response, new Set(["HPD1001102026V1"])),
    /Rows 3 and 4: duplicate Customer Ref\. No\. “HPD1001102026V1”/i
  );
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

test("keeps strict debit-bank helpers but passes through nonempty beneficiary identifiers", () => {
  assert.equal(isValidWorkforceBankAccount(" 0012\u00a03456 "), true);
  assert.equal(isValidWorkforceBankAccount("0012-3456"), false);
  assert.equal(isValidWorkforceBankIfsc(" fdrl\u200b 0000123 "), true);
  assert.equal(isValidWorkforceBankIfsc("FDRL1000123"), false, "the fifth IFSC character must be zero");
  assert.equal(isValidWorkforceBankReference(" wf d2222092026v1 "), true);
  assert.equal(isValidWorkforceBankReference(" wp d111092026v1 "), true);
  assert.equal(isValidWorkforceBankReference("WFD111132026V1"), false, "the embedded payment month must be real");

  assert.throws(() => buildWorkforceFedOneRows({
    debitAccountNumber: "0012-3456",
    valueDate: "2026-10-09",
    instructions: [instruction()]
  }), /Debit Account Number must contain 4 to 30 letters or digits/i);
  const [nonstandardBeneficiary] = buildWorkforceFedOneRows({
    debitAccountNumber: "00123456",
    valueDate: "2026-10-09",
    instructions: [instruction({
      beneficiaryAccountNumber: "123-456",
      beneficiaryIfsc: "KLGBO040661"
    })]
  });
  assert.equal(nonstandardBeneficiary["Beneficiary Account Number"], "123-456");
  assert.equal(nonstandardBeneficiary["IFSC Code"], "KLGBO040661");
  assert.throws(() => buildWorkforceFedOneRows({
    debitAccountNumber: "00123456",
    valueDate: "2026-10-09",
    instructions: [instruction({ beneficiaryAccountNumber: " " })]
  }), /Beneficiary Account Number is required/i);
  assert.throws(() => buildWorkforceFedOneRows({
    debitAccountNumber: "00123456",
    valueDate: "2026-10-09",
    instructions: [instruction({ beneficiaryIfsc: " " })]
  }), /IFSC Code is required/i);
  assert.throws(() => buildWorkforceFedOneRows({
    debitAccountNumber: "00123456",
    valueDate: "2026-10-09",
    instructions: [instruction({ referenceNo: "WFD111132026V1" })]
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

test("preserves Federal Transaction Enquiry settlement fields for payment history", () => {
  const workbook = XLSX.utils.book_new();
  const headers = [
    "Select All",
    "Payment Ref. No.",
    "Customer Ref. No.",
    "Debit Account",
    "Value Date",
    "Payee",
    "Credit Account",
    "IFSC Code",
    "Transfer Type",
    "Debit Amount",
    "Status",
    "UTR/CIN",
    "System Processing Remarks",
    "Payment Advice",
    "Actions"
  ];
  const sheet = XLSX.utils.aoa_to_sheet([
    ["PaymentInstrGrid"],
    headers,
    [
      "",
      "I121026128908163",
      "WFDF1141102026V1",
      "\u200c13650200019427",
      "12/10/2026",
      "DAKUMALA VIJAYA RAJU",
      "\u200c918010081240680",
      "UTIB0003826",
      "NEFT",
      9867,
      "Paid",
      "FBPT262858291677",
      "Processed successfully",
      "",
      "RaiseGrievance"
    ]
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  const bytes = new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

  assert.deepEqual(parseWorkforceFedOneResponse(bytes), [{
    rowNumber: 3,
    referenceNo: "WFDF1141102026V1",
    debitAccount: "13650200019427",
    creditAccount: "918010081240680",
    ifsc: "UTIB0003826",
    valueDate: "2026-10-12",
    debitAmountPaise: 986700,
    status: "PAID",
    utrCin: "FBPT262858291677",
    remarks: "Processed successfully"
  }]);
});

test("validates settlement date and rejects formulas in preserved response fields", () => {
  const headers = [
    ...WORKFORCE_FEDONE_RESPONSE_HEADERS,
    "Debit Account",
    "Value Date"
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    ["WFD111102026V1", "001234", "FDRL0001", 100, "PAID", "UTR1", "", "13650200019427", "31/11/2026"]
  ]);
  sheet.H2 = { t: "s", f: '"13650200019427"', v: "13650200019427" };
  XLSX.utils.book_append_sheet(workbook, sheet, "Transaction Enquiry");
  const bytes = new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

  assert.throws(() => parseWorkforceFedOneResponse(bytes), (error) => {
    assert.match(error.message, /Row 2: formulas are not accepted in Debit Account/i);
    assert.match(error.message, /Row 2: Value Date must be a real Excel date/i);
    return true;
  });
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

test("accepts nonstandard beneficiary identifiers in a bank response but still validates the payment reference", () => {
  const bytes = responseWorkbook([
    ["WPD111132026V1", "0012-3456", "FDRL1000123", 100, "PAID", "UTR1", ""]
  ]);
  assert.throws(() => parseWorkforceFedOneResponse(bytes), (error) => {
    assert.match(error.message, /Customer Ref\. No\. is not a valid Workforce payment reference/i);
    assert.doesNotMatch(error.message, /Credit Account must contain/i);
    assert.doesNotMatch(error.message, /IFSC Code must use/i);
    return true;
  });
});

test("round-trips nonstandard nonempty beneficiary identifiers in a bank response", () => {
  const [row] = parseWorkforceFedOneResponse(responseWorkbook([
    ["WPD111092026V1", "123-456", "KLGBO040661", 100, "PAID", "UTR1", ""]
  ]));

  assert.equal(row.creditAccount, "123-456");
  assert.equal(row.ifsc, "KLGBO040661");
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
