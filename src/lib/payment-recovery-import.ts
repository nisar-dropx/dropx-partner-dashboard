import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

export const paymentRecoveryMethods = ["PAYOUT_DEDUCTION", "POST_INVOICE_DISPUTE"] as const;
export type PaymentRecoveryMethod = (typeof paymentRecoveryMethods)[number];

export type PaymentRecoveryImportIssue = {
  rowNumber: number | null;
  tid: string | null;
  message: string;
};

export type PaymentRecoveryImportRow = {
  rowNumber: number;
  tid: string;
  normalizedTid: string;
  providerCode: string;
  locationCode: string;
  debitDate: string;
  debitAmount: number | null;
  recoveryMethod: PaymentRecoveryMethod | "";
  recoveryIds: string[];
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

export type PaymentRecoveryEqualAllocation = {
  dropxId: string;
  amount: number;
};

export const PAYMENT_RECOVERY_IMPORT_HEADERS = [
  "TID",
  "PROVIDER_CODE",
  "LOCATION",
  "DEBIT_DATE",
  "DEBIT_AMOUNT",
  "RECOVERY_METHOD",
  "RECOVERY_IDS",
  "PROVIDER_REFERENCE",
  "REASON",
  "REMARK"
] as const;

export const PAYMENT_RECOVERY_IMPORT_MAX_ROWS = 10_000;

const MAX_AMOUNT = 999_999_999_999.99;
const MAX_TID_LENGTH = 120;
const MAX_CODE_LENGTH = 80;
const MAX_RECOVERY_ID_LENGTH = 80;
const MAX_RECOVERY_IDS = 50;
const MAX_PROVIDER_REFERENCE_LENGTH = 200;
const MAX_REASON_LENGTH = 500;
const MAX_REMARK_LENGTH = 1_000;
const MAX_SAFE_EXCEL_IDENTIFIER = 999_999_999_999_999;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
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

export function normalizePaymentRecoveryPersonId(value: unknown) {
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

function spreadsheetDate(value: unknown, date1904: boolean) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const parsed = new Date(epoch + Math.floor(value) * 86_400_000);
    return Number.isNaN(parsed.getTime())
      ? ""
      : isoDate(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
  }
  const text = String(value ?? "").trim();
  if (!text) return "";
  const match = text.match(/^(\d{2})([\/-])(\d{2})\2(\d{4})$/);
  return match ? isoDate(Number(match[4]), Number(match[3]), Number(match[1])) : "";
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
    if (!matches.length) throw new Error(`Required column “${label}” is missing.`);
    if (matches.length > 1) throw new Error(`Column “${label}” appears more than once.`);
    result[key] = matches[0];
  }
  return { result, normalized };
}

function normalizeRecoveryMethod(value: unknown): PaymentRecoveryMethod | "" {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return paymentRecoveryMethods.includes(normalized as PaymentRecoveryMethod)
    ? normalized as PaymentRecoveryMethod
    : "";
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

function parseRecoveryIds(rawValue: unknown, formattedValue: unknown) {
  const identifier = identifierFromCell(rawValue, formattedValue);
  if (identifier.unsafe) return { ids: [] as string[], unsafe: true, duplicates: [] as string[] };
  const tokens = identifier.value
    .split(/[,;\r\n]+/)
    .map(normalizePaymentRecoveryPersonId)
    .filter(Boolean);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const ids: string[] = [];
  for (const token of tokens) {
    if (SCIENTIFIC_NOTATION_PATTERN.test(token)) {
      return { ids: [], unsafe: true, duplicates: [] as string[] };
    }
    if (seen.has(token)) {
      duplicates.add(token);
      continue;
    }
    seen.add(token);
    ids.push(token);
  }
  return { ids, unsafe: false, duplicates: [...duplicates] };
}

function textStartsLikeFormula(value: unknown) {
  return typeof value === "string" && value.trimStart().startsWith("=");
}

export function splitPaymentRecoveryAmountEqually(
  debitAmount: number,
  recoveryIds: string[]
): PaymentRecoveryEqualAllocation[] {
  if (!Number.isFinite(debitAmount) || debitAmount <= 0) {
    throw new Error("Debit amount must be greater than zero.");
  }
  if (Math.abs(debitAmount * 100 - Math.round(debitAmount * 100)) > 0.000001) {
    throw new Error("Debit amount can have at most two decimal places.");
  }
  const ids = [...new Set(recoveryIds.map(normalizePaymentRecoveryPersonId).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  if (!ids.length) throw new Error("At least one Recovery ID is required.");
  const totalCents = Math.round(debitAmount * 100);
  if (totalCents < ids.length) {
    throw new Error("Debit amount must provide at least one paise for every Recovery ID.");
  }
  const baseCents = Math.floor(totalCents / ids.length);
  const remainder = totalCents % ids.length;
  return ids.map((dropxId, index) => ({
    dropxId,
    amount: (baseCents + (index < remainder ? 1 : 0)) / 100
  }));
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
    const providerCode = compactCode(formatted[indexes.providercode]);
    const locationCode = compactCode(formatted[indexes.location]);
    const debitDate = spreadsheetDate(source[indexes.debitdate], date1904);
    const debitAmount = money(source[indexes.debitamount]);
    const rawMethod = textCell(formatted[indexes.recoverymethod]);
    const recoveryMethod = normalizeRecoveryMethod(rawMethod);
    const parsedRecoveryIds = parseRecoveryIds(source[indexes.recoveryids], formatted[indexes.recoveryids]);
    const recoveryIds = parsedRecoveryIds.ids;
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
    if (!providerCode) {
      issues.push({ rowNumber, tid: issueTid, message: "PROVIDER_CODE is required." });
    } else if (providerCode.length > MAX_CODE_LENGTH) {
      issues.push({ rowNumber, tid: issueTid, message: `PROVIDER_CODE cannot exceed ${MAX_CODE_LENGTH} characters.` });
    }
    if (!locationCode) {
      issues.push({ rowNumber, tid: issueTid, message: "LOCATION is required." });
    } else if (locationCode.length > MAX_CODE_LENGTH) {
      issues.push({ rowNumber, tid: issueTid, message: `LOCATION cannot exceed ${MAX_CODE_LENGTH} characters.` });
    }
    if (!debitDate) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: "DEBIT_DATE must be a real date written as DD-MM-YYYY or DD/MM/YYYY."
      });
    }
    if (debitAmount === null || !Number.isFinite(debitAmount)) {
      issues.push({ rowNumber, tid: issueTid, message: "DEBIT_AMOUNT must be a valid number." });
    } else if (debitAmount <= 0) {
      issues.push({ rowNumber, tid: issueTid, message: "DEBIT_AMOUNT must be greater than zero." });
    } else if (debitAmount > MAX_AMOUNT) {
      issues.push({ rowNumber, tid: issueTid, message: "DEBIT_AMOUNT is too large." });
    } else if (Math.abs(debitAmount * 100 - Math.round(debitAmount * 100)) > 0.000001) {
      issues.push({ rowNumber, tid: issueTid, message: "DEBIT_AMOUNT can have at most two decimal places." });
    }
    if (!recoveryMethod) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: "RECOVERY_METHOD must be PAYOUT_DEDUCTION or POST_INVOICE_DISPUTE."
      });
    }
    if (parsedRecoveryIds.unsafe) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: "RECOVERY_IDS contains an unsafe number or scientific notation. Format the IDs as Text and paste the exact values."
      });
    }
    if (parsedRecoveryIds.duplicates.length) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: `RECOVERY_IDS lists ${parsedRecoveryIds.duplicates.join(", ")} more than once.`
      });
    }
    for (const recoveryId of recoveryIds) {
      if (recoveryId.length > MAX_RECOVERY_ID_LENGTH) {
        issues.push({
          rowNumber,
          tid: issueTid,
          message: `Recovery ID ${recoveryId} cannot exceed ${MAX_RECOVERY_ID_LENGTH} characters.`
        });
      }
    }
    if (recoveryIds.length > MAX_RECOVERY_IDS) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: `RECOVERY_IDS can contain at most ${MAX_RECOVERY_IDS} DropX IDs.`
      });
    }
    if (recoveryMethod === "PAYOUT_DEDUCTION" && recoveryIds.length === 0 && !parsedRecoveryIds.unsafe) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: "RECOVERY_IDS is required for PAYOUT_DEDUCTION."
      });
    }
    if (
      recoveryMethod === "PAYOUT_DEDUCTION"
      && recoveryIds.length > 0
      && debitAmount !== null
      && Number.isFinite(debitAmount)
      && debitAmount > 0
      && Math.abs(debitAmount * 100 - Math.round(debitAmount * 100)) <= 0.000001
      && Math.round(debitAmount * 100) < recoveryIds.length
    ) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: "DEBIT_AMOUNT must provide at least one paise for every Recovery ID."
      });
    }
    if (recoveryMethod === "POST_INVOICE_DISPUTE" && recoveryIds.length > 0) {
      issues.push({
        rowNumber,
        tid: issueTid,
        message: "RECOVERY_IDS must be blank for POST_INVOICE_DISPUTE."
      });
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
      providerCode,
      locationCode,
      debitDate,
      debitAmount,
      recoveryMethod,
      recoveryIds,
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

function displayDate(value: string | undefined) {
  if (!value || !isValidPaymentRecoveryDate(value)) return "DD/MM/YYYY";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function prepareTextInputCells(sheet: XLSX.WorkSheet, columnsToFormat: number[]) {
  for (let rowIndex = 1; rowIndex <= PAYMENT_RECOVERY_IMPORT_MAX_ROWS; rowIndex += 1) {
    for (const columnIndex of columnsToFormat) {
      sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })] = { t: "s", v: "", z: "@" };
    }
  }
  sheet["!ref"] = `A1:J${PAYMENT_RECOVERY_IMPORT_MAX_ROWS + 1}`;
}

export function buildPaymentRecoveryImportTemplate(options: { exampleDate?: string } = {}) {
  const headers = [...PAYMENT_RECOVERY_IMPORT_HEADERS];
  const widths = [24, 20, 16, 16, 18, 26, 42, 28, 44, 52].map((wch) => ({ wch }));
  const upload = XLSX.utils.aoa_to_sheet([headers]);
  upload["!cols"] = widths;
  upload["!autofilter"] = { ref: "A1:J1" };
  prepareTextInputCells(upload, [0, 6]);

  const exampleDate = displayDate(options.exampleDate);
  const examples = XLSX.utils.aoa_to_sheet([
    ["EXAMPLES ONLY - copy a row to Upload and replace every sample value. Do not upload this worksheet."],
    headers,
    [
      "TID-000001",
      "AMAZON",
      "KOZA",
      exampleDate,
      2000,
      "PAYOUT_DEDUCTION",
      "DROPX1001, DROPX1002",
      "PROVIDER-DEBIT-001",
      "Shipment loss recovery",
      "The amount is split equally between both IDs"
    ],
    [
      "TID-000002",
      "AMAZON",
      "KOZA",
      exampleDate,
      1500,
      "POST_INVOICE_DISPUTE",
      "",
      "PROVIDER-DEBIT-002",
      "Provider debit disputed",
      "RECOVERY_IDS stays blank for this method"
    ]
  ]);
  examples["!cols"] = widths;
  examples["!autofilter"] = { ref: "A2:J4" };
  for (const address of ["A3", "G3", "A4", "G4"]) {
    if (examples[address]) examples[address].z = "@";
  }

  const validValues = XLSX.utils.aoa_to_sheet([
    ["RECOVERY_METHOD", "When to use it", "RECOVERY_IDS rule"],
    ["PAYOUT_DEDUCTION", "Recover from one or more people through a payment deduction.", "Required. Separate multiple DropX IDs with commas, semicolons or new lines."],
    ["POST_INVOICE_DISPUTE", "Raise the debit as a post-invoice dispute with the provider.", "Must be blank."]
  ]);
  validValues["!cols"] = [{ wch: 28 }, { wch: 62 }, { wch: 82 }];
  validValues["!autofilter"] = { ref: "A1:C3" };

  const instructions = XLSX.utils.aoa_to_sheet([
    ["PAYMENT RECOVERY BULK UPLOAD"],
    ["TID", "Required and unique. Keep the exact transaction ID as Text, especially for long or numeric-only IDs. Scientific notation and formulas are rejected."],
    ["PROVIDER_CODE", "Required. Enter the provider code exactly as configured in the dashboard."],
    ["LOCATION", "Required. Enter the location code for the provider debit."],
    ["DEBIT_DATE", "Required. Enter DD-MM-YYYY or DD/MM/YYYY. A genuine Excel date cell is also accepted."],
    ["DEBIT_AMOUNT", "Required. Enter an amount greater than zero with no more than two decimal places."],
    ["RECOVERY_METHOD", "Required. Use PAYOUT_DEDUCTION or POST_INVOICE_DISPUTE exactly as shown on the Valid values worksheet."],
    ["RECOVERY_IDS", "For PAYOUT_DEDUCTION, enter one or more DropX IDs separated by commas, semicolons or new lines. The debit is split equally. Any remainder paise is assigned in ascending DropX ID order so the allocated total always equals DEBIT_AMOUNT. Leave blank for POST_INVOICE_DISPUTE."],
    ["PROVIDER_REFERENCE", "Optional. Enter the provider debit memo, invoice or other stable reference."],
    ["REASON", "Optional. Enter the business reason for the debit or dispute."],
    ["REMARK", "Optional. Add a short operational note."],
    ["Duplicate protection", "A TID may appear only once in the workbook. A TID already recorded in the Recovery register cannot be imported again."],
    ["Important", "Formula cells are not accepted. Format TID and RECOVERY_IDS as Text. The upload creates the Recovery register plan; it does not silently deduct a payout or submit a provider dispute."]
  ]);
  instructions["!cols"] = [{ wch: 24 }, { wch: 118 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, upload, "Upload");
  XLSX.utils.book_append_sheet(workbook, examples, "Examples");
  XLSX.utils.book_append_sheet(workbook, validValues, "Valid values");
  XLSX.utils.book_append_sheet(workbook, instructions, "Instructions");
  return new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer", cellStyles: true }));
}
