import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

export type WorkforceAdvanceImportIssue = {
  rowNumber: number | null;
  dropxId: string | null;
  message: string;
};

export const workforceAdvancePaymentModes = ["bank_transfer", "upi", "cash", "other"] as const;
export type WorkforceAdvancePaymentMode = (typeof workforceAdvancePaymentModes)[number];

export type WorkforceAdvanceImportRow = {
  rowNumber: number;
  dropxId: string;
  advanceDate: string;
  amount: number | null;
  deductedAmount: number;
  reference: string;
  paymentMode: WorkforceAdvancePaymentMode;
  remark: string;
};

export type ParsedWorkforceAdvanceImport = {
  fileSha256: string;
  rows: WorkforceAdvanceImportRow[];
  issues: WorkforceAdvanceImportIssue[];
  canCommit: boolean;
};

export const WORKFORCE_ADVANCE_IMPORT_HEADERS = [
  "DROPX_ID",
  "ADVANCE_DATE",
  "AMOUNT",
  "DEDUCTED_AMOUNT",
  "REFERENCE",
  "PAYMENT_MODE",
  "REMARK"
] as const;

export const WORKFORCE_ADVANCE_IMPORT_MAX_ROWS = 10_000;

const MAX_AMOUNT = 999_999_999_999.99;
const MAX_DROPX_ID_LENGTH = 80;
const MAX_REFERENCE_LENGTH = 200;
const MAX_REMARK_LENGTH = 500;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeHeader(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function normalizeWorkforceAdvanceId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return value.toFixed(0).toUpperCase();
  }
  return String(value ?? "").trim().toUpperCase();
}

export function normalizeWorkforceAdvancePaymentMode(value: unknown): WorkforceAdvancePaymentMode {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const aliases: Record<string, WorkforceAdvancePaymentMode> = {
    account_transfer: "bank_transfer",
    bank: "bank_transfer",
    bank_payment: "bank_transfer",
    bank_transfer: "bank_transfer",
    imps: "bank_transfer",
    neft: "bank_transfer",
    rtgs: "bank_transfer",
    upi_payment: "upi",
    upi: "upi",
    cash: "cash",
    online: "other",
    online_payment: "other",
    cheque: "other",
    check: "other",
    other: "other"
  };
  return aliases[normalized] ?? "other";
}

export function isValidWorkforceAdvanceDate(value: string) {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function isoDate(year: number, month: number, day: number) {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isValidWorkforceAdvanceDate(value) ? value : "";
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
  for (const label of WORKFORCE_ADVANCE_IMPORT_HEADERS) {
    const key = normalizeHeader(label);
    const matchingIndexes = normalized.flatMap((value, index) => value === key ? [index] : []);
    if (!matchingIndexes.length) throw new Error(`Required column “${label}” is missing.`);
    if (matchingIndexes.length > 1) throw new Error(`Column “${label}” appears more than once.`);
    result[key] = matchingIndexes[0];
  }
  return { result, normalized };
}

function exactDuplicateKey(row: WorkforceAdvanceImportRow) {
  return [
    row.dropxId,
    row.advanceDate,
    row.amount === null || !Number.isFinite(row.amount) ? "" : row.amount.toFixed(2),
    row.reference.toUpperCase(),
    row.paymentMode
  ].join("|");
}

function normalizedBusinessReference(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function workforceAdvanceImportBusinessKey(input: {
  workforceId: string;
  advanceDate: string;
  amount: number;
  reference: string;
  paymentMode: WorkforceAdvancePaymentMode;
}) {
  const reference = normalizedBusinessReference(input.reference);
  const material = reference
    ? ["v1", input.workforceId, "reference", reference]
    : ["v1", input.workforceId, "business", input.advanceDate, input.amount.toFixed(2), input.paymentMode];
  return `WAI1-${createHash("md5").update(material.join("|")).digest("hex")}`;
}

export function workforceAdvanceWorkbookSha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseWorkforceAdvanceWorkbook(bytes: Uint8Array): ParsedWorkforceAdvanceImport {
  const fileSha256 = workforceAdvanceWorkbookSha256(bytes);
  // `raw: true` keeps DD/MM/YYYY text in CSV files from being reinterpreted
  // as an environment-specific MM/DD/YYYY date. Typed Excel dates remain
  // numeric serials and are handled explicitly below.
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
  if (sourceRows.length < 2) throw new Error("The workbook does not contain any advance rows.");
  if (sourceRows.length - 1 > WORKFORCE_ADVANCE_IMPORT_MAX_ROWS) {
    throw new Error(`An advance upload can contain at most ${WORKFORCE_ADVANCE_IMPORT_MAX_ROWS} rows.`);
  }

  const { result: indexes, normalized: normalizedHeaders } = columns(sourceRows[0]);
  const knownHeaders = new Set(WORKFORCE_ADVANCE_IMPORT_HEADERS.map(normalizeHeader));
  const issues: WorkforceAdvanceImportIssue[] = [];
  normalizedHeaders.forEach((header, index) => {
    if (header && !knownHeaders.has(header)) {
      issues.push({
        rowNumber: null,
        dropxId: null,
        message: `Unknown column “${String(sourceRows[0][index] ?? "").trim()}”. Use the current advance template headers.`
      });
    }
  });

  const formulaRows = new Set<number>();
  if (sheet["!ref"]) {
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let rowIndex = Math.max(1, range.s.r); rowIndex <= range.e.r; rowIndex += 1) {
      for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
        if (cell?.f) formulaRows.add(rowIndex + 1);
      }
    }
  }

  const rows = sourceRows.slice(1).flatMap<WorkforceAdvanceImportRow>((source, offset) => {
    const rowNumber = offset + 2;
    const formatted = formattedRows[offset + 1] ?? source;
    const populated = source.some((value) => String(value ?? "").trim() !== "");
    if (!populated) return [];

    const rawDropxId = source[indexes.dropxid];
    const dropxId = normalizeWorkforceAdvanceId(
      typeof rawDropxId === "number" ? rawDropxId : formatted[indexes.dropxid]
    );
    const advanceDate = spreadsheetDate(source[indexes.advancedate], date1904);
    const amount = money(source[indexes.amount]);
    const rawDeductedAmount = money(source[indexes.deductedamount]);
    const deductedAmount = rawDeductedAmount === null ? 0 : rawDeductedAmount;
    const reference = textCell(formatted[indexes.reference]);
    const paymentMode = normalizeWorkforceAdvancePaymentMode(formatted[indexes.paymentmode]);
    const remark = textCell(formatted[indexes.remark]);

    if (!dropxId) {
      issues.push({ rowNumber, dropxId: null, message: "DropX ID is required." });
    } else if (dropxId.length > MAX_DROPX_ID_LENGTH) {
      issues.push({ rowNumber, dropxId, message: `DropX ID cannot exceed ${MAX_DROPX_ID_LENGTH} characters.` });
    }
    if (!advanceDate) {
      issues.push({
        rowNumber,
        dropxId: dropxId || null,
        message: "ADVANCE_DATE must be a real date written as DD-MM-YYYY or DD/MM/YYYY."
      });
    }
    if (amount === null || !Number.isFinite(amount)) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "AMOUNT must be a valid number." });
    } else if (amount <= 0) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "AMOUNT must be greater than zero." });
    } else if (amount > MAX_AMOUNT) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "AMOUNT is too large." });
    } else if (Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "AMOUNT can have at most two decimal places." });
    }
    if (!Number.isFinite(deductedAmount)) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "DEDUCTED_AMOUNT must be a valid number or blank." });
    } else if (deductedAmount < 0) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "DEDUCTED_AMOUNT cannot be negative." });
    } else if (deductedAmount > MAX_AMOUNT) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "DEDUCTED_AMOUNT is too large." });
    } else if (Math.abs(deductedAmount * 100 - Math.round(deductedAmount * 100)) > 0.000001) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "DEDUCTED_AMOUNT can have at most two decimal places." });
    } else if (amount !== null && Number.isFinite(amount) && deductedAmount > amount) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "DEDUCTED_AMOUNT cannot be greater than AMOUNT." });
    }
    if (reference.length > MAX_REFERENCE_LENGTH) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: `REFERENCE cannot exceed ${MAX_REFERENCE_LENGTH} characters.` });
    }
    if (remark.length > MAX_REMARK_LENGTH) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: `REMARK cannot exceed ${MAX_REMARK_LENGTH} characters.` });
    }
    if (formulaRows.has(rowNumber)) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "Formula cells are not accepted. Paste their values before uploading." });
    }

    return [{
      rowNumber,
      dropxId,
      advanceDate,
      amount,
      deductedAmount,
      reference,
      paymentMode,
      remark
    }];
  });

  if (!rows.length) throw new Error("The workbook does not contain any advance rows.");
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (!row.dropxId || !row.advanceDate || row.amount === null || !Number.isFinite(row.amount)) continue;
    const key = exactDuplicateKey(row);
    const firstRow = seen.get(key);
    if (firstRow) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `This advance duplicates row ${firstRow}. Keep only one copy of the same payment.`
      });
    } else {
      seen.set(key, row.rowNumber);
    }
  }

  return { fileSha256, rows, issues, canCommit: issues.length === 0 };
}

function displayDate(value: string | undefined) {
  if (!value || !isValidWorkforceAdvanceDate(value)) return "DD/MM/YYYY";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

export function buildWorkforceAdvanceImportTemplate(options: { exampleDate?: string } = {}) {
  const headers = [...WORKFORCE_ADVANCE_IMPORT_HEADERS];
  const widths = [22, 18, 18, 22, 28, 22, 52].map((wch) => ({ wch }));
  const upload = XLSX.utils.aoa_to_sheet([headers]);
  upload["!cols"] = widths;
  upload["!autofilter"] = { ref: "A1:G1" };

  const exampleDate = displayDate(options.exampleDate);
  const examples = XLSX.utils.aoa_to_sheet([
    ["EXAMPLES ONLY - copy a row to Upload and replace every sample value. Do not upload this worksheet."],
    headers,
    ["DROPX1001", exampleDate, 5000, 1250, "BANK-REF-001", "Bank transfer", "Existing advance with Rs 1,250 already deducted"],
    ["DROPX1002", exampleDate, 1500, 0, "", "Cash", "Cash advance with no previous deduction"]
  ]);
  examples["!cols"] = widths;
  examples["!autofilter"] = { ref: "A2:G4" };

  const instructions = XLSX.utils.aoa_to_sheet([
    ["WORKFORCE ADVANCE BULK UPLOAD"],
    ["DROPX_ID", "Required. Enter the Workforce DropX ID. It is matched within the current company."],
    ["ADVANCE_DATE", "Required. Enter DD-MM-YYYY or DD/MM/YYYY. A genuine Excel date cell is also accepted."],
    ["AMOUNT", "Required. Enter an amount greater than zero with no more than two decimal places."],
    ["DEDUCTED_AMOUNT", "Optional. Enter the amount already recovered before this upload. Leave blank or enter zero when nothing has been deducted. It cannot exceed AMOUNT."],
    ["REFERENCE", "Optional. Enter a stable bank, UPI, voucher or other payment reference. Use a different reference when the same person has more than one otherwise-identical advance on one date."],
    ["PAYMENT_MODE", "Optional. Enter Bank transfer, UPI, Cash or Other. A blank or unrecognised value is stored as Other."],
    ["REMARK", "Optional. Add a short note about the advance."],
    ["Duplicate protection", "A re-saved workbook cannot add the same advance again. REFERENCE is used when present. Without a reference, DropX member, date, amount and payment mode form the duplicate key."],
    ["Important", "Formula cells are not accepted. An exact duplicate payment in the same file is rejected. DEDUCTED_AMOUNT is saved as an opening deduction in the recovery history."]
  ]);
  instructions["!cols"] = [{ wch: 24 }, { wch: 110 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, upload, "Upload");
  XLSX.utils.book_append_sheet(workbook, examples, "Examples");
  XLSX.utils.book_append_sheet(workbook, instructions, "Instructions");
  return new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}
