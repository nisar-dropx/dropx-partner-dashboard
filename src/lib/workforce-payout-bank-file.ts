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

export type WorkforceFedOnePaymentInstruction = {
  amountPaise: number;
  beneficiaryAccountNumber: string;
  beneficiaryEmail?: string | null;
  beneficiaryIfsc: string;
  beneficiaryName: string;
  locationCode: string;
  referenceNo: string;
};

export type WorkforceFedOneWorkbookOptions = {
  debitAccountNumber: string;
  instructions: readonly WorkforceFedOnePaymentInstruction[];
  valueDate: string;
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
  creditAccount: string;
  ifsc: string;
  debitAmountPaise: number;
  status: string;
  utrCin: string;
  remarks: string;
};

type SheetCell = XLSX.CellObject & { f?: string };

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

export function isValidWorkforceBankAccount(value: unknown) {
  return /^[A-Z0-9]{4,30}$/.test(normalizeWorkforceBankAccount(value));
}

export function isValidWorkforceBankIfsc(value: unknown) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(normalizeWorkforceBankIfsc(value));
}

export function isValidWorkforceBankReference(value: unknown) {
  const reference = normalizeWorkforceBankReference(value);
  return reference.length <= 64 && /^WP[A-Z0-9]+(?:0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$/.test(reference);
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
    if (!isValidWorkforceBankAccount(beneficiaryAccountNumber)) {
      throw new Error(`${instructionLabel}: Beneficiary Account Number must contain 4 to 30 letters or digits.`);
    }
    if (!isValidWorkforceBankIfsc(beneficiaryIfsc)) {
      throw new Error(`${instructionLabel}: IFSC Code must use the standard 11-character format (for example FDRL0000123).`);
    }
    if (!isValidWorkforceBankReference(referenceNo)) {
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
      "Credit Remarks": requiredText(instruction.locationCode, `${instructionLabel}: Credit Remarks location code`).toUpperCase(),
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

export function parseWorkforceFedOneResponse(bytes: ArrayBuffer | Uint8Array): WorkforceFedOneResponseRow[] {
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
  if (duplicatedHeaders.length) {
    throw new Error(`The bank response header row contains duplicate required column(s): ${duplicatedHeaders.join(", ")}.`);
  }
  const columnFor = (header: typeof WORKFORCE_FEDONE_RESPONSE_HEADERS[number]) => headerPositions.get(normalizedHeader(header))?.[0] as number;

  const errors: string[] = [];
  const parsed: WorkforceFedOneResponseRow[] = [];
  const referenceRows = new Map<string, number>();

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const rowNumber = rowIndex + 1;
    const values = Object.fromEntries(WORKFORCE_FEDONE_RESPONSE_HEADERS.map((header) => [header, row[columnFor(header)] ?? ""])) as Record<typeof WORKFORCE_FEDONE_RESPONSE_HEADERS[number], unknown>;
    if (WORKFORCE_FEDONE_RESPONSE_HEADERS.every((header) => !cleanCell(values[header]))) continue;

    for (const header of WORKFORCE_FEDONE_RESPONSE_HEADERS) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnFor(header) });
      const cell = sheet[address] as SheetCell | undefined;
      if (cell?.f) errors.push(`Row ${rowNumber}: formulas are not accepted in ${header}.`);
    }

    const rawReference = values["Customer Ref. No."];
    const rawAccount = values["Credit Account"];
    if (unsafeNumericIdentifier(rawReference)) errors.push(`Row ${rowNumber}: Customer Ref. No. was stored as an unsafe Excel number.`);
    if (unsafeNumericIdentifier(rawAccount)) errors.push(`Row ${rowNumber}: Credit Account was stored as an unsafe Excel number.`);

    const referenceNo = normalizeWorkforceBankReference(rawReference);
    const creditAccount = normalizeWorkforceBankAccount(rawAccount);
    const ifsc = normalizeWorkforceBankIfsc(values["IFSC Code"]);
    const status = cleanCell(values.Status).toUpperCase();
    if (!referenceNo) errors.push(`Row ${rowNumber}: Customer Ref. No. is required.`);
    else if (!isValidWorkforceBankReference(referenceNo)) errors.push(`Row ${rowNumber}: Customer Ref. No. is not a valid Workforce payment reference.`);
    if (!creditAccount) errors.push(`Row ${rowNumber}: Credit Account is required.`);
    else if (!isValidWorkforceBankAccount(creditAccount)) errors.push(`Row ${rowNumber}: Credit Account must contain 4 to 30 letters or digits.`);
    if (!ifsc) errors.push(`Row ${rowNumber}: IFSC Code is required.`);
    else if (!isValidWorkforceBankIfsc(ifsc)) errors.push(`Row ${rowNumber}: IFSC Code must use the standard 11-character format.`);
    if (!status) errors.push(`Row ${rowNumber}: Status is required.`);

    let debitAmountPaise = 0;
    try {
      debitAmountPaise = responseAmountPaise(values["Debit Amount"]);
    } catch (error) {
      errors.push(`Row ${rowNumber}: ${error instanceof Error ? error.message : "Debit Amount is invalid."}`);
    }

    if (referenceNo) {
      const firstRowNumber = referenceRows.get(referenceNo);
      if (firstRowNumber) {
        errors.push(`Rows ${firstRowNumber} and ${rowNumber}: duplicate Customer Ref. No. “${referenceNo}” after normalization.`);
      } else {
        referenceRows.set(referenceNo, rowNumber);
      }
    }

    parsed.push({
      rowNumber,
      referenceNo,
      creditAccount,
      ifsc,
      debitAmountPaise,
      status,
      utrCin: cleanCell(values["UTR/CIN"]),
      remarks: cleanCell(values["System Processing Remarks"])
    });
  }

  if (!parsed.length) throw new Error("No payment response rows were found below the bank response headers.");
  if (errors.length) throw new Error(parseErrorList(errors));
  return parsed;
}
