import * as XLSX from "xlsx";

export const workforcePayoutInputTypes = [
  "ATTENDANCE",
  "PRODUCTION_UNITS",
  "PAYMENT_FIELD_VALUE",
  "ADDITIONAL_PAYMENT",
  "DEDUCTION"
] as const;

export type WorkforcePayoutInputType = (typeof workforcePayoutInputTypes)[number];
export type WorkforcePayoutImportAction = "UPSERT" | "CLEAR";
export type WorkforcePayoutAttendanceStatus = "P" | "HD" | "A";
export type WorkforcePayoutAttendanceBasis = "hours" | "days";

export type WorkforcePayoutImportIssue = {
  rowNumber: number | null;
  dropxId: string | null;
  message: string;
};

export type WorkforcePayoutImportRow = {
  rowNumber: number;
  action: WorkforcePayoutImportAction;
  dropxId: string;
  locationCode: string;
  inputType: WorkforcePayoutInputType | "";
  fieldCode: string;
  effectiveDate: string;
  effectiveFrom: string;
  effectiveTo: string;
  numericValue: number | null;
  textValue: string | null;
  attendanceBasis: WorkforcePayoutAttendanceBasis | null;
  workHours: number | null;
  workDays: number | null;
  workMinutes: number | null;
  remark: string;
};

export type ParsedWorkforcePayoutImport = {
  rows: WorkforcePayoutImportRow[];
  issues: WorkforcePayoutImportIssue[];
};

export type WorkforcePayoutImportWorker = {
  id: string;
  dropxId: string | null;
  fullName: string;
  locationId: string | null;
  dateOfJoin: string | null;
  lastWorkingDate: string | null;
  isActive: boolean;
};

export type WorkforcePayoutImportPaymentField = {
  id: string;
  code: string;
  label: string;
  fieldType: "amount" | "production";
  calculationType: string | null;
  isCustomProduction: boolean;
  isActive: boolean;
};

export type WorkforcePayoutImportAdditionalField = {
  id: string;
  code: string;
  name: string;
  calculationType: "manual_amount" | "units_x_rate";
  defaultRateValue: number | null;
  isActive: boolean;
};

export type WorkforcePayoutImportDeductionHead = {
  id: string;
  code: string;
  name: string;
  calculationType: "manual" | "fixed" | "percentage";
  isSystem: boolean;
  isActive: boolean;
};

export type WorkforcePayoutImportSetup = {
  workforceId: string;
  locationId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  fieldCodes: string[];
};

export type WorkforcePayoutImportLocation = {
  id: string;
  code: string;
};

export type ResolvedWorkforcePayoutImportRow = WorkforcePayoutImportRow & {
  workforceId: string;
  fullName: string;
  locationId: string;
  paymentFieldId: string | null;
  additionalPaymentFieldId: string | null;
  deductionHeadId: string | null;
  additionalCalculationType: WorkforcePayoutImportAdditionalField["calculationType"] | null;
};

export type WorkforcePayoutImportReferences = {
  workers: WorkforcePayoutImportWorker[];
  paymentFields: WorkforcePayoutImportPaymentField[];
  additionalFields: WorkforcePayoutImportAdditionalField[];
  deductionHeads: WorkforcePayoutImportDeductionHead[];
  setups: WorkforcePayoutImportSetup[];
  locations?: WorkforcePayoutImportLocation[];
  allowedLocationIds: Set<string> | null;
};

export type WorkforcePayoutImportTemplateField = {
  code: string;
  label: string;
  inputType: "PAYMENT_FIELD_VALUE" | "PRODUCTION_UNITS" | "ADDITIONAL_PAYMENT" | "DEDUCTION";
  calculation: string;
  valueMeaning: string;
};

export const WORKFORCE_PAYOUT_IMPORT_MAX_ROWS = 10_000;
export const WORKFORCE_PAYOUT_IMPORT_MAX_DAYS = 366;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_HEADERS = new Set([
  "action",
  "dropxid",
  "location",
  "inputtype",
  "fieldcode",
  "effectivedate",
  "effectiveto",
  "value",
  "remark"
]);

function normalizeHeader(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function normalizeWorkforcePayoutCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function isValidWorkforcePayoutDate(value: string) {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatDate(year: number, month: number, day: number) {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isValidWorkforcePayoutDate(value) ? value : "";
}

function displaySpreadsheetDate(value: string) {
  if (!isValidWorkforcePayoutDate(value)) return "DD/MM/YYYY";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function spreadsheetDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    return Number.isNaN(date.getTime())
      ? ""
      : formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const text = String(value ?? "").trim();
  if (!text) return "";
  const match = text.match(/^(\d{2})([\/-])(\d{2})\2(\d{4})$/);
  return match ? formatDate(Number(match[4]), Number(match[3]), Number(match[1])) : "";
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const cleaned = String(value).trim().replace(/[₹,\s]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeInputType(value: unknown): WorkforcePayoutInputType | "" {
  const normalized = normalizeWorkforcePayoutCode(value).replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases: Record<string, WorkforcePayoutInputType> = {
    ATTENDANCE: "ATTENDANCE",
    PRODUCTION: "PRODUCTION_UNITS",
    PRODUCTION_UNIT: "PRODUCTION_UNITS",
    PRODUCTION_UNITS: "PRODUCTION_UNITS",
    PAYMENT_FIELD: "PAYMENT_FIELD_VALUE",
    PAYMENT_VALUE: "PAYMENT_FIELD_VALUE",
    PAYMENT_FIELD_VALUE: "PAYMENT_FIELD_VALUE",
    ADDITIONAL: "ADDITIONAL_PAYMENT",
    ADDITIONAL_PAYMENT: "ADDITIONAL_PAYMENT",
    DEDUCTION: "DEDUCTION",
    DEDUCTIONS: "DEDUCTION"
  };
  return aliases[normalized] ?? "";
}

function normalizeAction(value: unknown): WorkforcePayoutImportAction | "" {
  const normalized = normalizeWorkforcePayoutCode(value);
  if (!normalized || normalized === "UPSERT") return "UPSERT";
  return normalized === "CLEAR" ? "CLEAR" : "";
}

function dateDifferenceDays(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function datesBetween(from: string, to: string) {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function overlaps(leftFrom: string, leftTo: string | null, rightFrom: string, rightTo: string) {
  return leftFrom <= rightTo && (leftTo === null || leftTo >= rightFrom);
}

function rowIdentity(row: WorkforcePayoutImportRow) {
  // Attendance and additional-payment values are one logical value per person
  // and period. Location is ownership/scope metadata for those inputs. Payment
  // rates and production units can legitimately differ by simultaneous station.
  const stationIdentity = row.inputType === "PAYMENT_FIELD_VALUE" || row.inputType === "PRODUCTION_UNITS"
    ? row.locationCode
    : "";
  const fieldIdentity = row.inputType === "ATTENDANCE" ? "" : row.fieldCode;
  return [row.inputType, row.dropxId, stationIdentity, fieldIdentity, row.effectiveFrom, row.effectiveTo].join("|");
}

function resolvedRowIdentity(row: ResolvedWorkforcePayoutImportRow) {
  if (!row.workforceId || !row.effectiveFrom || !row.effectiveTo) return null;
  if (row.inputType === "ATTENDANCE") {
    // Attendance is owned by the worker, unit and explicit effective period.
    // Station remains provenance and must not create a second logical value.
    return [row.inputType, row.workforceId, row.effectiveFrom, row.effectiveTo].join("|");
  }
  if (row.inputType === "ADDITIONAL_PAYMENT") {
    // Additional-payment uniqueness is worker/field/period across stations.
    return row.additionalPaymentFieldId
      ? [row.inputType, row.workforceId, row.additionalPaymentFieldId, row.effectiveFrom, row.effectiveTo].join("|")
      : null;
  }
  if (row.inputType === "DEDUCTION") {
    // Manual deductions are global worker/head/period inputs. Station is
    // ownership metadata and cannot create a duplicate value for the same head.
    return row.deductionHeadId
      ? [row.inputType, row.workforceId, row.deductionHeadId, row.effectiveFrom, row.effectiveTo].join("|")
      : null;
  }
  if (row.inputType === "PRODUCTION_UNITS") {
    return row.locationId && row.paymentFieldId
      ? [row.inputType, row.workforceId, row.locationId, row.paymentFieldId, row.effectiveFrom, row.effectiveTo].join("|")
      : null;
  }
  if (row.inputType === "PAYMENT_FIELD_VALUE") {
    return row.locationId && row.paymentFieldId
      ? [row.inputType, row.workforceId, row.locationId, row.paymentFieldId, row.effectiveFrom, row.effectiveTo].join("|")
      : null;
  }
  return null;
}

function findColumns(header: unknown[]) {
  const normalized = header.map(normalizeHeader);
  const result: Record<string, number> = {};
  const required = [
    ["dropxid", "DROPX_ID"],
    ["inputtype", "INPUT_TYPE"],
    ["fieldcode", "FIELD_CODE"],
    ["effectivedate", "EFFECTIVE_DATE"],
    ["effectiveto", "EFFECTIVE_TO"],
    ["value", "VALUE"]
  ] as const;
  for (const [field, label] of required) {
    const index = normalized.indexOf(field);
    if (index < 0) throw new Error(`Required column “${label}” is missing.`);
    result[field] = index;
  }
  for (const field of ["action", "location", "remark"] as const) result[field] = normalized.indexOf(field);
  return { result, normalized };
}

export function parseWorkforcePayoutWorkbook(
  bytes: Uint8Array,
  options: { batchFrom: string; batchTo: string }
): ParsedWorkforcePayoutImport {
  if (!isValidWorkforcePayoutDate(options.batchFrom) || !isValidWorkforcePayoutDate(options.batchTo) || options.batchTo < options.batchFrom) {
    throw new Error("Select a valid effective-from and effective-to date range.");
  }
  if (dateDifferenceDays(options.batchFrom, options.batchTo) >= WORKFORCE_PAYOUT_IMPORT_MAX_DAYS) {
    throw new Error(`A payout import can cover at most ${WORKFORCE_PAYOUT_IMPORT_MAX_DAYS} days.`);
  }

  const workbook = XLSX.read(bytes, { type: "array", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The workbook does not contain an Upload worksheet.");
  const sheet = workbook.Sheets[sheetName];
  const sourceRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "", blankrows: true });
  const formattedRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true });
  if (sourceRows.length < 2) throw new Error("The workbook does not contain any payout input rows.");
  if (sourceRows.length - 1 > WORKFORCE_PAYOUT_IMPORT_MAX_ROWS) {
    throw new Error(`A payout import can contain at most ${WORKFORCE_PAYOUT_IMPORT_MAX_ROWS} rows.`);
  }

  const { result: columns, normalized: normalizedHeaders } = findColumns(sourceRows[0]);
  const issues: WorkforcePayoutImportIssue[] = [];
  normalizedHeaders.forEach((header, index) => {
    if (header && !KNOWN_HEADERS.has(header)) {
      issues.push({ rowNumber: null, dropxId: null, message: `Unknown column “${String(sourceRows[0][index]).trim()}”. Use the current template headers.` });
    }
  });

  const formulaRows = new Set<number>();
  if (sheet["!ref"]) {
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let rowIndex = Math.max(range.s.r, 1); rowIndex <= range.e.r; rowIndex += 1) {
      for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
        if (cell?.f) formulaRows.add(rowIndex + 1);
      }
    }
  }

  const rows = sourceRows.slice(1).flatMap<WorkforcePayoutImportRow>((source, offset) => {
    const rowNumber = offset + 2;
    const formatted = formattedRows[offset + 1] ?? source;
    const rawValues = source.map((value) => String(value ?? "").trim());
    if (rawValues.every((value) => !value)) return [];
    const dropxId = normalizeWorkforcePayoutCode(formatted[columns.dropxid]);
    const locationCode = columns.location >= 0 ? normalizeWorkforcePayoutCode(formatted[columns.location]) : "";
    const action = normalizeAction(columns.action >= 0 ? formatted[columns.action] : "");
    const inputType = normalizeInputType(formatted[columns.inputtype]);
    const fieldCode = normalizeWorkforcePayoutCode(formatted[columns.fieldcode]);
    const effectiveDate = spreadsheetDate(source[columns.effectivedate]);
    const effectiveFrom = effectiveDate;
    const effectiveTo = spreadsheetDate(source[columns.effectiveto]);
    const rawValue = source[columns.value];
    const remark = columns.remark >= 0 ? String(formatted[columns.remark] ?? "").trim().slice(0, 500) : "";
    let numericValue: number | null = null;
    let textValue: string | null = null;
    let attendanceBasis: WorkforcePayoutAttendanceBasis | null = null;
    let workHours: number | null = null;
    let workDays: number | null = null;
    let workMinutes: number | null = null;

    if (!dropxId) issues.push({ rowNumber, dropxId: null, message: "DropX ID is required." });
    if (!action) issues.push({ rowNumber, dropxId: dropxId || null, message: "ACTION must be UPSERT or CLEAR." });
    if (!inputType) issues.push({ rowNumber, dropxId: dropxId || null, message: "INPUT_TYPE is not supported." });
    if (!effectiveDate) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "EFFECTIVE_DATE must be a real date written as DD-MM-YYYY or DD/MM/YYYY." });
    } else if (effectiveDate < options.batchFrom || effectiveDate > options.batchTo) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: `EFFECTIVE_DATE must fall within the selected ${options.batchFrom} to ${options.batchTo} payout period.` });
    }
    if (!effectiveTo) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "EFFECTIVE_TO is compulsory and must be a real date written as DD-MM-YYYY or DD/MM/YYYY." });
    } else if (effectiveTo < options.batchFrom || effectiveTo > options.batchTo) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: `EFFECTIVE_TO must fall within the selected ${options.batchFrom} to ${options.batchTo} payout period.` });
    }
    if (effectiveDate && effectiveTo && effectiveTo < effectiveDate) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "EFFECTIVE_TO cannot be earlier than EFFECTIVE_DATE." });
    }
    if (action !== "CLEAR" && inputType === "ATTENDANCE" && effectiveDate && effectiveTo
      && effectiveDate.slice(0, 7) !== effectiveTo.slice(0, 7)) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "ATTENDANCE must stay within one calendar month. Split the row at the month boundary." });
    }
    if (effectiveDate && effectiveTo && inputType === "PRODUCTION_UNITS" && effectiveTo !== effectiveDate) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "PRODUCTION_UNITS must use the same date in EFFECTIVE_DATE and EFFECTIVE_TO because production is stored per work date." });
    }
    if (effectiveDate && effectiveTo && (inputType === "ADDITIONAL_PAYMENT" || inputType === "DEDUCTION")
      && (effectiveDate !== options.batchFrom || effectiveTo !== options.batchTo)) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: `${inputType} must use the complete selected payout period ${options.batchFrom} to ${options.batchTo}.` });
    }
    if (formulaRows.has(rowNumber)) issues.push({ rowNumber, dropxId: dropxId || null, message: "Formula cells are not accepted. Paste their values before uploading." });
    if (inputType === "ATTENDANCE" && fieldCode !== "WORK_HOURS" && fieldCode !== "WORK_DAYS") {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "Attendance FIELD_CODE must be WORK_HOURS or WORK_DAYS." });
    } else if (inputType && inputType !== "ATTENDANCE" && !fieldCode) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "FIELD_CODE is required for this input type." });
    }

    if (action === "CLEAR") {
      if (String(rawValue ?? "").trim()) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "CLEAR rows must leave VALUE blank." });
      }
    } else if (inputType === "ATTENDANCE") {
      numericValue = finiteNumber(rawValue);
      if (numericValue === null || !Number.isFinite(numericValue)) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "Attendance VALUE must be a valid number." });
      } else if (numericValue < 0) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "Attendance VALUE cannot be negative." });
      } else if (Math.abs(numericValue) > 999_999_999_999.9999) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "Attendance VALUE is too large." });
      } else if (Math.abs(numericValue * 10_000 - Math.round(numericValue * 10_000)) > 0.000001) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "Attendance VALUE can have at most four decimal places." });
      } else if (fieldCode === "WORK_HOURS") {
        const maximumHours = effectiveDate && effectiveTo && effectiveTo >= effectiveDate
          ? (dateDifferenceDays(effectiveDate, effectiveTo) + 1) * 24
          : null;
        if (maximumHours !== null && numericValue > maximumHours) {
          issues.push({ rowNumber, dropxId: dropxId || null, message: `WORK_HOURS VALUE cannot exceed ${maximumHours} hours for this inclusive effective range.` });
        } else {
          attendanceBasis = "hours";
          workHours = numericValue;
          workMinutes = Math.round(numericValue * 60);
        }
      } else if (fieldCode === "WORK_DAYS") {
        const maximumDays = effectiveDate && effectiveTo && effectiveTo >= effectiveDate
          ? dateDifferenceDays(effectiveDate, effectiveTo) + 1
          : null;
        if (maximumDays !== null && numericValue > maximumDays) {
          issues.push({ rowNumber, dropxId: dropxId || null, message: `WORK_DAYS VALUE cannot exceed ${maximumDays} days for this inclusive effective range.` });
        } else {
          attendanceBasis = "days";
          workDays = numericValue;
        }
      }
    } else {
      numericValue = finiteNumber(rawValue);
      if (numericValue === null || !Number.isFinite(numericValue)) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "VALUE must be a valid number." });
      } else if (numericValue < 0) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "VALUE cannot be negative." });
      } else if (Math.abs(numericValue) > 999_999_999_999.9999) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "VALUE is too large." });
      } else if (inputType === "DEDUCTION" && Math.abs(numericValue * 100 - Math.round(numericValue * 100)) > 0.000001) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "Deduction VALUE can have at most two decimal places." });
      } else if (Math.abs(numericValue * 10_000 - Math.round(numericValue * 10_000)) > 0.000001) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "VALUE can have at most four decimal places." });
      }
    }

    return [{
      rowNumber,
      action: action || "UPSERT",
      dropxId,
      locationCode,
      inputType,
      fieldCode,
      effectiveDate,
      effectiveFrom,
      effectiveTo,
      numericValue: action === "CLEAR" ? null : numericValue,
      textValue: action === "CLEAR" ? null : textValue,
      attendanceBasis: action === "CLEAR" ? null : attendanceBasis,
      workHours: action === "CLEAR" ? null : workHours,
      workDays: action === "CLEAR" ? null : workDays,
      workMinutes: action === "CLEAR" ? null : workMinutes,
      remark
    }];
  });

  if (!rows.length) throw new Error("The workbook does not contain any payout input rows.");
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (!row.inputType || !row.dropxId || !row.effectiveFrom || !row.effectiveTo) continue;
    const identity = rowIdentity(row);
    const first = seen.get(identity);
    if (first) {
      issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: `This input duplicates row ${first}. Keep one action for each worker, field and effective period.` });
    } else {
      seen.set(identity, row.rowNumber);
    }
  }
  return { rows, issues };
}

function setupCoversDate(setup: WorkforcePayoutImportSetup, date: string, fieldCode?: string) {
  return setup.effectiveFrom <= date
    && (setup.effectiveTo === null || setup.effectiveTo >= date)
    && (!fieldCode || setup.fieldCodes.includes(fieldCode));
}

export function resolveWorkforcePayoutImportRows(
  parsed: ParsedWorkforcePayoutImport,
  references: WorkforcePayoutImportReferences
) {
  const issues: WorkforcePayoutImportIssue[] = [...parsed.issues];
  const workersByCode = new Map<string, WorkforcePayoutImportWorker[]>();
  for (const worker of references.workers) {
    const code = normalizeWorkforcePayoutCode(worker.dropxId);
    if (code) workersByCode.set(code, [...(workersByCode.get(code) ?? []), worker]);
  }
  const paymentFieldsByCode = new Map(references.paymentFields.map((field) => [normalizeWorkforcePayoutCode(field.code), field]));
  const additionalFieldsByCode = new Map(references.additionalFields.map((field) => [normalizeWorkforcePayoutCode(field.code), field]));
  const deductionHeadsByCode = new Map(references.deductionHeads.map((head) => [normalizeWorkforcePayoutCode(head.code), head]));
  const locationsByCode = new Map((references.locations ?? []).map((location) => [normalizeWorkforcePayoutCode(location.code), location]));
  const setupsByWorkforce = new Map<string, WorkforcePayoutImportSetup[]>();
  for (const setup of references.setups) {
    setupsByWorkforce.set(setup.workforceId, [...(setupsByWorkforce.get(setup.workforceId) ?? []), setup]);
  }

  const rows = parsed.rows.map<ResolvedWorkforcePayoutImportRow | null>((row) => {
    const candidates = workersByCode.get(row.dropxId) ?? [];
    if (candidates.length !== 1) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId || null,
        message: candidates.length ? "More than one company Workforce record has this DropX ID." : "No company Workforce record matches this DropX ID."
      });
      return null;
    }
    const worker = candidates[0];
    const workerSetups = setupsByWorkforce.get(worker.id) ?? [];
    const requestedLocation = row.locationCode ? locationsByCode.get(row.locationCode) : null;
    let locationBlocked = false;
    if (row.locationCode && !requestedLocation) {
      issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: `Location ${row.locationCode} does not exist in this company.` });
      locationBlocked = true;
    }
    if (requestedLocation && references.allowedLocationIds && !references.allowedLocationIds.has(requestedLocation.id)) {
      issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "This payout input is outside your location scope." });
      return null;
    }
    if (row.effectiveFrom && worker.dateOfJoin && row.effectiveFrom < worker.dateOfJoin) {
      issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "The input starts before the Workforce joining date." });
    }
    if (row.effectiveTo && worker.lastWorkingDate && row.effectiveTo > worker.lastWorkingDate) {
      issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "The input ends after the Workforce last working date." });
    }
    if (!worker.isActive && !worker.lastWorkingDate) {
      issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "The Workforce member is inactive and has no historical last working date." });
    }

    let paymentFieldId: string | null = null;
    let additionalPaymentFieldId: string | null = null;
    let deductionHeadId: string | null = null;
    let additionalCalculationType: WorkforcePayoutImportAdditionalField["calculationType"] | null = null;
    const matchingSetups: WorkforcePayoutImportSetup[] = [];

    if (row.inputType === "PAYMENT_FIELD_VALUE" || row.inputType === "PRODUCTION_UNITS") {
      const field = paymentFieldsByCode.get(row.fieldCode);
      if (!field || !field.isActive) {
        issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: `Payment field ${row.fieldCode || "(blank)"} is not active for this company.` });
      } else {
        paymentFieldId = field.id;
        if (row.inputType === "PRODUCTION_UNITS" && field.fieldType !== "production") {
          issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: `${field.code} is not configured as a production field.` });
        }
      }

      if (row.effectiveFrom && row.effectiveTo && field) {
        for (const date of datesBetween(row.effectiveFrom, row.effectiveTo)) {
          const dateSetups = workerSetups.filter((setup) => setup.workforceId === worker.id
            && (!requestedLocation || setup.locationId === requestedLocation.id)
            && setupCoversDate(setup, date, field.code));
          if (dateSetups.length !== 1) {
            issues.push({
              rowNumber: row.rowNumber,
              dropxId: row.dropxId,
              message: dateSetups.length
                ? `${field.code} has overlapping payment setups on ${date}. Correct the setup before importing.`
                : `${field.code} is not configured for this worker on ${date}.`
            });
            break;
          }
          if (!matchingSetups.some((setup) => setup === dateSetups[0])) matchingSetups.push(dateSetups[0]);
        }
      }
    } else if (row.inputType === "ADDITIONAL_PAYMENT") {
      const field = additionalFieldsByCode.get(row.fieldCode);
      if (!field || !field.isActive) {
        issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: `Additional payment field ${row.fieldCode || "(blank)"} is not active for this company.` });
      } else {
        additionalPaymentFieldId = field.id;
        additionalCalculationType = field.calculationType;
        if (field.calculationType === "units_x_rate" && field.defaultRateValue === null) {
          issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: `${field.code} requires a default rate before input values can be uploaded.` });
        }
      }
    } else if (row.inputType === "DEDUCTION") {
      const head = deductionHeadsByCode.get(row.fieldCode);
      if (!head) {
        issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: `Deduction head ${row.fieldCode || "(blank)"} does not exist in this company.` });
      } else if (row.action === "UPSERT" && (!head.isActive || head.isSystem || head.calculationType !== "manual")) {
        issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: `Deduction head ${row.fieldCode || "(blank)"} is not an active manual deduction for this company.` });
      } else {
        deductionHeadId = head.id;
      }
    }

    if (row.inputType === "ATTENDANCE" && row.effectiveFrom && row.effectiveTo) {
      matchingSetups.push(...workerSetups.filter((setup) => setup.workforceId === worker.id
        && (!requestedLocation || setup.locationId === requestedLocation.id)
        && overlaps(setup.effectiveFrom, setup.effectiveTo, row.effectiveFrom, row.effectiveTo)));
    }

    const setupLocations = [...new Set(matchingSetups.map((setup) => setup.locationId).filter(Boolean))] as string[];
    // Additional payments are global worker inputs and never depend on a
    // payment-method mapping. An omitted location deliberately follows the
    // Workforce member's current location; an explicit historical location
    // is authorized separately below when any provider/direct setup overlaps.
    let locationId = requestedLocation?.id
      ?? (row.inputType === "ADDITIONAL_PAYMENT" || row.inputType === "DEDUCTION"
        ? worker.locationId
        : (setupLocations.length === 1 ? setupLocations[0] : worker.locationId));
    if (row.inputType !== "ADDITIONAL_PAYMENT" && row.inputType !== "DEDUCTION" && setupLocations.length > 1) {
      issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "This input crosses payment locations. Split it into one row per location period." });
      locationId = null;
    }
    if (!locationId) {
      issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "The Workforce member does not have a resolvable location for this input period." });
      locationBlocked = true;
    } else if (references.allowedLocationIds && !references.allowedLocationIds.has(locationId)) {
      issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "This Workforce member is outside your location scope." });
      locationBlocked = true;
    }
    if (locationId && (row.inputType === "ADDITIONAL_PAYMENT" || row.inputType === "DEDUCTION")) {
      const hasOverlappingHistoricalSetup = workerSetups.some((setup) => setup.locationId === locationId && overlaps(
        setup.effectiveFrom,
        setup.effectiveTo,
        row.effectiveFrom,
        row.effectiveTo
      ));
      if (locationId !== worker.locationId && !hasOverlappingHistoricalSetup) {
        issues.push({
          rowNumber: row.rowNumber,
          dropxId: row.dropxId,
          message: `The ${row.inputType === "DEDUCTION" ? "deduction" : "additional payment"} location must be the Workforce current location or an overlapping historical payment location.`
        });
        locationBlocked = true;
      }
    } else if (locationId && row.inputType === "ATTENDANCE") {
      const assignedAcrossPeriod = datesBetween(row.effectiveFrom, row.effectiveTo).every((date) => {
        const datedLocations = workerSetups
          .filter((setup) => setupCoversDate(setup, date))
          .map((setup) => setup.locationId)
          .filter(Boolean);
        // Current location is a safe fallback only when dated payment history
        // does not assign the person to a different location on that date.
        return datedLocations.length ? datedLocations.includes(locationId) : locationId === worker.locationId;
      });
      if (!assignedAcrossPeriod) {
        issues.push({ rowNumber: row.rowNumber, dropxId: row.dropxId, message: "This Workforce ID is not assigned to the selected location during this payout period." });
        locationBlocked = true;
      }
    }

    // Do not return the database name or any other identity detail for a row
    // outside the caller's authorized/assigned location.
    if (locationBlocked) return null;

    return {
      ...row,
      workforceId: worker.id,
      fullName: worker.fullName,
      locationId: locationId ?? "",
      paymentFieldId,
      additionalPaymentFieldId,
      deductionHeadId,
      additionalCalculationType
    };
  });

  const resolvedRows = rows.filter((row): row is ResolvedWorkforcePayoutImportRow => Boolean(row));
  const seenResolvedInputs = new Map<string, number>();
  for (const row of resolvedRows) {
    const identity = resolvedRowIdentity(row);
    if (!identity) continue;
    const first = seenResolvedInputs.get(identity);
    if (first !== undefined) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `After Workforce, field and location matching, this ${row.inputType} input duplicates row ${first}. Keep one action for each stored payout input.`
      });
    } else {
      seenResolvedInputs.set(identity, row.rowNumber);
    }
  }

  return {
    rows: resolvedRows,
    issues,
    canCommit: issues.length === 0
  };
}

export function payoutImportRowsOverlap(
  left: Pick<ResolvedWorkforcePayoutImportRow, "workforceId" | "locationId" | "inputType" | "paymentFieldId" | "additionalPaymentFieldId" | "deductionHeadId" | "effectiveFrom" | "effectiveTo">,
  right: { workforceId: string; stationId: string | null; fieldId: string; effectiveFrom: string; effectiveTo: string }
) {
  const fieldId = left.paymentFieldId ?? left.additionalPaymentFieldId ?? left.deductionHeadId;
  return left.workforceId === right.workforceId
    && fieldId === right.fieldId
    && (left.inputType !== "PAYMENT_FIELD_VALUE" || left.locationId === right.stationId)
    && overlaps(left.effectiveFrom, left.effectiveTo, right.effectiveFrom, right.effectiveTo);
}

export function buildWorkforcePayoutImportTemplate(
  fields: WorkforcePayoutImportTemplateField[],
  options: { effectiveFrom?: string; effectiveTo?: string; locations?: Array<{ code: string }> } = {}
) {
  const headers = ["ACTION", "DROPX_ID", "LOCATION", "INPUT_TYPE", "FIELD_CODE", "EFFECTIVE_DATE", "EFFECTIVE_TO", "VALUE", "REMARK"];
  const columnWidths = [12, 24, 16, 24, 24, 18, 18, 18, 42].map((wch) => ({ wch }));
  const upload = XLSX.utils.aoa_to_sheet([headers]);
  upload["!cols"] = columnWidths;
  upload["!autofilter"] = { ref: `A1:I1` };

  const referenceRows = [
    ["FIELD_CODE", "LABEL", "INPUT_TYPE", "CALCULATION", "VALUE MEANING"],
    ["WORK_HOURS", "Work hours", "ATTENDANCE", "Range quantity", "Total attendance hours for the effective range"],
    ["WORK_DAYS", "Work days", "ATTENDANCE", "Range quantity", "Total attendance days for the effective range"],
    ...fields.map((field) => [field.code, field.label, field.inputType, field.calculation, field.valueMeaning])
  ];
  const reference = XLSX.utils.aoa_to_sheet(referenceRows);
  reference["!cols"] = [24, 34, 24, 26, 62].map((wch) => ({ wch }));
  reference["!autofilter"] = { ref: `A1:E${Math.max(1, referenceRows.length)}` };

  const dateHint = options.effectiveFrom && options.effectiveTo
    ? `This template was downloaded for ${displaySpreadsheetDate(options.effectiveFrom)} to ${displaySpreadsheetDate(options.effectiveTo)}. Every row needs EFFECTIVE_DATE and EFFECTIVE_TO inside that selected payout period.`
    : "Every Excel row needs EFFECTIVE_DATE and EFFECTIVE_TO inside the payout period selected on the worksheet page.";
  const instructions = XLSX.utils.aoa_to_sheet([
    ["WORKFORCE PAYOUT BULK UPLOAD"],
    [dateHint],
    ["Replacement scope", "Each UPSERT or CLEAR row changes only the matching stored input: the same Workforce person, input type or field, date or period, and location where applicable. Inputs not represented by an uploaded row remain unchanged. For example, a DELIVERY row, when DELIVERY is enabled for upload, does not replace attendance, additions, or other production fields."],
    ["ACTION", "Use UPSERT to create or replace the matching input. Use CLEAR with a blank VALUE to remove only that matching input."],
    ["EFFECTIVE_DATE / EFFECTIVE_TO", "Both dates are compulsory. EFFECTIVE_DATE is the start date and EFFECTIVE_TO is the end date. Enter each as DD-MM-YYYY or DD/MM/YYYY. EFFECTIVE_TO cannot be earlier than EFFECTIVE_DATE, and both dates must be inside the selected payout period."],
    ["ATTENDANCE", "Set FIELD_CODE to WORK_HOURS or WORK_DAYS and enter the total quantity for the effective range in VALUE. Use WORK_HOURS for hourly attendance pay and WORK_DAYS for daily or monthly attendance pay. The upload rejects a unit that does not match the person's payment setup."],
    ["PRODUCTION_UNITS", "Use a production FIELD_CODE from Field Reference. Production is stored per work date, so enter the same date in EFFECTIVE_DATE and EFFECTIVE_TO. VALUE replaces only that field for that person, location and date; provider-reported values remain the fallback when no override exists."],
    ["PAYMENT_FIELD_VALUE", "Use a FIELD_CODE from Field Reference. VALUE overrides that configured rate or input for the entered effective range; it is not a final payout amount."],
    ["ADDITIONAL_PAYMENT", "Use a FIELD_CODE from Field Reference. VALUE is applied once to the complete payout period selected on the worksheet page."],
    ["DEDUCTION", "Use an active manual deduction FIELD_CODE from Field Reference. VALUE is applied once to the complete selected payout period and may have at most two decimal places. Automatic fixed, percentage and system deductions cannot be uploaded or replaced."],
    ["Important", "Zero is a real value. A blank value is not zero. Formula cells and negative values are rejected."],
    ["Matching", "People are matched only by the company Workforce DROPX_ID. LOCATION is optional. ADDITIONAL_PAYMENT and DEDUCTION default to the Workforce current location; an explicit location must be current or overlap a historical provider/direct setup. Setup-based inputs may require LOCATION when the same ID has simultaneous payment setups."]
  ]);
  instructions["!cols"] = [{ wch: 24 }, { wch: 110 }];

  const exampleDate = displaySpreadsheetDate(options.effectiveFrom ?? "");
  const exampleTo = displaySpreadsheetDate(options.effectiveTo ?? options.effectiveFrom ?? "");
  const exampleLocation = options.locations?.[0]?.code ?? "";
  const exampleRows: Array<Array<string | number>> = [
    ["EXAMPLES ONLY - copy a row to Upload, then replace the sample ID, dates, location, field code and value. Do not upload this sheet."],
    headers,
    ["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "ATTENDANCE", "WORK_HOURS", exampleDate, exampleTo, 30, "Thirty attendance hours for the effective range"],
    ["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "ATTENDANCE", "WORK_DAYS", exampleDate, exampleTo, 5, "Five attendance days for the effective range"]
  ];
  const productionField = fields.find((field) => field.inputType === "PRODUCTION_UNITS");
  if (productionField) {
    exampleRows.push(["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "PRODUCTION_UNITS", productionField.code, exampleDate, exampleDate, 10, `${productionField.label} units for one work date`]);
  }
  const paymentField = fields.find((field) => field.inputType === "PAYMENT_FIELD_VALUE");
  if (paymentField) {
    exampleRows.push(["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "PAYMENT_FIELD_VALUE", paymentField.code, exampleDate, exampleTo, 100, `${paymentField.label} configured input override`]);
  }
  const additionalField = fields.find((field) => field.inputType === "ADDITIONAL_PAYMENT");
  if (additionalField) {
    exampleRows.push(["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "ADDITIONAL_PAYMENT", additionalField.code, exampleDate, exampleTo, 500, `${additionalField.label} for the effective range`]);
  }
  const deductionField = fields.find((field) => field.inputType === "DEDUCTION");
  if (deductionField) {
    exampleRows.push(["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "DEDUCTION", deductionField.code, exampleDate, exampleTo, 250, `${deductionField.label} for the effective range`]);
  }
  const examples = XLSX.utils.aoa_to_sheet(exampleRows);
  examples["!cols"] = columnWidths;
  examples["!autofilter"] = { ref: `A2:I${exampleRows.length}` };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, upload, "Upload");
  XLSX.utils.book_append_sheet(workbook, reference, "Field Reference");
  const locationRows = [["LOCATION"], ...(options.locations ?? []).map((location) => [location.code])];
  const locations = XLSX.utils.aoa_to_sheet(locationRows);
  locations["!cols"] = [{ wch: 24 }];
  locations["!autofilter"] = { ref: `A1:A${Math.max(1, locationRows.length)}` };
  XLSX.utils.book_append_sheet(workbook, locations, "Locations");
  XLSX.utils.book_append_sheet(workbook, examples, "Examples");
  XLSX.utils.book_append_sheet(workbook, instructions, "Instructions");
  return new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}
