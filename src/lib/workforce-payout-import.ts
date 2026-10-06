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
  effectiveFrom: string;
  effectiveTo: string;
  numericValue: number | null;
  textValue: string | null;
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
  "effectivefrom",
  "effectiveto",
  "value",
  "workminutes",
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

function spreadsheetDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? formatDate(parsed.y, parsed.m, parsed.d) : "";
  }
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (isValidWorkforcePayoutDate(text)) return text;
  const match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  return match ? formatDate(Number(match[3]), Number(match[2]), Number(match[1])) : "";
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

function attendanceStatus(value: unknown): WorkforcePayoutAttendanceStatus | null {
  const normalized = normalizeWorkforcePayoutCode(value).replace(/[^A-Z0-9]+/g, "_");
  if (normalized === "P" || normalized === "PRESENT") return "P";
  if (normalized === "HD" || normalized === "HALF_DAY" || normalized === "HALFDAY") return "HD";
  if (normalized === "A" || normalized === "ABSENT") return "A";
  return null;
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
  return [row.inputType, row.dropxId, stationIdentity, row.fieldCode, row.effectiveFrom, row.effectiveTo].join("|");
}

function resolvedRowIdentity(row: ResolvedWorkforcePayoutImportRow) {
  if (!row.workforceId || !row.effectiveFrom || !row.effectiveTo) return null;
  if (row.inputType === "ATTENDANCE") {
    // Attendance is owned by the worker/date. Station is provenance and must
    // not allow two actions to target the same stored attendance override.
    return [row.inputType, row.workforceId, row.effectiveFrom].join("|");
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
      ? [row.inputType, row.workforceId, row.locationId, row.paymentFieldId, row.effectiveFrom].join("|")
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
  for (const field of ["dropxid", "inputtype", "fieldcode", "effectivefrom", "effectiveto", "value"] as const) {
    const index = normalized.indexOf(field);
    if (index < 0) throw new Error(`Required column “${field.replace(/([a-z])([A-Z])/g, "$1 $2")}” is missing.`);
    result[field] = index;
  }
  for (const field of ["action", "location", "workminutes", "remark"] as const) result[field] = normalized.indexOf(field);
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
    const effectiveFrom = spreadsheetDate(source[columns.effectivefrom]);
    const effectiveTo = spreadsheetDate(source[columns.effectiveto]);
    const rawValue = source[columns.value];
    const rawMinutes = columns.workminutes >= 0 ? source[columns.workminutes] : "";
    const remark = columns.remark >= 0 ? String(formatted[columns.remark] ?? "").trim().slice(0, 500) : "";
    let numericValue: number | null = null;
    let textValue: string | null = null;
    const workMinutes = finiteNumber(rawMinutes);

    if (!dropxId) issues.push({ rowNumber, dropxId: null, message: "DropX ID is required." });
    if (!action) issues.push({ rowNumber, dropxId: dropxId || null, message: "ACTION must be UPSERT or CLEAR." });
    if (!inputType) issues.push({ rowNumber, dropxId: dropxId || null, message: "INPUT_TYPE is not supported." });
    if (!effectiveFrom || !effectiveTo) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "Effective From and Effective To must be valid spreadsheet dates." });
    } else {
      if (effectiveTo < effectiveFrom) issues.push({ rowNumber, dropxId: dropxId || null, message: "Effective To cannot be before Effective From." });
      if (effectiveFrom < options.batchFrom || effectiveTo > options.batchTo) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: `Dates must fall within the selected ${options.batchFrom} to ${options.batchTo} import period.` });
      }
    }
    if (formulaRows.has(rowNumber)) issues.push({ rowNumber, dropxId: dropxId || null, message: "Formula cells are not accepted. Paste their values before uploading." });

    if (action === "CLEAR") {
      if (String(rawValue ?? "").trim() || String(rawMinutes ?? "").trim()) {
        issues.push({ rowNumber, dropxId: dropxId || null, message: "CLEAR rows must leave VALUE and WORK_MINUTES blank." });
      }
    } else if (inputType === "ATTENDANCE") {
      textValue = attendanceStatus(rawValue);
      if (!textValue) issues.push({ rowNumber, dropxId: dropxId || null, message: "Attendance VALUE must be P, HD or A." });
      if (fieldCode) issues.push({ rowNumber, dropxId: dropxId || null, message: "Attendance rows must leave FIELD_CODE blank." });
    } else {
      numericValue = finiteNumber(rawValue);
      if (!fieldCode) issues.push({ rowNumber, dropxId: dropxId || null, message: "FIELD_CODE is required for this input type." });
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

    if (workMinutes !== null && (!Number.isInteger(workMinutes) || workMinutes < 0 || workMinutes > 1_440)) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "WORK_MINUTES must be a whole number from 0 to 1440." });
    }
    if (inputType !== "ATTENDANCE" && workMinutes !== null) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "WORK_MINUTES is only valid for attendance rows." });
    }
    if (inputType === "ATTENDANCE" && textValue === "A" && workMinutes !== null && workMinutes !== 0) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: "Absent attendance cannot contain work minutes." });
    }
    if ((inputType === "ATTENDANCE" || inputType === "PRODUCTION_UNITS") && effectiveFrom && effectiveTo && effectiveFrom !== effectiveTo) {
      issues.push({ rowNumber, dropxId: dropxId || null, message: `${inputType === "ATTENDANCE" ? "Attendance" : "Production units"} must be supplied one work date per row.` });
    }
    if ((inputType === "ADDITIONAL_PAYMENT" || inputType === "DEDUCTION") && effectiveFrom && effectiveTo && (effectiveFrom !== options.batchFrom || effectiveTo !== options.batchTo)) {
      issues.push({
        rowNumber,
        dropxId: dropxId || null,
        message: `${inputType === "DEDUCTION" ? "A deduction" : "An additional payment"} must use the exact selected payout period.`
      });
    }

    return [{
      rowNumber,
      action: action || "UPSERT",
      dropxId,
      locationCode,
      inputType,
      fieldCode,
      effectiveFrom,
      effectiveTo,
      numericValue: action === "CLEAR" ? null : numericValue,
      textValue: action === "CLEAR" ? null : textValue,
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

    if (row.inputType === "ATTENDANCE" && row.effectiveFrom) {
      matchingSetups.push(...workerSetups.filter((setup) => setup.workforceId === worker.id
        && (!requestedLocation || setup.locationId === requestedLocation.id)
        && setupCoversDate(setup, row.effectiveFrom)));
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
      const periodSetups = workerSetups.filter((setup) => overlaps(
        setup.effectiveFrom,
        setup.effectiveTo,
        row.effectiveFrom,
        row.effectiveTo
      ));
      const assignedAtLocation = periodSetups.some((setup) => setup.locationId === locationId);
      const assignedElsewhere = periodSetups.some((setup) => Boolean(setup.locationId) && setup.locationId !== locationId);
      // Current location is a safe fallback only when no dated payment history
      // assigns the person elsewhere in the requested period.
      if (!assignedAtLocation && (locationId !== worker.locationId || assignedElsewhere)) {
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
  const headers = ["ACTION", "DROPX_ID", "LOCATION", "INPUT_TYPE", "FIELD_CODE", "EFFECTIVE_FROM", "EFFECTIVE_TO", "VALUE", "WORK_MINUTES", "REMARK"];
  const columnWidths = [12, 24, 16, 24, 24, 16, 16, 18, 16, 42].map((wch) => ({ wch }));
  const upload = XLSX.utils.aoa_to_sheet([headers]);
  upload["!cols"] = columnWidths;
  upload["!autofilter"] = { ref: `A1:J1` };

  const referenceRows = [
    ["FIELD_CODE", "LABEL", "INPUT_TYPE", "CALCULATION", "VALUE MEANING"],
    ...fields.map((field) => [field.code, field.label, field.inputType, field.calculation, field.valueMeaning])
  ];
  const reference = XLSX.utils.aoa_to_sheet(referenceRows);
  reference["!cols"] = [24, 34, 24, 26, 62].map((wch) => ({ wch }));
  reference["!autofilter"] = { ref: `A1:E${Math.max(1, referenceRows.length)}` };

  const dateHint = options.effectiveFrom && options.effectiveTo
    ? `This template was downloaded for ${options.effectiveFrom} to ${options.effectiveTo}. These dates are the inclusive allowed upload window; every row still needs its own dates inside that window.`
    : "Effective from and Effective to on the payout page set the inclusive allowed upload window. Every Excel row still needs its own dates inside that window.";
  const instructions = XLSX.utils.aoa_to_sheet([
    ["WORKFORCE PAYOUT BULK UPLOAD"],
    [dateHint],
    ["Replacement scope", "Each UPSERT or CLEAR row changes only the matching stored input: the same Workforce person, input type or field, date or period, and location where applicable. Inputs not represented by an uploaded row remain unchanged. For example, a DELIVERY row, when DELIVERY is enabled for upload, does not replace attendance, additions, or other production fields."],
    ["ACTION", "Use UPSERT to create or replace the matching input. Use CLEAR with blank VALUE and WORK_MINUTES to remove only that matching input."],
    ["EFFECTIVE_FROM / EFFECTIVE_TO", "These are row dates, not values copied automatically from the page. Attendance and production use one work date, so enter the same date in both columns. Configured field values may use an interval inside the selected window. Additional payments and deductions use the exact selected payout period."],
    ["WORK_MINUTES", "Optional attendance-only field containing the payable work minutes used for attendance and hourly calculations on that date. Enter a whole number from 0 to 1440. Leave blank to keep existing biometric minutes, if available. An absent day must be blank or 0."],
    ["ATTENDANCE", "Leave FIELD_CODE blank. Use one date per row, enter that same date in both date columns, and set VALUE to P (present), HD (half day), or A (absent). See the Examples sheet."],
    ["PRODUCTION_UNITS", "Use one date per row and a production FIELD_CODE from Field Reference. The uploaded value replaces only that field for that person, location and date; provider-reported values remain the fallback when no override exists."],
    ["PAYMENT_FIELD_VALUE", "Use a FIELD_CODE from Field Reference. VALUE overrides that configured rate/input for the row interval; it is not a final payout amount."],
    ["ADDITIONAL_PAYMENT", "Use a FIELD_CODE from Field Reference. The row dates must exactly match the selected payout period. VALUE is applied once for that period."],
    ["DEDUCTION", "Use an active manual deduction FIELD_CODE from Field Reference. The row dates must exactly match the selected payout period, and VALUE may have at most two decimal places. Automatic fixed, percentage and system deductions cannot be uploaded or replaced."],
    ["Important", "Zero is a real value. A blank value is not zero. Formula cells and negative values are rejected."],
    ["Matching", "People are matched only by the company Workforce DROPX_ID. LOCATION is optional. ADDITIONAL_PAYMENT and DEDUCTION default to the Workforce current location; an explicit location must be current or overlap a historical provider/direct setup. Setup-based inputs may require LOCATION when the same ID has simultaneous payment setups."]
  ]);
  instructions["!cols"] = [{ wch: 24 }, { wch: 110 }];

  const exampleFrom = options.effectiveFrom ?? "YYYY-MM-DD";
  const exampleTo = options.effectiveTo ?? "YYYY-MM-DD";
  const exampleLocation = options.locations?.[0]?.code ?? "";
  const exampleRows: Array<Array<string | number>> = [
    ["EXAMPLES ONLY - copy a row to Upload, then replace the sample ID, dates, location, field code and value. Do not upload this sheet."],
    headers,
    ["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "ATTENDANCE", "", exampleFrom, exampleFrom, "HD", 240, "Half day with 240 actual work minutes"]
  ];
  const productionField = fields.find((field) => field.inputType === "PRODUCTION_UNITS");
  if (productionField) {
    exampleRows.push(["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "PRODUCTION_UNITS", productionField.code, exampleFrom, exampleFrom, 10, "", `${productionField.label} units for one work date`]);
  }
  const paymentField = fields.find((field) => field.inputType === "PAYMENT_FIELD_VALUE");
  if (paymentField) {
    exampleRows.push(["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "PAYMENT_FIELD_VALUE", paymentField.code, exampleFrom, exampleTo, 100, "", `${paymentField.label} configured input override`]);
  }
  const additionalField = fields.find((field) => field.inputType === "ADDITIONAL_PAYMENT");
  if (additionalField) {
    exampleRows.push(["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "ADDITIONAL_PAYMENT", additionalField.code, exampleFrom, exampleTo, 500, "", `${additionalField.label} for the exact payout period`]);
  }
  const deductionField = fields.find((field) => field.inputType === "DEDUCTION");
  if (deductionField) {
    exampleRows.push(["UPSERT", "REPLACE_WITH_DROPX_ID", exampleLocation, "DEDUCTION", deductionField.code, exampleFrom, exampleTo, 250, "", `${deductionField.label} for the exact payout period`]);
  }
  const examples = XLSX.utils.aoa_to_sheet(exampleRows);
  examples["!cols"] = columnWidths;
  examples["!autofilter"] = { ref: `A2:J${exampleRows.length}` };

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
