import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

export type PaymentRecoveryImportIssue = {
  rowNumber: number | null;
  tid: string | null;
  message: string;
};

export type PaymentRecoveryImportRow = {
  rowNumber: number;
  tid: string;
  normalizedTid: string;
  locationCode: string;
  debitMonth: string;
  value: number | null;
  providerReference: string;
  reason: string;
  remark: string;
};

export type ParsedPaymentRecoveryImport = {
  fileSha256: string;
  rows: PaymentRecoveryImportRow[];
  issues: PaymentRecoveryImportIssue[];
  canCommit: boolean;
};

export const PAYMENT_RECOVERY_IMPORT_HEADERS = [
  "TID",
  "LOCATION",
  "DEBIT_MONTH",
  "VALUE",
  "PROVIDER_REFERENCE",
  "REASON",
  "REMARK"
] as const;

export const PAYMENT_RECOVERY_IMPORT_MAX_ROWS = 10_000;

const REQUIRED_PAYMENT_RECOVERY_IMPORT_HEADERS = new Set([
  "TID",
  "LOCATION",
  "DEBIT_MONTH",
  "VALUE"
]);

const MAX_AMOUNT = 999_999_999_999.99;
const MAX_TID_LENGTH = 120;
const MAX_CODE_LENGTH = 80;
const MAX_PROVIDER_REFERENCE_LENGTH = 200;
const MAX_REASON_LENGTH = 500;
const MAX_REMARK_LENGTH = 1_000;
const MAX_SAFE_EXCEL_IDENTIFIER = 999_999_999_999_999;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH_KEY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-01$/;
const MONTH_TEXT_PATTERN = /^([A-Za-z]{3})-(\d{2})$/;
const MONTH_NUMBERS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};
const SCIENTIFIC_NOTATION_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/;

function normalizeHeader(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function compactCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

export function normalizePaymentRecoveryTid(value: unknown) {
  return compactCode(value);
}

export function paymentRecoveryWorkbookSha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isValidPaymentRecoveryDate(value: string) {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function isoDate(year: number, month: number, day: number) {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isValidPaymentRecoveryDate(value) ? value : "";
}

export function isValidPaymentRecoveryMonth(value: string) {
  return ISO_MONTH_KEY_PATTERN.test(value);
}

function isoMonth(year: number, month: number) {
  const value = isoDate(year, month, 1);
  return isValidPaymentRecoveryMonth(value) ? value : "";
}

function spreadsheetMonth(value: unknown, date1904: boolean) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return isoMonth(value.getUTCFullYear(), value.getUTCMonth() + 1);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const parsed = new Date(epoch + Math.floor(value) * 86_400_000);
    return Number.isNaN(parsed.getTime())
      ? ""
      : isoMonth(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1);
  }
  const text = String(value ?? "").trim();
  if (!text) return "";
  const match = text.match(MONTH_TEXT_PATTERN);
  if (!match) return "";
  const month = MONTH_NUMBERS[match[1].toLowerCase()];
  return month ? isoMonth(2000 + Number(match[2]), month) : "";
}

function money(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const parsed = Number(String(value).trim().replace(/[₹,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function textCell(value: unknown) {
  return String(value ?? "").trim();
}

function columns(header: unknown[]) {
  const normalized = header.map(normalizeHeader);
  const result: Record<string, number> = {};
  for (const label of PAYMENT_RECOVERY_IMPORT_HEADERS) {
    const key = normalizeHeader(label);
    const matches = normalized.flatMap((value, index) => value === key ? [index] : []);
    if (!matches.length && REQUIRED_PAYMENT_RECOVERY_IMPORT_HEADERS.has(label)) {
      throw new Error(`Required column “${label}” is missing.`);
    }
    if (matches.length > 1) throw new Error(`Column “${label}” appears more than once.`);
    result[key] = matches[0] ?? -1;
  }
  return { result, normalized };
}

function identifierFromCell(rawValue: unknown, formattedValue: unknown) {
  if (typeof rawValue === "number") {
    if (
      !Number.isFinite(rawValue)
      || !Number.isSafeInteger(rawValue)
      || rawValue < 0
      || rawValue > MAX_SAFE_EXCEL_IDENTIFIER
    ) {
      return { value: "", unsafe: true };
    }
    return { value: rawValue.toFixed(0), unsafe: false };
  }

  const value = textCell(formattedValue ?? rawValue);
  return {
    value,
    unsafe: SCIENTIFIC_NOTATION_PATTERN.test(value)
  };
}

function textStartsLikeFormula(value: unknown) {
  return typeof value === "string" && value.trimStart().startsWith("=");
}

export function parsePaymentRecoveryWorkbook(bytes: Uint8Array): ParsedPaymentRecoveryImport {
  const fileSha256 = paymentRecoveryWorkbookSha256(bytes);
  // Preserve text dates and identifiers exactly. Typed Excel dates remain
  // numeric serials and are interpreted explicitly below.
  const workbook = XLSX.read(bytes, { type: "array", cellDates: false, raw: true });
  const date1904 = workbook.Workbook?.WBProps?.date1904 === true;
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The workbook does not contain an Upload worksheet.");
  const sheet = workbook.Sheets[sheetName];
  const sourceRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: true
  });
  const formattedRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: true
  });
  if (!sourceRows.length) throw new Error("The workbook does not contain the recovery headers.");

  const { result: indexes, normalized: normalizedHeaders } = columns(sourceRows[0]);
  const knownHeaders = new Set(PAYMENT_RECOVERY_IMPORT_HEADERS.map(normalizeHeader));
  const issues: PaymentRecoveryImportIssue[] = [];
  normalizedHeaders.forEach((header, index) => {
    if (header && !knownHeaders.has(header)) {
      issues.push({
        rowNumber: null,
        tid: null,
        message: `Unknown column “${String(sourceRows[0][index] ?? "").trim()}”. Use the current Recovery template headers.`
      });
    }
  });

  const formulaRows = new Set<number>();
  if (sheet["!ref"]) {
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let rowIndex = Math.max(1, range.s.r); rowIndex <= range.e.r; rowIndex += 1) {
      for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
        if (cell?.f || textStartsLikeFormula(cell?.v)) formulaRows.add(rowIndex + 1);
      }
    }
  }

  const populatedRows = sourceRows.slice(1).flatMap((source, offset) => {
    const formatted = formattedRows[offset + 1] ?? source;
    const populated = source.some((value) => String(value ?? "").trim() !== "");
    return populated ? [{ source, formatted, rowNumber: offset + 2 }] : [];
  });
  if (!populatedRows.length) throw new Error("The workbook does not contain any recovery rows.");
  if (populatedRows.length > PAYMENT_RECOVERY_IMPORT_MAX_ROWS) {
    throw new Error(`A Recovery upload can contain at most ${PAYMENT_RECOVERY_IMPORT_MAX_ROWS} TIDs.`);
  }

  const rows = populatedRows.map<PaymentRecoveryImportRow>(({ source, formatted, rowNumber }) => {
    const tidCell = identifierFromCell(source[indexes.tid], formatted[indexes.tid]);
    const tid = tidCell.value;
    const normalizedTid = normalizePaymentRecoveryTid(tid);
    const locationCode = compactCode(formatted[indexes.location]);
    const debitMonth = spreadsheetMonth(source[indexes.debitmonth], date1904);
    const value = money(source[indexes.value]);
    const providerReference = textCell(formatted[indexes.providerreference]);
    const reason = textCell(formatted[indexes.reason]);
    const remark = textCell(formatted[indexes.remark]);
    const issueTid = tid || null;

    if (!tid && !tidCell.unsafe) {
      issues.push({ rowNumber, tid: null, message: "TID is required." });
    } else if (tidCell.unsafe) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: "TID was stored as an unsafe number or scientific notation. Format TID as Text and paste the exact identifier."
      });
    } else if (tid.length > MAX_TID_LENGTH) {
      issues.push({ rowNumber, tid, message: `TID cannot exceed ${MAX_TID_LENGTH} characters.` });
    }
    if (!locationCode) {
      issues.push({ rowNumber, tid: issueTid, message: "LOCATION is required." });
    } else if (locationCode.length > MAX_CODE_LENGTH) {
      issues.push({ rowNumber, tid: issueTid, message: `LOCATION cannot exceed ${MAX_CODE_LENGTH} characters.` });
    }
    if (!debitMonth) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: "DEBIT_MONTH must be a real Excel date or text written exactly as MMM-YY, for example Jul-26."
      });
    }
    if (value === null || !Number.isFinite(value)) {
      issues.push({ rowNumber, tid: issueTid, message: "VALUE must be a valid number." });
    } else if (value <= 0) {
      issues.push({ rowNumber, tid: issueTid, message: "VALUE must be greater than zero." });
    } else if (value > MAX_AMOUNT) {
      issues.push({ rowNumber, tid: issueTid, message: "VALUE is too large." });
    } else if (Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
      issues.push({ rowNumber, tid: issueTid, message: "VALUE can have at most two decimal places." });
    }
    if (providerReference.length > MAX_PROVIDER_REFERENCE_LENGTH) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: `PROVIDER_REFERENCE cannot exceed ${MAX_PROVIDER_REFERENCE_LENGTH} characters.`
      });
    }
    if (reason.length > MAX_REASON_LENGTH) {
      issues.push({ rowNumber, tid: issueTid, message: `REASON cannot exceed ${MAX_REASON_LENGTH} characters.` });
    }
    if (remark.length > MAX_REMARK_LENGTH) {
      issues.push({ rowNumber, tid: issueTid, message: `REMARK cannot exceed ${MAX_REMARK_LENGTH} characters.` });
    }
    if (formulaRows.has(rowNumber)) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: "Formula cells are not accepted. Paste their values before uploading."
      });
    }

    return {
      rowNumber,
      tid,
      normalizedTid,
      locationCode,
      debitMonth,
      value,
      providerReference,
      reason,
      remark
    };
  });

  const firstRowsByTid = new Map<string, number>();
  for (const row of rows) {
    if (!row.normalizedTid) continue;
    const firstRow = firstRowsByTid.get(row.normalizedTid);
    if (firstRow) {
      issues.push({
        rowNumber: row.rowNumber,
        tid: row.tid || null,
        message: `TID duplicates row ${firstRow}. Each TID can appear only once in a workbook.`
      });
    } else {
      firstRowsByTid.set(row.normalizedTid, row.rowNumber);
    }
  }

  return { fileSha256, rows, issues, canCommit: issues.length === 0 };
}

function exampleMonthDate(value: string | undefined) {
  if (!value || !ISO_DATE_PATTERN.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  return isoMonth(year, month) ? new Date(Date.UTC(year, month - 1, 1)) : null;
}

function prepareInputCells(
  sheet: XLSX.WorkSheet,
  textColumns: number[],
  monthColumns: number[]
) {
  for (let rowIndex = 1; rowIndex <= PAYMENT_RECOVERY_IMPORT_MAX_ROWS; rowIndex += 1) {
    for (const columnIndex of textColumns) {
      sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })] = { t: "s", v: "", z: "@" };
    }
    for (const columnIndex of monthColumns) {
      sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })] = { t: "s", v: "", z: "mmm-yy" };
    }
  }
  sheet["!ref"] = `A1:G${PAYMENT_RECOVERY_IMPORT_MAX_ROWS + 1}`;
}

export function buildPaymentRecoveryImportTemplate(options: { exampleMonth?: string } = {}) {
  const headers = [...PAYMENT_RECOVERY_IMPORT_HEADERS];
  const widths = [24, 16, 16, 18, 28, 44, 52].map((wch) => ({ wch }));
  const upload = XLSX.utils.aoa_to_sheet([headers]);
  upload["!cols"] = widths;
  upload["!autofilter"] = { ref: "A1:G1" };
  prepareInputCells(upload, [0], [2]);

  const exampleMonth = exampleMonthDate(options.exampleMonth) ?? "MMM-YY";
  const examples = XLSX.utils.aoa_to_sheet([
    ["EXAMPLES ONLY - copy a row to Upload and replace every sample value. Do not upload this worksheet."],
    headers,
    [
      "TID-000001",
      "KOZA",
      exampleMonth,
      2000,
      "",
      "Shipment loss recovery",
      "Configure the recovery route and responsible IDs after upload"
    ],
    [
      "TID-000002",
      "KOZA",
      exampleMonth,
      1500,
      "PROVIDER-DEBIT-002",
      "Provider debit disputed",
      "No payment deduction or provider dispute is created by this upload"
    ]
  ]);
  examples["!cols"] = widths;
  examples["!autofilter"] = { ref: "A2:G4" };
  for (const address of ["A3", "A4"]) {
    if (examples[address]) examples[address].z = "@";
  }
  for (const address of ["C3", "C4"]) {
    if (examples[address]) examples[address].z = "mmm-yy";
  }

  const instructions = XLSX.utils.aoa_to_sheet([
    ["PAYMENT RECOVERY BULK UPLOAD"],
    ["TID", "Required and unique. Keep the exact transaction ID as Text, especially for long or numeric-only IDs. Scientific notation and formulas are rejected."],
    ["LOCATION", "Required. Enter the location code for the provider debit. The provider is identified automatically from this location."],
    ["DEBIT_MONTH", "Required. Enter MMM-YY, for example Jul-26. A genuine Excel date cell is also accepted and is normalized to its month."],
    ["VALUE", "Required. Enter an amount greater than zero with no more than two decimal places."],
    ["PROVIDER_REFERENCE", "Optional. Enter the provider debit memo, invoice or other stable reference."],
    ["REASON", "Optional. Enter the business reason for the debit or dispute."],
    ["REMARK", "Optional. Add a short operational note."],
    ["Duplicate protection", "A TID may appear only once in the workbook. A TID already recorded in the Recovery register cannot be imported again."],
    ["Important", "Formula cells are not accepted. Format TID as Text. Each upload row creates an unconfigured TID recovery case. It does not deduct a payment or submit a provider dispute."]
  ]);
  instructions["!cols"] = [{ wch: 24 }, { wch: 118 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, upload, "Upload");
  XLSX.utils.book_append_sheet(workbook, examples, "Examples");
  XLSX.utils.book_append_sheet(workbook, instructions, "Instructions");
  return new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer", cellStyles: true }));
}
