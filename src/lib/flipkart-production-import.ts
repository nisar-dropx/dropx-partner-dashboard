export const FLIPKART_RUNSHEET = "BP_RUNSHEET" as const;
export const FLIPKART_PICKUPSHEET = "BP_PICKUPSHEET" as const;

export type FlipkartSheetType = typeof FLIPKART_RUNSHEET | typeof FLIPKART_PICKUPSHEET;
export type FlipkartProductionMetric = "delivery" | "customer_return";

export type FlipkartProductionIssue = {
  field: string;
  message: string;
  rowNumber: number;
};

export type FlipkartProductionRow = {
  assigned: number;
  completed: number;
  metric: FlipkartProductionMetric;
  providerEmployeeId: string;
  providerEmployeeName: string | null;
  rowNumber: number;
  sheetId: string;
  sheetType: FlipkartSheetType;
  sourceId: string | null;
  stationCode: string;
  updatedAt: string;
  workDate: string;
};

export type FlipkartDailyProduction = {
  assignedCount: number;
  customerReturn: number;
  delivery: number;
  providerEmployeeId: string;
  providerEmployeeName: string | null;
  rawRowCount: number;
  sheetIds: string[];
  sheetTypes: FlipkartSheetType[];
  sourceRowNumbers: number[];
  stationCode: string;
  totalActivity: number;
  workDate: string;
};

export type FlipkartImportCycle = {
  cycle: 1 | 2;
  endDate: string;
  key: string;
  month: number;
  observedEndDate: string;
  observedStartDate: string;
  startDate: string;
  year: number;
};

export type FlipkartProductionParseResult = {
  cycle: FlipkartImportCycle;
  daily: FlipkartDailyProduction[];
  deduplicatedRowCount: number;
  headerRowNumber: number;
  issues: FlipkartProductionIssue[];
  rows: FlipkartProductionRow[];
};

export type ParseFlipkartProductionOptions = {
  allowedStationCodes?: readonly string[];
  expectedVendorNames?: readonly string[];
  maxHeaderScanRows?: number;
  rejectInvalidRows?: boolean;
  requireBothSheetTypes?: boolean;
  requireCompleteCycle?: boolean;
};

type HeaderField =
  | "assigned"
  | "completed"
  | "createdAt"
  | "hubName"
  | "providerId"
  | "providerName"
  | "sheetId"
  | "sheetType"
  | "sourceId"
  | "updatedAt"
  | "vendorName";

type HeaderIndexes = Partial<Record<HeaderField, number>>;

type ParsedCandidate = FlipkartProductionRow & {
  updatedAtMs: number;
};

const HEADER_ALIASES: Record<HeaderField, readonly string[]> = {
  assigned: ["assigned", "assigned_count", "assigned count"],
  completed: ["completed", "completed_count", "completed count"],
  createdAt: [
    "sheet_create_date_time",
    "sheet create date time",
    "sheet_created_at",
    "sheet created at",
    "created_at",
    "created at"
  ],
  hubName: ["hub_name", "hub name", "hub", "station", "station name"],
  providerId: [
    "casper_employee_id",
    "casper employee id",
    "casper id",
    "provider_employee_id",
    "provider employee id",
    "provider id"
  ],
  providerName: ["agent_name", "agent name", "provider_employee_name", "provider employee name", "employee name"],
  sheetId: ["sheet_id", "sheet id", "sheetid"],
  sheetType: ["sheet_type", "sheet type", "sheettype"],
  sourceId: ["id", "row_id", "row id", "record_id", "record id"],
  updatedAt: [
    "sheet_update_date_time",
    "sheet update date time",
    "sheet_updated_at",
    "sheet updated at",
    "updated_at",
    "updated at"
  ],
  vendorName: ["ODH Vendor", "odh_vendor", "vendor_name", "vendor name"]
};

const REQUIRED_HEADERS: readonly HeaderField[] = [
  "providerId",
  "createdAt",
  "updatedAt",
  "sheetId",
  "sheetType",
  "hubName",
  "completed",
  "assigned"
];

function clean(value: unknown) {
  return String(value ?? "").trim().replace(/^'+/, "").replace(/'+$/, "");
}

function headerKey(value: unknown) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeStation(value: unknown) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function vendorKey(value: unknown) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function validUtcDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function dateText(year: number, month: number, day: number) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function excelSerialMilliseconds(serial: number) {
  if (!Number.isFinite(serial) || serial <= 20_000 || serial >= 80_000) return null;
  return Date.UTC(1899, 11, 30) + serial * 24 * 60 * 60 * 1000;
}

function parseCalendarDate(value: unknown) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // SheetJS represents a date-only Excel cell as a Date and may shift its UTC
    // value by the workbook timezone (for India, just before the prior UTC day
    // ends). The create column is a business date, so recover its nearest day.
    const day = 24 * 60 * 60 * 1000;
    return new Date(Math.round(value.getTime() / day) * day).toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    const milliseconds = excelSerialMilliseconds(value);
    return milliseconds === null ? null : new Date(milliseconds).toISOString().slice(0, 10);
  }
  const text = clean(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\D|$)/);
  if (iso) {
    const [, yearText, monthText, dayText] = iso;
    const [year, month, day] = [Number(yearText), Number(monthText), Number(dayText)];
    return validUtcDate(year, month, day) ? dateText(year, month, day) : null;
  }
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:\D|$)/);
  if (!dmy) return null;
  const year = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
  const month = Number(dmy[2]);
  const day = Number(dmy[1]);
  return validUtcDate(year, month, day) ? dateText(year, month, day) : null;
}

function parseTimestampMilliseconds(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return excelSerialMilliseconds(value);
  const text = clean(value);
  if (!text) return null;

  const datePart = parseCalendarDate(text);
  if (!datePart) return null;
  const time = text.match(/(?:T|\s)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/);
  const timezone = text.match(/(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (timezone) {
    const parsed = Date.parse(text.replace(" ", "T"));
    if (!Number.isNaN(parsed)) return parsed;
  }
  const [year, month, day] = datePart.split("-").map(Number);
  const hour = Number(time?.[1] ?? 0);
  const minute = Number(time?.[2] ?? 0);
  const second = Number(time?.[3] ?? 0);
  const millisecond = Number((time?.[4] ?? "0").padEnd(3, "0"));
  if (hour > 23 || minute > 59 || second > 59) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
}

function parseNonNegativeInteger(value: unknown, blankValue: number | null = null) {
  const text = clean(value).replace(/,/g, "");
  if (!text) return blankValue;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeIdentity(value: unknown) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  const text = clean(value);
  if (!text || /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(text)) return null;
  if (/^-\d/.test(text) || /^\d+\.\d+$/.test(text) && !/^\d+\.0+$/.test(text)) return null;
  if (/^\d+\.0+$/.test(text)) return text.replace(/\.0+$/, "");
  return text;
}

export function normalizeFlipkartProviderId(value: unknown) {
  return normalizeIdentity(value);
}

export function flipkartMetricForSheetType(value: unknown): FlipkartProductionMetric | null {
  const normalized = clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (normalized === FLIPKART_RUNSHEET) return "delivery";
  if (normalized === FLIPKART_PICKUPSHEET) return "customer_return";
  return null;
}

export function stationCodeFromFlipkartHub(value: unknown, allowedStationCodes: readonly string[] = []) {
  const text = clean(value).toUpperCase();
  if (!text) return null;
  const suffix = normalizeStation(text.includes("_") ? text.slice(text.lastIndexOf("_") + 1) : text);
  if (!suffix) return null;
  if (!allowedStationCodes.length) return suffix;
  const allowed = new Map(allowedStationCodes.map((code) => [normalizeStation(code), normalizeStation(code)]));
  return allowed.get(suffix) ?? null;
}

function headerIndexes(row: readonly unknown[]): HeaderIndexes {
  const keys = row.map(headerKey);
  const indexes: HeaderIndexes = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<[HeaderField, readonly string[]]>) {
    const accepted = new Set(aliases.map(headerKey));
    const index = keys.findIndex((candidate) => accepted.has(candidate));
    if (index >= 0) indexes[field] = index;
  }
  return indexes;
}

function locateHeader(rows: readonly (readonly unknown[])[], maxHeaderScanRows: number) {
  let best: { indexes: HeaderIndexes; matchCount: number; rowIndex: number } | null = null;
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, maxHeaderScanRows); rowIndex += 1) {
    const indexes = headerIndexes(rows[rowIndex]);
    const matchCount = REQUIRED_HEADERS.filter((field) => indexes[field] !== undefined).length;
    if (!best || matchCount > best.matchCount) best = { indexes, matchCount, rowIndex };
    if (matchCount === REQUIRED_HEADERS.length) return { indexes, rowIndex };
  }
  const missing = REQUIRED_HEADERS.filter((field) => best?.indexes[field] === undefined)
    .map((field) => HEADER_ALIASES[field][0]);
  throw new Error(`Flipkart production file is missing required columns: ${missing.join(", ")}.`);
}

function rowValue(row: readonly unknown[], indexes: HeaderIndexes, field: HeaderField) {
  const index = indexes[field];
  return index === undefined ? undefined : row[index];
}

function isBlankRow(row: readonly unknown[]) {
  return row.every((value) => clean(value) === "");
}

function publicRow(row: ParsedCandidate): FlipkartProductionRow {
  const { updatedAtMs: _updatedAtMs, ...result } = row;
  return result;
}

export function validateFlipkartImportCycle(workDates: readonly string[]): FlipkartImportCycle {
  if (!workDates.length) throw new Error("The Flipkart production file does not contain any valid production rows.");
  const uniqueDates = Array.from(new Set(workDates)).sort();
  const cycleKeys = new Set<string>();
  for (const workDate of uniqueDates) {
    const match = workDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new Error(`Invalid Flipkart production date “${workDate}”.`);
    const [, yearText, monthText, dayText] = match;
    const cycle = Number(dayText) <= 15 ? 1 : 2;
    cycleKeys.add(`${yearText}-${monthText}-H${cycle}`);
  }
  if (cycleKeys.size !== 1) {
    throw new Error(
      "A Flipkart production file must contain one cycle only: either days 1–15 or days 16–month end of one month."
    );
  }
  const key = Array.from(cycleKeys)[0];
  const match = key.match(/^(\d{4})-(\d{2})-H([12])$/)!;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const cycle = Number(match[3]) as 1 | 2;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    cycle,
    endDate: dateText(year, month, cycle === 1 ? 15 : lastDay),
    key,
    month,
    observedEndDate: uniqueDates[uniqueDates.length - 1],
    observedStartDate: uniqueDates[0],
    startDate: dateText(year, month, cycle === 1 ? 1 : 16),
    year
  };
}

export function aggregateFlipkartDailyProduction(rows: readonly FlipkartProductionRow[]): FlipkartDailyProduction[] {
  const daily = new Map<string, FlipkartDailyProduction>();
  for (const row of rows) {
    const key = `${row.workDate}\u001f${row.stationCode}\u001f${row.providerEmployeeId}`;
    const current = daily.get(key) ?? {
      assignedCount: 0,
      customerReturn: 0,
      delivery: 0,
      providerEmployeeId: row.providerEmployeeId,
      providerEmployeeName: row.providerEmployeeName,
      rawRowCount: 0,
      sheetIds: [],
      sheetTypes: [],
      sourceRowNumbers: [],
      stationCode: row.stationCode,
      totalActivity: 0,
      workDate: row.workDate
    };
    current.assignedCount += row.assigned;
    if (row.metric === "delivery") current.delivery += row.completed;
    else current.customerReturn += row.completed;
    current.totalActivity = current.delivery + current.customerReturn;
    current.rawRowCount += 1;
    current.sheetIds.push(row.sheetId);
    if (!current.sheetTypes.includes(row.sheetType)) current.sheetTypes.push(row.sheetType);
    current.sourceRowNumbers.push(row.rowNumber);
    if (row.providerEmployeeName) current.providerEmployeeName = row.providerEmployeeName;
    daily.set(key, current);
  }
  return Array.from(daily.values()).sort((left, right) =>
    left.workDate.localeCompare(right.workDate)
      || left.stationCode.localeCompare(right.stationCode)
      || left.providerEmployeeId.localeCompare(right.providerEmployeeId)
  );
}

export function parseFlipkartProductionMatrix(
  rows: readonly (readonly unknown[])[],
  options: ParseFlipkartProductionOptions = {}
): FlipkartProductionParseResult {
  const { indexes, rowIndex: headerIndex } = locateHeader(rows, options.maxHeaderScanRows ?? 25);
  const issues: FlipkartProductionIssue[] = [];
  const parsed: ParsedCandidate[] = [];
  const expectedVendorKeys = new Set((options.expectedVendorNames ?? []).map(vendorKey).filter(Boolean));

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (isBlankRow(row)) continue;
    const rowNumber = index + 1;
    const rowIssues: FlipkartProductionIssue[] = [];
    const providerEmployeeId = normalizeFlipkartProviderId(rowValue(row, indexes, "providerId"));
    const sheetId = normalizeIdentity(rowValue(row, indexes, "sheetId"));
    const workDate = parseCalendarDate(rowValue(row, indexes, "createdAt"));
    const updatedAtMs = parseTimestampMilliseconds(rowValue(row, indexes, "updatedAt"));
    const metric = flipkartMetricForSheetType(rowValue(row, indexes, "sheetType"));
    const stationCode = stationCodeFromFlipkartHub(
      rowValue(row, indexes, "hubName"),
      options.allowedStationCodes
    );
    const completed = parseNonNegativeInteger(rowValue(row, indexes, "completed"));
    // Blank cells are invalid once the Assigned column is present; explicit 0 is allowed.
    const assigned = parseNonNegativeInteger(rowValue(row, indexes, "assigned"));
    const vendorName = clean(rowValue(row, indexes, "vendorName"));

    if (!providerEmployeeId) rowIssues.push({ field: "casper_employee_id", message: "Casper employee ID must be stored as safe text or an integer.", rowNumber });
    if (!sheetId) rowIssues.push({ field: "sheet_id", message: "Sheet ID is required and must be stored safely.", rowNumber });
    if (!workDate) rowIssues.push({ field: "sheet_create_date_time", message: "Sheet create date is invalid.", rowNumber });
    if (updatedAtMs === null) rowIssues.push({ field: "sheet_update_date_time", message: "Sheet update date and time is invalid.", rowNumber });
    if (!metric) rowIssues.push({ field: "sheet_type", message: "Sheet type must be BP_RUNSHEET or BP_PICKUPSHEET.", rowNumber });
    if (!stationCode) rowIssues.push({ field: "hub_name", message: "Hub name does not end with a permitted station code.", rowNumber });
    if (completed === null) rowIssues.push({ field: "completed", message: "Completed must be a non-negative whole number.", rowNumber });
    if (assigned === null) rowIssues.push({ field: "assigned", message: "Assigned must be a non-negative whole number (use 0 when none were assigned).", rowNumber });
    if (expectedVendorKeys.size && !expectedVendorKeys.has(vendorKey(vendorName))) {
      rowIssues.push({
        field: "ODH Vendor",
        message: `ODH Vendor must match ${Array.from(options.expectedVendorNames ?? []).join(" or ")}.`,
        rowNumber
      });
    }
    if (rowIssues.length) {
      issues.push(...rowIssues);
      continue;
    }

    const sheetType = metric === "delivery" ? FLIPKART_RUNSHEET : FLIPKART_PICKUPSHEET;
    parsed.push({
      assigned: assigned!,
      completed: completed!,
      metric: metric!,
      providerEmployeeId: providerEmployeeId!,
      providerEmployeeName: clean(rowValue(row, indexes, "providerName")) || null,
      rowNumber,
      sheetId: sheetId!,
      sheetType,
      sourceId: normalizeIdentity(rowValue(row, indexes, "sourceId")),
      stationCode: stationCode!,
      updatedAt: new Date(updatedAtMs!).toISOString(),
      updatedAtMs: updatedAtMs!,
      workDate: workDate!
    });
  }

  const newest = new Map<string, ParsedCandidate>();
  for (const row of parsed) {
    // sheet_id is the stable source identity. Flipkart can correct the worker or
    // sheet type on a later revision, so those mutable fields must not split one
    // source sheet into two payable rows.
    const dedupeKey = row.sheetId;
    const current = newest.get(dedupeKey);
    if (!current || row.updatedAtMs > current.updatedAtMs || (row.updatedAtMs === current.updatedAtMs && row.rowNumber > current.rowNumber)) {
      newest.set(dedupeKey, row);
    }
  }
  const selected = Array.from(newest.values()).sort((left, right) => left.rowNumber - right.rowNumber);
  const publicRows = selected.map(publicRow);
  if (options.rejectInvalidRows && issues.length) {
    const invalidRowCount = new Set(issues.map((issue) => issue.rowNumber)).size;
    const first = issues[0];
    throw new Error(
      `Flipkart production file has ${invalidRowCount} invalid row${invalidRowCount === 1 ? "" : "s"}. `
      + `First issue: row ${first.rowNumber}, ${first.message} Fix the file and upload the complete cycle again.`
    );
  }
  if (options.requireBothSheetTypes) {
    const sheetTypesByStation = new Map<string, Set<string>>();
    publicRows.forEach((row) => {
      const present = sheetTypesByStation.get(row.stationCode) ?? new Set<string>();
      present.add(row.sheetType);
      sheetTypesByStation.set(row.stationCode, present);
    });
    const incompleteStations = Array.from(sheetTypesByStation.entries())
      .map(([stationCode, present]) => ({
        missing: [FLIPKART_RUNSHEET, FLIPKART_PICKUPSHEET]
          .filter((sheetType) => !present.has(sheetType)),
        stationCode
      }))
      .filter((station) => station.missing.length)
      .sort((left, right) => left.stationCode.localeCompare(right.stationCode));
    if (incompleteStations.length) {
      const details = incompleteStations
        .map((station) => `${station.stationCode} is missing ${station.missing.join(" and ")}`)
        .join("; ");
      throw new Error(
        `Flipkart production file is incomplete by station: ${details}. `
        + "Upload the complete file containing delivery and customer-return sheets for every uploaded station."
      );
    }
  }
  const cycle = validateFlipkartImportCycle(publicRows.map((row) => row.workDate));
  if (
    options.requireCompleteCycle
    && (cycle.observedStartDate !== cycle.startDate || cycle.observedEndDate !== cycle.endDate)
  ) {
    throw new Error(
      `Flipkart production file is incomplete for ${cycle.key}. `
      + `Expected boundary dates ${cycle.startDate} to ${cycle.endDate}, but found `
      + `${cycle.observedStartDate} to ${cycle.observedEndDate}. Upload the complete cycle file.`
    );
  }
  if (options.requireCompleteCycle) {
    const observedDates = new Set(publicRows.map((row) => row.workDate));
    const missingDates: string[] = [];
    for (
      let cursor = new Date(`${cycle.startDate}T00:00:00.000Z`);
      cursor <= new Date(`${cycle.endDate}T00:00:00.000Z`);
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
    ) {
      const date = cursor.toISOString().slice(0, 10);
      if (!observedDates.has(date)) missingDates.push(date);
    }
    if (missingDates.length) {
      const sample = missingDates.slice(0, 5).join(", ");
      throw new Error(
        `Flipkart production file is incomplete for ${cycle.key}; ${missingDates.length} cycle date`
        + `${missingDates.length === 1 ? " is" : "s are"} missing (${sample}${missingDates.length > 5 ? ", …" : ""}). `
        + "Upload the complete cycle file."
      );
    }
  }
  return {
    cycle,
    daily: aggregateFlipkartDailyProduction(publicRows),
    deduplicatedRowCount: parsed.length - publicRows.length,
    headerRowNumber: headerIndex + 1,
    issues,
    rows: publicRows
  };
}
