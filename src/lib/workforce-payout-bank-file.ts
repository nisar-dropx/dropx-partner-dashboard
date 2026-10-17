import * as XLSX from "xlsx";

export const WORKFORCE_FEDONE_HEADERS = [
  "Transaction Type",
  "Debit Account Number",
  "Transaction Amount",
  "Value Date",
  "Beneficiary Account Number",
  "Beneficiary Name",
  "IFSC Code",
  "Beneficiary Email ID",
  "Beneficiary ID",
  "Credit Remarks",
  "Debit Remarks",
  "Unique Customer Reference Number"
] as const;

export const WORKFORCE_FEDONE_RESPONSE_HEADERS = [
  "Customer Ref. No.",
  "Credit Account",
  "IFSC Code",
  "Debit Amount",
  "Status",
  "UTR/CIN",
  "System Processing Remarks"
] as const;

// Federal Bank includes these settlement fields in the Transaction Enquiry
// export, but older response exports did not always include them. Preserve
// them whenever they are present without making legacy response files fail.
const WORKFORCE_FEDONE_RESPONSE_SETTLEMENT_HEADERS = [
  "Debit Account",
  "Value Date"
] as const;

export type WorkforceFedOnePaymentInstruction = {
  amountPaise: number;
  beneficiaryAccountNumber: string;
  beneficiaryEmail?: string | null;
  beneficiaryIfsc: string;
  beneficiaryName: string;
  creditRemarks: string;
  referenceNo: string;
};

export type WorkforceFedOneWorkbookOptions = {
  debitAccountNumber: string;
  instructions: readonly WorkforceFedOnePaymentInstruction[];
  referencePrefix?: "WF" | "WP" | "HP";
  valueDate: string;
};

export type WorkforceFedOneResponseOptions = {
  referencePrefix?: "WF" | "WP" | "HP";
};

export type DropxFedOneResponse = {
  helperRows: WorkforceFedOneResponseRow[];
  skippedRows: Array<{ rowNumber: number; referenceNo: string }>;
  workforceRows: WorkforceFedOneResponseRow[];
};

export type PreparedFedOneReferenceCandidate = {
  referenceNo: string;
  rowNumber: number;
};

export type LegacyDropxFedOneReferenceCandidate = {
  amountError?: string;
  creditAccount: string;
  debitAmountPaise: number | null;
  dropxId: string;
  ifsc: string;
  rowNumber: number;
  status: string;
  utrCin: string;
};

export type WorkforceFedOneRow = {
  "Transaction Type": "IFT" | "NEFT";
  "Debit Account Number": string;
  "Transaction Amount": number;
  "Value Date": string;
  "Beneficiary Account Number": string;
  "Beneficiary Name": string;
  "IFSC Code": string;
  "Beneficiary Email ID": string;
  "Beneficiary ID": "";
  "Credit Remarks": string;
  "Debit Remarks": "NET PAY";
  "Unique Customer Reference Number": string;
};

export type WorkforceFedOneResponseRow = {
  rowNumber: number;
  referenceNo: string;
  debitAccount?: string;
  creditAccount: string;
  ifsc: string;
  valueDate?: string;
  debitAmountPaise: number;
  status: string;
  utrCin: string;
  remarks: string;
};

export type WorkforceFedOneResponseRowError = {
  message: string;
  referenceNo: string;
  rowNumber: number;
};

type SheetCell = XLSX.CellObject & { f?: string };
type FedOneResponseSheet = {
  columnFor: (header: typeof WORKFORCE_FEDONE_RESPONSE_HEADERS[number]) => number;
  optionalColumnFor: (header: typeof WORKFORCE_FEDONE_RESPONSE_SETTLEMENT_HEADERS[number]) => number | undefined;
  date1904: boolean;
  headerIndex: number;
  rows: unknown[][];
  sheet: XLSX.WorkSheet;
};

function cleanCell(value: unknown) {
  return String(value ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function requiredText(value: unknown, label: string) {
  const cleaned = cleanCell(value);
  if (!cleaned) throw new Error(`${label} is required.`);
  return cleaned;
}

function normalizeWithoutWhitespace(value: unknown) {
  return cleanCell(value).replace(/\s+/g, "").toUpperCase();
}

export function normalizeWorkforceBankReference(value: unknown) {
  return normalizeWithoutWhitespace(value);
}

export function normalizeWorkforceBankAccount(value: unknown) {
  return normalizeWithoutWhitespace(value);
}

export function normalizeWorkforceBankIfsc(value: unknown) {
  return normalizeWithoutWhitespace(value);
}

export function normalizeDropxBankIdentity(value: unknown) {
  return cleanCell(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidWorkforceBankAccount(value: unknown) {
  return /^[A-Z0-9]{4,30}$/.test(normalizeWorkforceBankAccount(value));
}

export function isValidWorkforceBankIfsc(value: unknown) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(normalizeWorkforceBankIfsc(value));
}

export function isValidWorkforceBankReference(value: unknown, referencePrefix: "WF" | "WP" | "HP" = "WF") {
  const reference = normalizeWorkforceBankReference(value);
  const pattern = referencePrefix === "HP"
    ? /^HP[A-Z0-9]+(?:0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$/
    : /^(?:WF|WP)[A-Z0-9]+(?:0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$/;
  return reference.length <= 64 && pattern.test(reference);
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDateParts(day: number, month: number, year: number) {
  return Number.isInteger(day) && Number.isInteger(month) && Number.isInteger(year) &&
    year >= 1900 && year <= 9999 && month >= 1 && month <= 12 &&
    day >= 1 && day <= daysInMonth(year, month);
}

export function formatWorkforceFedOneValueDate(value: string) {
  const raw = cleanCell(value);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, yearText, monthText, dayText] = iso;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (validDateParts(day, month, year)) return `${dayText}/${monthText}/${yearText}`;
  }

  const display = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (display) {
    const [, dayText, monthText, yearText] = display;
    const day = Number(dayText);
    const month = Number(monthText);
    const year = Number(yearText);
    if (validDateParts(day, month, year)) return `${dayText}/${monthText}/${yearText}`;
  }

  throw new Error("Value Date must be a real date written as YYYY-MM-DD or DD/MM/YYYY.");
}

function transactionAmount(amountPaise: number) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new Error("Transaction Amount must be a positive integer number of paise.");
  }
  return amountPaise / 100;
}

export function buildWorkforceFedOneRows(options: WorkforceFedOneWorkbookOptions): WorkforceFedOneRow[] {
  if (!options.instructions.length) throw new Error("Select at least one Workforce payment for the bank file.");
  const debitAccountNumber = normalizeWorkforceBankAccount(options.debitAccountNumber);
  if (!isValidWorkforceBankAccount(debitAccountNumber)) {
    throw new Error("Debit Account Number must contain 4 to 30 letters or digits.");
  }
  const valueDate = formatWorkforceFedOneValueDate(options.valueDate);

  return options.instructions.map((instruction, index) => {
    const instructionLabel = `Payment instruction ${index + 1}`;
    const beneficiaryAccountNumber = normalizeWorkforceBankAccount(instruction.beneficiaryAccountNumber);
    const beneficiaryIfsc = normalizeWorkforceBankIfsc(instruction.beneficiaryIfsc);
    const referenceNo = normalizeWorkforceBankReference(instruction.referenceNo);
    // Beneficiary routing values are operator-owned master data. Preserve the
    // normalized values for the bank and let the bank validate their syntax.
    if (!beneficiaryAccountNumber) {
      throw new Error(`${instructionLabel}: Beneficiary Account Number is required.`);
    }
    if (!beneficiaryIfsc) {
      throw new Error(`${instructionLabel}: IFSC Code is required.`);
    }
    if (!isValidWorkforceBankReference(referenceNo, options.referencePrefix)) {
      throw new Error(`${instructionLabel}: Unique Customer Reference Number is invalid.`);
    }

    return {
      "Transaction Type": beneficiaryIfsc.startsWith("FDRL") ? "IFT" : "NEFT",
      "Debit Account Number": debitAccountNumber,
      "Transaction Amount": transactionAmount(instruction.amountPaise),
      "Value Date": valueDate,
      "Beneficiary Account Number": beneficiaryAccountNumber,
      "Beneficiary Name": requiredText(instruction.beneficiaryName, `${instructionLabel}: Beneficiary Name`),
      "IFSC Code": beneficiaryIfsc,
      "Beneficiary Email ID": cleanCell(instruction.beneficiaryEmail),
      "Beneficiary ID": "",
      "Credit Remarks": requiredText(instruction.creditRemarks, `${instructionLabel}: Credit Remarks`).toUpperCase(),
      "Debit Remarks": "NET PAY",
      "Unique Customer Reference Number": referenceNo
    };
  });
}

export function buildWorkforceFedOneWorkbook(options: WorkforceFedOneWorkbookOptions) {
  const rows = buildWorkforceFedOneRows(options);
  const matrix = [
    [...WORKFORCE_FEDONE_HEADERS],
    ...rows.map((row) => WORKFORCE_FEDONE_HEADERS.map((header) => row[header]))
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(matrix);
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

function normalizedHeader(value: unknown) {
  return cleanCell(value).toUpperCase();
}

function responseAmountPaise(value: unknown) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Debit Amount must be greater than zero.");
    const paise = Math.round(value * 100);
    if (!Number.isSafeInteger(paise)) throw new Error("Debit Amount is too large to process safely.");
    if (Math.abs(value - paise / 100) > 1e-9) throw new Error("Debit Amount must have at most two decimal places.");
    return paise;
  }

  const raw = cleanCell(value)
    .replace(/^INR\s*/i, "")
    .replace(/^₹\s*/, "")
    .replace(/,/g, "");
  if (!raw) throw new Error("Debit Amount is required.");
  const match = raw.match(/^\+?(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("Debit Amount must be a positive number with at most two decimal places.");
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const paise = whole * 100 + fraction;
  if (!Number.isSafeInteger(paise)) throw new Error("Debit Amount is too large to process safely.");
  if (paise <= 0) throw new Error("Debit Amount must be greater than zero.");
  return paise;
}

function responseValueDate(value: unknown, date1904: boolean) {
  if (typeof value === "number") {
    const decoded = XLSX.SSF.parse_date_code(value, { date1904 });
    if (decoded && validDateParts(decoded.d, decoded.m, decoded.y)) {
      return `${String(decoded.y).padStart(4, "0")}-${String(decoded.m).padStart(2, "0")}-${String(decoded.d).padStart(2, "0")}`;
    }
    throw new Error("Value Date must be a real Excel date, YYYY-MM-DD or DD/MM/YYYY.");
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const raw = cleanCell(value);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, yearText, monthText, dayText] = iso;
    if (validDateParts(Number(dayText), Number(monthText), Number(yearText))) return raw;
  }
  const display = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (display) {
    const [, dayText, monthText, yearText] = display;
    if (validDateParts(Number(dayText), Number(monthText), Number(yearText))) {
      return `${yearText}-${monthText}-${dayText}`;
    }
  }
  throw new Error("Value Date must be a real Excel date, YYYY-MM-DD or DD/MM/YYYY.");
}

function unsafeNumericIdentifier(value: unknown) {
  return typeof value === "number" && (!Number.isSafeInteger(value) || value < 0);
}

function workbookInput(bytes: ArrayBuffer | Uint8Array) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function parseErrorList(errors: string[]) {
  const shown = errors.slice(0, 25);
  if (errors.length > shown.length) shown.push(`${errors.length - shown.length} more issue(s) were found.`);
  return `The bank response file cannot be processed:\n${shown.map((error) => `- ${error}`).join("\n")}`;
}

function readFedOneResponseSheet(bytes: ArrayBuffer | Uint8Array): FedOneResponseSheet {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(workbookInput(bytes), { type: "array", raw: true });
  } catch {
    throw new Error("The bank response file is not a valid Excel workbook.");
  }

  const firstSheetName = workbook.SheetNames[0];
  const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;
  if (!sheet) throw new Error("No worksheet was found in the uploaded bank response file.");

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: true,
    defval: "",
    raw: true
  });
  const requiredHeaders = new Set(WORKFORCE_FEDONE_RESPONSE_HEADERS.map(normalizedHeader));
  const headerIndex = rows.findIndex((row) => {
    const found = new Set(row.map(normalizedHeader).filter(Boolean));
    return [...requiredHeaders].every((header) => found.has(header));
  });
  if (headerIndex < 0) {
    throw new Error(`Bank response headers were not found. Upload the Transaction Enquiry file containing: ${WORKFORCE_FEDONE_RESPONSE_HEADERS.join(", ")}.`);
  }

  const headerPositions = new Map<string, number[]>();
  rows[headerIndex].forEach((value, index) => {
    const key = normalizedHeader(value);
    if (!key) return;
    headerPositions.set(key, [...(headerPositions.get(key) ?? []), index]);
  });
  const duplicatedHeaders = WORKFORCE_FEDONE_RESPONSE_HEADERS.filter((header) => (headerPositions.get(normalizedHeader(header))?.length ?? 0) > 1);
  const duplicatedSettlementHeaders = WORKFORCE_FEDONE_RESPONSE_SETTLEMENT_HEADERS.filter(
    (header) => (headerPositions.get(normalizedHeader(header))?.length ?? 0) > 1
  );
  if (duplicatedHeaders.length || duplicatedSettlementHeaders.length) {
    throw new Error(`The bank response header row contains duplicate required column(s): ${[
      ...duplicatedHeaders,
      ...duplicatedSettlementHeaders
    ].join(", ")}.`);
  }
  const columnFor = (header: typeof WORKFORCE_FEDONE_RESPONSE_HEADERS[number]) => headerPositions.get(normalizedHeader(header))?.[0] as number;
  const optionalColumnFor = (header: typeof WORKFORCE_FEDONE_RESPONSE_SETTLEMENT_HEADERS[number]) =>
    headerPositions.get(normalizedHeader(header))?.[0];
  return {
    columnFor,
    optionalColumnFor,
    date1904: workbook.Workbook?.WBProps?.date1904 === true,
    headerIndex,
    rows,
    sheet
  };
}

function inspectFedOneResponseSheet(responseSheet: FedOneResponseSheet) {
  const { columnFor, headerIndex, rows } = responseSheet;
  const allReferenceCandidates: PreparedFedOneReferenceCandidate[] = [];
  const references: string[] = [];
  const legacyReferenceCandidates: LegacyDropxFedOneReferenceCandidate[] = [];
  const seen = new Set<string>();
  let dataRowCount = 0;
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    if (row.some((value) => cleanCell(value))) dataRowCount += 1;
    const rawReference = row[columnFor("Customer Ref. No.")] ?? "";
    const referenceNo = normalizeWorkforceBankReference(rawReference);
    if (referenceNo) allReferenceCandidates.push({ referenceNo, rowNumber: rowIndex + 1 });
    const referencePrefix = referenceNo.slice(0, 2);
    const validGeneratedReference =
      (referencePrefix === "WF" || referencePrefix === "WP" || referencePrefix === "HP")
      && isValidWorkforceBankReference(referenceNo, referencePrefix);
    if (
      validGeneratedReference
      && !seen.has(referenceNo)
    ) {
      seen.add(referenceNo);
      references.push(referenceNo);
      continue;
    }

    // Some Federal Bank Transaction Enquiry exports return the bare DropX ID
    // instead of our generated WF/HP reference. Treat only compact identifiers
    // containing both a letter and a digit as possible legacy DropX identities.
    // Company ownership is deliberately decided later from immutable payment
    // ledgers; unrelated bank references remain skippable.
    const dropxId = normalizeDropxBankIdentity(rawReference);
    if (
      !validGeneratedReference
      && dropxId.length >= 2
      && dropxId.length <= 64
      && /[A-Z]/.test(dropxId)
      && /[0-9]/.test(dropxId)
    ) {
      let debitAmountPaise: number | null = null;
      let amountError: string | undefined;
      try {
        debitAmountPaise = responseAmountPaise(row[columnFor("Debit Amount")] ?? "");
      } catch (error) {
        amountError = error instanceof Error ? error.message : "Debit Amount is invalid.";
      }
      legacyReferenceCandidates.push({
        ...(amountError ? { amountError } : {}),
        creditAccount: normalizeWorkforceBankAccount(row[columnFor("Credit Account")] ?? ""),
        debitAmountPaise,
        dropxId,
        ifsc: normalizeWorkforceBankIfsc(row[columnFor("IFSC Code")] ?? ""),
        rowNumber: rowIndex + 1,
        status: cleanCell(row[columnFor("Status")] ?? "").toUpperCase(),
        utrCin: cleanCell(row[columnFor("UTR/CIN")] ?? "")
      });
    }
  }
  return { allReferenceCandidates, dataRowCount, legacyReferenceCandidates, referenceCandidates: references };
}

export function prepareDropxFedOneResponse(bytes: ArrayBuffer | Uint8Array) {
  const responseSheet = readFedOneResponseSheet(bytes);
  return {
    ...inspectFedOneResponseSheet(responseSheet),
    responseSheet
  };
}

export function extractDropxFedOneReferenceCandidates(bytes: ArrayBuffer | Uint8Array) {
  return prepareDropxFedOneResponse(bytes).referenceCandidates;
}

export function countFedOneResponseDataRows(bytes: ArrayBuffer | Uint8Array) {
  return prepareDropxFedOneResponse(bytes).dataRowCount;
}

function parseFedOneResponseSheet(
  responseSheet: FedOneResponseSheet,
  options: WorkforceFedOneResponseOptions & {
    allowAnyReference?: boolean;
    collectRowErrors?: boolean;
    ownedReferences?: ReadonlySet<string>;
    rowReferenceAliases?: ReadonlyMap<number, string>;
  } = {}
): {
  rowErrors: WorkforceFedOneResponseRowError[];
  rows: WorkforceFedOneResponseRow[];
  skippedRows: Array<{ rowNumber: number; referenceNo: string }>;
} {
  const { columnFor, date1904, headerIndex, optionalColumnFor, rows, sheet } = responseSheet;
  const debitAccountColumn = optionalColumnFor("Debit Account");
  const valueDateColumn = optionalColumnFor("Value Date");

  const errors: string[] = [];
  const parsed: WorkforceFedOneResponseRow[] = [];
  const skippedRows: Array<{ rowNumber: number; referenceNo: string }> = [];
  const rowErrors = new Map<number, { messages: string[]; referenceNo: string }>();
  const referenceRows = new Map<string, number[]>();

  const addRowError = (rowNumber: number, referenceNo: string, message: string) => {
    errors.push(`Row ${rowNumber}: ${message}`);
    const current = rowErrors.get(rowNumber) ?? { messages: [], referenceNo };
    current.messages.push(message);
    if (!current.referenceNo && referenceNo) current.referenceNo = referenceNo;
    rowErrors.set(rowNumber, current);
  };

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const rowNumber = rowIndex + 1;
    const values = Object.fromEntries(WORKFORCE_FEDONE_RESPONSE_HEADERS.map((header) => [header, row[columnFor(header)] ?? ""])) as Record<typeof WORKFORCE_FEDONE_RESPONSE_HEADERS[number], unknown>;
    if (WORKFORCE_FEDONE_RESPONSE_HEADERS.every((header) => !cleanCell(values[header]))) continue;

    const rawReference = values["Customer Ref. No."];
    const rawReferenceNo = normalizeWorkforceBankReference(rawReference);
    const referenceNo = normalizeWorkforceBankReference(
      options.rowReferenceAliases?.get(rowNumber) ?? rawReferenceNo
    );
    const referencePrefix = referenceNo.slice(0, 2);
    const isDropxReference = referencePrefix === "WF" || referencePrefix === "WP" || referencePrefix === "HP";
    if (options.ownedReferences && !options.ownedReferences.has(referenceNo)) {
      skippedRows.push({ rowNumber, referenceNo });
      continue;
    }

    const responseColumns = [
      ...WORKFORCE_FEDONE_RESPONSE_HEADERS.map((header) => ({ header, column: columnFor(header) })),
      ...(debitAccountColumn === undefined ? [] : [{ header: "Debit Account", column: debitAccountColumn }]),
      ...(valueDateColumn === undefined ? [] : [{ header: "Value Date", column: valueDateColumn }])
    ];
    for (const { column, header } of responseColumns) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: column });
      const cell = sheet[address] as SheetCell | undefined;
      if (cell?.f) addRowError(rowNumber, referenceNo, `formulas are not accepted in ${header}.`);
    }

    const rawAccount = values["Credit Account"];
    const rawDebitAccount = debitAccountColumn === undefined ? undefined : row[debitAccountColumn];
    if (unsafeNumericIdentifier(rawReference)) addRowError(rowNumber, referenceNo, "Customer Ref. No. was stored as an unsafe Excel number.");
    if (unsafeNumericIdentifier(rawAccount)) addRowError(rowNumber, referenceNo, "Credit Account was stored as an unsafe Excel number.");
    if (unsafeNumericIdentifier(rawDebitAccount)) addRowError(rowNumber, referenceNo, "Debit Account was stored as an unsafe Excel number.");

    const debitAccount = debitAccountColumn === undefined ? undefined : normalizeWorkforceBankAccount(rawDebitAccount);
    const creditAccount = normalizeWorkforceBankAccount(rawAccount);
    const ifsc = normalizeWorkforceBankIfsc(values["IFSC Code"]);
    const status = cleanCell(values.Status).toUpperCase();
    if (!referenceNo) addRowError(rowNumber, referenceNo, "Customer Ref. No. is required.");
    else {
      const expectedPrefix = options.ownedReferences
        ? referencePrefix as "WF" | "WP" | "HP"
        : options.referencePrefix;
      const validReference = options.allowAnyReference
        ? /^[A-Z0-9_-]{2,80}$/.test(referenceNo)
        : isDropxReference && isValidWorkforceBankReference(referenceNo, expectedPrefix);
      if (!validReference) {
        const subject = expectedPrefix === "HP" ? "Helper" : "Workforce";
        addRowError(rowNumber, referenceNo, options.allowAnyReference
          ? "Customer Ref. No. contains unsupported characters or has an invalid length."
          : `Customer Ref. No. is not a valid ${subject} payment reference.`);
      }
    }
    if (!creditAccount) addRowError(rowNumber, referenceNo, "Credit Account is required.");
    if (!ifsc) addRowError(rowNumber, referenceNo, "IFSC Code is required.");
    if (!status) addRowError(rowNumber, referenceNo, "Status is required.");
    if (debitAccountColumn !== undefined && !debitAccount) addRowError(rowNumber, referenceNo, "Debit Account is required.");

    let valueDate: string | undefined;
    if (valueDateColumn !== undefined) {
      try {
        valueDate = responseValueDate(row[valueDateColumn], date1904);
      } catch (error) {
        addRowError(rowNumber, referenceNo, error instanceof Error ? error.message : "Value Date is invalid.");
      }
    }

    let debitAmountPaise = 0;
    try {
      debitAmountPaise = responseAmountPaise(values["Debit Amount"]);
    } catch (error) {
      addRowError(rowNumber, referenceNo, error instanceof Error ? error.message : "Debit Amount is invalid.");
    }

    if (referenceNo) {
      const duplicateRows = referenceRows.get(referenceNo);
      if (duplicateRows) duplicateRows.push(rowNumber);
      else referenceRows.set(referenceNo, [rowNumber]);
    }

    parsed.push({
      rowNumber,
      referenceNo,
      ...(debitAccountColumn === undefined ? {} : { debitAccount }),
      creditAccount,
      ifsc,
      ...(valueDateColumn === undefined ? {} : { valueDate }),
      debitAmountPaise,
      status,
      utrCin: cleanCell(values["UTR/CIN"]),
      remarks: cleanCell(values["System Processing Remarks"])
    });
  }

  for (const [referenceNo, duplicateRows] of referenceRows) {
    if (duplicateRows.length < 2) continue;
    const duplicateRowsLabel = duplicateRows.length <= 8
      ? `Rows ${duplicateRows.join(" and ")}`
      : `Rows ${duplicateRows.slice(0, 8).join(", ")} and ${duplicateRows.length - 8} more rows`;
    errors.push(`${duplicateRowsLabel}: duplicate Customer Ref. No. “${referenceNo}” after normalization.`);
    for (const rowNumber of duplicateRows) {
      const current = rowErrors.get(rowNumber) ?? { messages: [], referenceNo };
      current.messages.push(
        duplicateRows.length <= 8
          ? `Duplicate Customer Ref. No. “${referenceNo}”. ${duplicateRowsLabel} were all skipped.`
          : `Duplicate Customer Ref. No. “${referenceNo}” appears ${duplicateRows.length} times. All duplicate rows were skipped.`
      );
      rowErrors.set(rowNumber, current);
    }
  }

  if (!parsed.length && !options.collectRowErrors) {
    if (options.ownedReferences) {
      throw new Error("No matching Workforce or Helper payment references were found for this company.");
    }
    throw new Error("No payment response rows were found below the bank response headers.");
  }
  if (errors.length && !options.collectRowErrors) throw new Error(parseErrorList(errors));
  const rowErrorList = [...rowErrors.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rowNumber, issue]) => ({
      message: issue.messages.join(" "),
      referenceNo: issue.referenceNo,
      rowNumber
    }));
  const invalidRowNumbers = new Set(rowErrorList.map((issue) => issue.rowNumber));
  return {
    rowErrors: rowErrorList,
    rows: options.collectRowErrors
      ? parsed.filter((row) => !invalidRowNumbers.has(row.rowNumber))
      : parsed,
    skippedRows
  };
}

function parseFedOneResponse(
  bytes: ArrayBuffer | Uint8Array,
  options: WorkforceFedOneResponseOptions & { ownedReferences?: ReadonlySet<string> } = {}
) {
  return parseFedOneResponseSheet(readFedOneResponseSheet(bytes), options);
}

export function parseWorkforceFedOneResponse(
  bytes: ArrayBuffer | Uint8Array,
  options: WorkforceFedOneResponseOptions = {}
): WorkforceFedOneResponseRow[] {
  return parseFedOneResponse(bytes, options).rows;
}

export function parseDropxFedOneResponse(
  bytes: ArrayBuffer | Uint8Array,
  ownedReferences: ReadonlySet<string>
): DropxFedOneResponse {
  return parsePreparedDropxFedOneResponse(prepareDropxFedOneResponse(bytes), ownedReferences);
}

export function parsePreparedDropxFedOneResponse(
  prepared: ReturnType<typeof prepareDropxFedOneResponse>,
  ownedReferences: ReadonlySet<string>,
  rowReferenceAliases: ReadonlyMap<number, string> = new Map()
): DropxFedOneResponse {
  const normalizedOwnedReferences = new Set([...ownedReferences].map(normalizeWorkforceBankReference));
  const normalizedAliases = new Map(
    [...rowReferenceAliases].map(([rowNumber, referenceNo]) => [rowNumber, normalizeWorkforceBankReference(referenceNo)])
  );
  const { rows, skippedRows } = parseFedOneResponseSheet(prepared.responseSheet, {
    ownedReferences: normalizedOwnedReferences,
    rowReferenceAliases: normalizedAliases
  });
  return {
    helperRows: rows.filter((row) => row.referenceNo.startsWith("HP")),
    skippedRows,
    workforceRows: rows.filter((row) => row.referenceNo.startsWith("WF") || row.referenceNo.startsWith("WP"))
  };
}

/**
 * Parses the company-owned portion of a mixed Federal Bank enquiry file.
 *
 * Unlike the Workforce-specific parser, references may belong to payment
 * requests or People payroll as well as the Workforce and Helper ledgers. The
 * caller must resolve ownership first and pass only the references it is
 * authorised to finalize; unrelated and out-of-scope rows are skipped before
 * their payment fields are validated.
 */
export function parsePreparedFedOneResponseRows(
  prepared: ReturnType<typeof prepareDropxFedOneResponse>,
  ownedReferences: ReadonlySet<string>,
  rowReferenceAliases: ReadonlyMap<number, string> = new Map()
) {
  const normalizedOwnedReferences = new Set([...ownedReferences].map(normalizeWorkforceBankReference));
  const normalizedAliases = new Map(
    [...rowReferenceAliases].map(([rowNumber, referenceNo]) => [rowNumber, normalizeWorkforceBankReference(referenceNo)])
  );
  return parseFedOneResponseSheet(prepared.responseSheet, {
    allowAnyReference: true,
    ownedReferences: normalizedOwnedReferences,
    rowReferenceAliases: normalizedAliases
  });
}

/**
 * Central-import variant that keeps valid company-owned rows when another
 * owned row is malformed. Existing Workforce and Helper upload screens keep
 * using the strict parser above.
 */
export function parsePreparedFedOneResponseRowsPartially(
  prepared: ReturnType<typeof prepareDropxFedOneResponse>,
  ownedReferences: ReadonlySet<string>,
  rowReferenceAliases: ReadonlyMap<number, string> = new Map()
) {
  const normalizedOwnedReferences = new Set([...ownedReferences].map(normalizeWorkforceBankReference));
  const normalizedAliases = new Map(
    [...rowReferenceAliases].map(([rowNumber, referenceNo]) => [rowNumber, normalizeWorkforceBankReference(referenceNo)])
  );
  return parseFedOneResponseSheet(prepared.responseSheet, {
    allowAnyReference: true,
    collectRowErrors: true,
    ownedReferences: normalizedOwnedReferences,
    rowReferenceAliases: normalizedAliases
  });
}
