export const dynamic = "force-dynamic";
export const maxDuration = 300;

import crypto from "crypto";
import * as XLSX from "xlsx";
import { getAuthorization, hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { getServiceAuthorization, ServiceAuthError } from "@/lib/service-auth";
import { loadCodLocations, locationModelName, providerName } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";

type SourceType = string;
type CoreSourceType = "amazon_shipments" | "iocl_fuel" | "bpcl_fuel" | "cashbook";
type SheetRow = Array<string | number | boolean | null | undefined>;
type RawRecord = Record<string, string>;
type NormalizedImport = {
  amount?: number;
  externalWorkerId?: string;
  normalizedData: Record<string, unknown>;
  shipmentCount?: number;
  stationCode?: string;
  workDate?: string;
};

type CpsBreakupRow = {
  amount: number;
  company_id: string;
  count: number;
  cps: number;
  head: string;
  notes: string | null;
  source: string;
  station_code: string;
  sub_head: string;
  work_date: string;
};

type ParsedImportRow = {
  duplicateScope: "existing" | "file" | null;
  hash: string;
  isDuplicate: boolean;
  issue: string | null;
  normalized: NormalizedImport | null;
  raw: RawRecord;
  rowNumber: number;
  status: "Imported" | "Skipped";
};

type DeliveredShipmentFact = {
  actual_weight_kg: number | null;
  city: string | null;
  company_id: string;
  cubic_volume_cm3: number | null;
  driver_id: string;
  driver_name: string | null;
  final_state: string;
  height_cm: number | null;
  last_scan_status: string | null;
  last_updated_at: string;
  length_cm: number | null;
  package_count: number;
  postal_code: string;
  raw_payload: RawRecord;
  source_batch_id: string;
  station_code: string;
  tracking_id: string;
  updated_at: string;
  width_cm: number | null;
  work_date: string;
};

type InboundShipmentFact = {
  actual_weight_kg: number | null;
  city: string | null;
  company_id: string;
  cubic_volume_cm3: number | null;
  expected_arrival_date: string;
  height_cm: number | null;
  length_cm: number | null;
  package_count: number;
  postal_code: string;
  raw_payload: RawRecord;
  shipment_state: string | null;
  snapshot_at: string | null;
  source_batch_id: string;
  station_code: string;
  tracking_id: string;
  updated_at: string;
  width_cm: number | null;
};

const sourceLabels: Record<SourceType, string> = {
  amazon_shipments: "Amazon shipment count",
  bpcl_fuel: "BPCL fuel",
  cashbook: "Cashbook",
  iocl_fuel: "IOC fuel",
  edsp_sls_scorecard: "EDSP SLS scorecard",
  daily_edsp_metrics: "Daily EDSP metrics"
};
const HASH_LOOKUP_CHUNK_SIZE = 25;

function clean(value: unknown) {
  return String(value ?? "").trim().replace(/^'+/, "").replace(/'+$/, "");
}

function key(value: unknown) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function metricKey(value: unknown) {
  return key(value).replace(/20$/, "2");
}

function normalizeStation(value: unknown) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeVehicle(value: unknown) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function toNumber(value: unknown) {
  const text = clean(value).replace(/,/g, "");
  if (!text || text === "-") return 0;
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

type DateOrder = "dmy" | "mdy";

function parseDateWithOrder(value: unknown, order: DateOrder = "dmy") {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = clean(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);

  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 24 * 60 * 60 * 1000);
      return date.toISOString().slice(0, 10);
    }
  }

  const slashDate = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const year = slashDate[3].length === 2 ? `20${slashDate[3]}` : slashDate[3];
    let day = order === "mdy" ? second : first;
    let month = order === "mdy" ? first : second;

    if (first > 12) {
      day = first;
      month = second;
    } else if (second > 12) {
      day = second;
      month = first;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const normalized = new Date(Date.UTC(Number(year), month - 1, day));
    if (
      Number.isNaN(normalized.getTime()) ||
      normalized.getUTCFullYear() !== Number(year) ||
      normalized.getUTCMonth() !== month - 1 ||
      normalized.getUTCDate() !== day
    ) {
      return null;
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function parseDate(value: unknown) {
  return parseDateWithOrder(value, "dmy");
}

function parseAmazonDate(value: unknown) {
  return parseDateWithOrder(value, "mdy");
}

function formatDateUtc(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfAmazonWeek(dateText: string) {
  const parts = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid Amazon report date "${dateText}".`);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date;
}

function amazonWeekInfo(workDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new Error(`Invalid Amazon report date "${workDate}".`);
  const year = Number(workDate.slice(0, 4));
  const weekStart = startOfAmazonWeek(workDate);
  const yearWeekOneStart = startOfAmazonWeek(`${year}-01-01`);
  const weekNo = Math.floor((weekStart.getTime() - yearWeekOneStart.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return {
    amazon_week_from: formatDateUtc(weekStart),
    amazon_week_no: weekNo,
    amazon_week_to: formatDateUtc(addUtcDays(weekStart, 6)),
    amazon_week_year: year
  };
}

function amazonWeekRange(year: number, week: number) {
  const weekOneStart = startOfAmazonWeek(`${year}-01-01`);
  const weekStart = addUtcDays(weekOneStart, (week - 1) * 7);
  return {
    from: formatDateUtc(weekStart),
    to: formatDateUtc(addUtcDays(weekStart, 6))
  };
}

function findValue(raw: RawRecord, aliases: string[]) {
  const normalizedAliases = aliases.map(key);
  const entry = Object.entries(raw).find(([label]) => normalizedAliases.includes(key(label)));
  return entry?.[1] ?? "";
}

function findValueIncludes(raw: RawRecord, fragments: string[]) {
  const normalizedFragments = fragments.map(metricKey);
  const entry = Object.entries(raw).find(([label]) => {
    const labelKey = metricKey(label);
    return normalizedFragments.some((fragment) => labelKey.includes(fragment));
  });
  return entry?.[1] ?? "";
}

function findValueIncludesPrioritized(raw: RawRecord, fragments: string[]) {
  const entries = Object.entries(raw);
  for (const fragment of fragments.map(metricKey)) {
    const entry = entries.find(([label]) => metricKey(label).includes(fragment));
    if (entry) return entry[1];
  }
  return "";
}

function rowHash(raw: RawRecord) {
  const stableRaw = Object.keys(raw).sort().reduce<Record<string, string>>((acc, column) => {
    acc[column] = raw[column];
    return acc;
  }, {});
  return crypto.createHash("sha256").update(JSON.stringify(stableRaw)).digest("hex");
}

function dedupeHash(raw: RawRecord, dedupeFields: string[]) {
  if (!dedupeFields.length) return rowHash(raw);
  const values = dedupeFields.map((field) => clean(findValue(raw, [field])));
  if (values.some((value) => !value)) return rowHash(raw);
  return crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function readWorkbookRows(buffer: ArrayBuffer, includeAllSheets = false) {
  const workbook = XLSX.read(buffer, { type: "array", raw: true, cellDates: true });
  const sheetNames = includeAllSheets ? workbook.SheetNames : workbook.SheetNames.slice(0, 1);
  if (!sheetNames.length) throw new Error("The workbook has no sheets.");
  const combined: SheetRow[] = [];
  sheetNames.forEach((sheetName, sheetIndex) => {
    const rows = XLSX.utils.sheet_to_json<SheetRow>(workbook.Sheets[sheetName], { header: 1, raw: true, defval: "" });
    if (!rows.length) return;
    if (sheetIndex === 0) {
      combined.push(...rows);
      return;
    }
    const headerIndex = locateHeader(rows, ["Tracking ID"]);
    combined.push(...rows.slice(headerIndex + 1));
  });
  return combined;
}

type PdfMetricRow = {
  pageNumber: number;
  rowNumber: number;
  rawText: string;
  rowLabel: string | null;
  stationCode: string | null;
  values: Array<string | number>;
};

async function readPdfMetricRows(buffer: ArrayBuffer, alignDailyMetrics = false, alignScorecardMetrics = false) {
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const rows: PdfMetricRow[] = [];
  let fullText = "";
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const items = (content.items as Array<{ str?: string; transform?: number[]; width?: number }>)
      .filter((item) => clean(item.str))
      .map((item) => ({ text: clean(item.str), width: Number(item.width ?? 0), x: Number(item.transform?.[4] ?? 0), y: Number(item.transform?.[5] ?? 0) }))
      .sort((a, b) => Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x);
    const lines: Array<{ y: number; cells: typeof items }> = [];
    items.forEach((item) => {
      const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
      if (line) line.cells.push(item);
      else lines.push({ y: item.y, cells: [item] });
    });
    lines.forEach((line, index) => {
      const cells = line.cells.sort((a, b) => a.x - b.x).map((item) => item.text);
      const rawText = cells.join(" ").replace(/\s+/g, " ").trim();
      if (!rawText || rawText.length < 2) return;
      fullText += `${rawText}\n`;
      const stationMatch = rawText.match(/(?:^|\s)([A-Z0-9]{4})(?:\s|$)/);
      let values = cells
        .filter((cell) => /^-?[\d,.]+%?$/.test(cell))
        .map((cell) => cell.endsWith("%") ? Number(cell.replace(/[,%]/g, "")) / 100 : Number(cell.replace(/,/g, "")))
        .filter((value) => Number.isFinite(value));
      if (alignDailyMetrics && /^\d+\s+[A-Z0-9]{4}\b/.test(rawText)) {
        const serial = Number(cells[0] ?? 0);
        const aligned = Array<number>(21).fill(0);
        const firstCenter = viewport.width * .211;
        const columnStep = viewport.width * .03445;
        line.cells.filter((cell) => cell.text.endsWith("%")).forEach((cell) => {
          const center = cell.x + cell.width / 2;
          const column = Math.round((center - firstCenter) / columnStep);
          if (column >= 0 && column < aligned.length) {
            aligned[column] = Number(cell.text.replace(/[,%]/g, "")) / 100;
          }
        });
        values = [serial, ...aligned];
      }
      if (alignScorecardMetrics && /^\d+\s+[A-Z0-9]{4}\b/.test(rawText)) {
        const serial = Number(cells[0] ?? 0);
        const centersAtReferenceWidth = [125.998, 141.173, 155.874, 169.372, 183.577, 199.374, 215.878, 231.7, 247.928, 263.528, 280.132, 296.577, 311.374, 327.3, 346.225, 368.124, 387.325, 403.924, 423.126, 444.974, 466.0, 487.0, 506.776, 527.582];
        const scale = viewport.width / 595.303937007874;
        const aligned = Array<number>(24).fill(0);
        line.cells
          .filter((cell) => /^-?[\d,.]+%?$/.test(cell.text) && cell.x > viewport.width * .18)
          .forEach((cell) => {
            const center = cell.x + cell.width / 2;
            let bestIndex = -1;
            let bestDistance = Number.POSITIVE_INFINITY;
            centersAtReferenceWidth.forEach((referenceCenter, index) => {
              const distance = Math.abs(center - referenceCenter * scale);
              if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = index;
              }
            });
            if (bestIndex >= 0 && bestDistance <= 9 * scale) {
              aligned[bestIndex] = cell.text.endsWith("%")
                ? Number(cell.text.replace(/[,%]/g, "")) / 100
                : Number(cell.text.replace(/,/g, ""));
            }
          });
        values = [serial, ...aligned];
      }
      rows.push({
        pageNumber,
        rowNumber: index + 1,
        rawText,
        rowLabel: cells.find((cell) => /[A-Za-z]/.test(cell) && !/^[A-Z0-9]{4}$/.test(cell)) ?? null,
        stationCode: stationMatch?.[1] ?? null,
        values
      });
    });
  }
  const week = fullText.match(/\bWeek\s+(\d{1,2})\b/i);
  const isoDate = fullText.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  const localDate = fullText.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/);
  const reportDate = isoDate
    ? `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`
    : localDate ? parseDate(`${localDate[1]}/${localDate[2]}/${localDate[3]}`) : null;
  return {
    rows,
    reportDate,
    reportWeek: week ? Number(week[1]) : null,
    reportYear: reportDate ? Number(reportDate.slice(0, 4)) : Number(fullText.match(/\b(20\d{2})\b/)?.[1] ?? 0) || null
  };
}

function locateHeader(rows: SheetRow[], requiredAny: string[]) {
  const requiredKeys = requiredAny.map(key);
  const index = rows.findIndex((row) => {
    const labels = row.map(key).filter(Boolean);
    return requiredKeys.some((item) => labels.includes(item));
  });
  if (index < 0) throw new Error("Could not find a usable header row in this file.");
  return index;
}

function rowsToRecords(rows: SheetRow[], headerIndex: number) {
  const header = rows[headerIndex].map(clean);
  return rows.slice(headerIndex + 1).map((row, index) => {
    const record: RawRecord = {};
    header.forEach((label, columnIndex) => {
      if (label) record[label] = clean(row[columnIndex]);
    });
    return { raw: record, rowNumber: headerIndex + index + 2 };
  }).filter(({ raw }) => Object.values(raw).some(Boolean));
}

function cashbookHead(raw: RawRecord) {
  const text = `${findValue(raw, ["Expense Type", "Type"])} ${findValue(raw, ["Category", "Head"])} ${findValue(raw, ["Sub Head", "Sub Category"])} ${findValue(raw, ["Remarks", "Narration", "Description"])}`.toLowerCase();
  if (text.includes("associate") || text.includes("delivery associate") || text.includes("da pay") || text.includes("rider")) return "DA Variable CPS";
  if (text.includes("utr") || text.includes("staff salary") || text.includes("salary") || text.includes("team leader") || text.includes("support associate") || text.includes("hub staff")) return "UTR CPS";
  if (text.includes("fuel") || text.includes("diesel") || text.includes("petrol")) return "VAN CPS";
  if (text.includes("driver") || text.includes("vehicle") || text.includes("repair") || text.includes("maintenance") || text.includes("tyre") || text.includes("toll") || text.includes("parking") || text.includes("adhoc van")) return "VAN CPS";
  return "Other CPS";
}

function parseAmazon(raw: RawRecord, rowNumber: number): NormalizedImport | null {
  const workDate = parseAmazonDate(findValue(raw, ["Report Date", "Date", "Shipment Date", "Business Date", "Delivery Date"]));
  const stationCode = normalizeStation(findValue(raw, ["Station Code", "Station", "Location", "DS", "Delivery Station"]));
  const externalWorkerId = clean(findValue(raw, ["holder_employee_id", "Holder Employee ID", "Provider ID", "Driver ID", "DA ID", "Associate ID"]));
  if (!workDate || !stationCode) return null;

  const delivered = toNumber(
    findValueIncludesPrioritized(raw, ["finaldeliverycountexcludingswasmdsmd2", "finaldeliverycountexcludingswasmdsmd20", "finaldeliverycount"])
    || findValue(raw, ["Delivered"])
  );
  const smd = toNumber(findValue(raw, ["Overall Delivered SMD"]));
  const smd2 = toNumber(findValue(raw, ["Overall Delivered SMD2", "Overall Delivered SMD 2.0", "Overall Delivered SMD2.0"]));
  const swa = toNumber(findValue(raw, ["Overall Delivered SWA"]))
    + toNumber(findValue(raw, ["Overall Delivered SWA Consumable", "Overall Delivered SWA-Consumable"]));
  const shipmentType = clean(findValue(raw, ["Shipment Type", "Type"]));
  const finalCReturn = toNumber(findValue(raw, ["final_creturn_count", "Final CReturn Count", "C Return", "C_Return"]));
  const amazonDelivery = delivered + smd + smd2;
  const cReturn = finalCReturn;
  const mfn = toNumber(findValue(raw, ["final_mfn_count", "Final MFN Count", "MFN"]));
  const mfnReturn = toNumber(findValue(raw, ["final_seller_returns", "Final Seller Returns", "MFN Return"]));
  const totalDelivery = amazonDelivery + swa;
  const totalActivity = totalDelivery + cReturn + mfn + mfnReturn;
  const assignedCount = toNumber(findValue(raw, ["Assigned", "Assigned Packages", "Total Assigned", "Shipment Assigned", "Packages Assigned"]));
  if (totalActivity <= 0 && !externalWorkerId) return null;

  return {
    externalWorkerId: externalWorkerId || `ROW-${rowNumber}`,
    normalizedData: {
      ...amazonWeekInfo(workDate),
      amazon_delivery: amazonDelivery,
      assigned_count: assignedCount,
      base_amazon_delivery: delivered,
      client: "Amazon",
      c_return: cReturn,
      final_creturn_count: finalCReturn,
      mfn,
      mfn_return: mfnReturn,
      provider_employee_id: externalWorkerId || `ROW-${rowNumber}`,
      provider_employee_name: findValue(raw, ["Name", "Associate Name", "Driver Name"]),
      shipment_type: shipmentType,
      smd_delivery: smd,
      smd2_delivery: smd2,
      swa_delivery: swa,
      total_activity: totalActivity,
      total_delivery: totalDelivery,
      work_date: workDate
    },
    shipmentCount: totalDelivery,
    stationCode,
    workDate
  };
}

function readableError(error: unknown) {
  if (error instanceof Error) {
    if (/<html|<!doctype|error code 5(?:02|03|04|20)/i.test(error.message)) return "Temporary database gateway error. Please retry.";
    return error.message;
  }
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; details?: unknown; hint?: unknown; message?: unknown; status?: unknown; statusText?: unknown };
    const message = [candidate.message, candidate.details, candidate.hint, candidate.statusText, candidate.code, candidate.status]
      .map((item) => clean(item))
      .filter(Boolean)
      .join(" ");
    if (/<html|<!doctype|error code 5(?:02|03|04|20)|\b5(?:02|03|04|20)\b/i.test(message)) return "Temporary database gateway error. Please retry.";
    return message;
  }
  return clean(error) || "Unknown error";
}

async function importStep<T>(step: string, action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    const message = readableError(error);
    console.error(`Report import failed at ${step}:`, error);
    throw new Error(`${step}: ${message}`);
  }
}

function aggregateAmazonRows(rows: Array<{ normalized: NormalizedImport | null }>, batchId: string, companyId: string) {
  const map = new Map<string, {
    amazon_delivery: number;
    assigned_count: number;
    c_return: number;
    company_id: string;
    mfn: number;
    mfn_return: number;
    provider_employee_id: string;
    provider_employee_name: string | null;
    raw_row_count: number;
    shipment_type: string | null;
    source_batch_id: string;
    station_code: string;
    swa_delivery: number;
    total_activity: number;
    total_delivery: number;
    updated_at: string;
    work_date: string;
    client: string;
  }>();

  rows.forEach((row) => {
    if (!row.normalized) return;
    const normalized = row.normalized;
    const providerEmployeeId = clean(normalized.normalizedData.provider_employee_id);
    const mapKey = `${normalized.workDate}|${normalized.stationCode}|${providerEmployeeId}`;
    const current = map.get(mapKey) ?? {
      amazon_delivery: 0,
      assigned_count: 0,
      c_return: 0,
      client: "Amazon",
      company_id: companyId,
      mfn: 0,
      mfn_return: 0,
      provider_employee_id: providerEmployeeId,
      provider_employee_name: clean(normalized.normalizedData.provider_employee_name) || null,
      raw_row_count: 0,
      shipment_type: null,
      source_batch_id: batchId,
      station_code: normalized.stationCode!,
      swa_delivery: 0,
      total_activity: 0,
      total_delivery: 0,
      updated_at: new Date().toISOString(),
      work_date: normalized.workDate!
    };
    current.amazon_delivery += Number(normalized.normalizedData.amazon_delivery ?? 0);
    current.assigned_count += Number(normalized.normalizedData.assigned_count ?? 0);
    current.c_return += Number(normalized.normalizedData.c_return ?? 0);
    current.mfn += Number(normalized.normalizedData.mfn ?? 0);
    current.mfn_return += Number(normalized.normalizedData.mfn_return ?? 0);
    current.swa_delivery += Number(normalized.normalizedData.swa_delivery ?? 0);
    current.total_activity += Number(normalized.normalizedData.total_activity ?? 0);
    current.total_delivery += Number(normalized.normalizedData.total_delivery ?? 0);
    current.raw_row_count += 1;
    const shipmentType = clean(normalized.normalizedData.shipment_type);
    if (shipmentType) {
      current.shipment_type = current.shipment_type && current.shipment_type !== shipmentType ? "Mixed" : shipmentType;
    }
    if (!current.provider_employee_name) current.provider_employee_name = clean(normalized.normalizedData.provider_employee_name) || null;
    map.set(mapKey, current);
  });

  return Array.from(map.values());
}

function parseFuel(raw: RawRecord, rowNumber: number, provider: "IOC" | "BPCL"): NormalizedImport | null {
  const transactionId = clean(findValue(raw, provider === "IOC" ? ["Txn ID", "Transaction ID"] : ["Transaction ID", "Txn ID"])) || `${provider}-${rowNumber}-${rowHash(raw).slice(0, 10)}`;
  const transactionDate = parseDate(findValue(raw, provider === "IOC" ? ["Txn Date", "Transaction Date"] : ["Transaction Date", "Txn Date"]));
  const vehicleNo = normalizeVehicle(findValue(raw, provider === "IOC" ? ["Vehicle No. (Card)", "VehicleNo (User Entry)", "Vehicle Number"] : ["Vehicle Number", "Name of Card", "Custom Card Name"]));
  const amount = toNumber(findValue(raw, provider === "IOC" ? ["Amount", "Purchase Amount(Rs.)", "Total Transaction Amount (Rs.)"] : ["Purchase Amount(Rs.)", "Total Transaction Amount (Rs.)", "Amount"]));
  const litres = toNumber(findValue(raw, provider === "IOC" ? ["Quantity", "Product Volume /  Quantity (Litres)"] : ["Product Volume /  Quantity (Litres)", "Quantity"]));
  if (!transactionDate || amount <= 0) return null;
  const stationCode = normalizeStation(findValue(raw, ["Station Code", "Location Code", "Station"]));

  return {
    amount,
    normalizedData: {
      amount,
      product: findValue(raw, ["Product", "Product Name"]),
      provider,
      station_code: stationCode || null,
      transaction_date: transactionDate,
      transaction_id: transactionId,
      vehicle_no: vehicleNo || null,
      litres
    },
    stationCode: stationCode || undefined,
    workDate: transactionDate
  };
}

function parseCashbook(raw: RawRecord): NormalizedImport | null {
  const expenseDate = parseDate(findValue(raw, ["Date", "Expense Date", "Payment Date", "Txn Date"]));
  const stationCode = normalizeStation(findValue(raw, ["Station Code", "Station", "Location", "Location Code", "Branch", "Hub"]));
  const amount = Math.abs(toNumber(findValue(raw, ["Amount", "Debit", "Expenses", "Expense Amount", "Paid Amount"])));
  const paymentStatus = clean(findValue(raw, ["Payment Status", "Status"])).toLowerCase();
  if (paymentStatus && !["success", "successful", "completed", "paid"].includes(paymentStatus)) return null;
  if (!expenseDate || !stationCode || amount <= 0) return null;
  const head = cashbookHead(raw);
  return {
    amount,
    normalizedData: {
      amount,
      category: findValue(raw, ["Category", "Head"]),
      cps_head: head,
      cps_sub_head: findValue(raw, ["Sub Head", "Sub Category"]),
      expense_date: expenseDate,
      expense_type: findValue(raw, ["Expense Type", "Type"]),
      remarks: findValue(raw, ["Remarks", "Remark", "Narration", "Description", "Note"]),
      transaction_id: findValue(raw, ["Txn Id", "Txn ID", "Transaction ID"]),
      station_code: stationCode
    },
    stationCode,
    workDate: expenseDate
  };
}

function parseFile(sourceType: CoreSourceType, rows: SheetRow[]) {
  const headerIndex = locateHeader(rows, sourceType === "amazon_shipments"
    ? ["holder_employee_id", "Station Code", "Delivered"]
    : sourceType === "cashbook"
      ? ["Amount", "Expenses", "Station Code", "Branch", "Expense Date", "Date"]
      : ["Transaction ID", "Txn ID", "Vehicle Number"]);
  const records = rowsToRecords(rows, headerIndex);
  return records.map(({ raw, rowNumber }) => {
    const normalized = sourceType === "amazon_shipments"
      ? parseAmazon(raw, rowNumber)
      : sourceType === "iocl_fuel"
        ? parseFuel(raw, rowNumber, "IOC")
        : sourceType === "bpcl_fuel"
          ? parseFuel(raw, rowNumber, "BPCL")
          : parseCashbook(raw);
    return { normalized, raw, rowNumber };
  });
}

function parseGenericFile(rows: SheetRow[]) {
  const headerIndex = rows.findIndex((row) => row.map(clean).filter(Boolean).length >= 2);
  if (headerIndex < 0) throw new Error("Could not find a usable header row in this file.");
  return rowsToRecords(rows, headerIndex).map(({ raw, rowNumber }) => {
    const workDate = parseDate(findValue(raw, [
      "report_date", "date", "invitation_date", "cash_with_associate_dt", "created_at"
    ]));
    const stationCode = normalizeStation(findValue(raw, ["station_code", "station", "location", "hub"]));
    const externalWorkerId = clean(findValue(raw, [
      "transporter_id", "tracking_id", "employee_id", "associate_id", "rabbit_id"
    ]));
    return {
      normalized: {
        externalWorkerId: externalWorkerId || undefined,
        normalizedData: { ...raw },
        stationCode: stationCode || undefined,
        workDate: workDate || undefined
      },
      raw,
      rowNumber
    };
  });
}

function measurement(value: unknown, dimension: "length" | "weight") {
  const text = clean(value).toLowerCase();
  const number = Number(text.match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN);
  if (!Number.isFinite(number) || number < 0) return null;
  if (dimension === "weight") {
    if (/\b(?:g|gram|grams)\b/.test(text) && !/\bkg\b/.test(text)) return number / 1000;
    if (/\b(?:lb|lbs|pound|pounds)\b/.test(text)) return number * 0.45359237;
    return number;
  }
  if (/\bmm\b/.test(text)) return number / 10;
  if (/\b(?:m|meter|meters)\b/.test(text) && !/\bcm\b/.test(text)) return number * 100;
  if (/\b(?:in|inch|inches)\b/.test(text)) return number * 2.54;
  return number;
}

function timestamp(value: unknown) {
  const text = clean(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseDeliveredShipmentFacts(rows: SheetRow[], companyId: string, batchId: string, selectedStation: string, selectedDate: string, allowedStations: Set<string>) {
  const headerIndex = locateHeader(rows, ["Tracking ID"]);
  const records = rowsToRecords(rows, headerIndex);
  const rejected: Array<{ rowNumber: number; issue: string }> = [];
  const byTrackingId = new Map<string, DeliveredShipmentFact>();
  const embeddedDates = new Set(records.map(({ raw }) =>
    timestamp(findValue(raw, ["Last Updated Time", "Delivery Time", "Delivered At"]))?.slice(0, 10)
  ).filter(Boolean));
  const preserveEmbeddedDates = embeddedDates.size > 1;
  records.forEach(({ raw, rowNumber }) => {
    const trackingId = clean(findValue(raw, ["Tracking ID", "Tracking Number", "Shipment ID"]));
    const stationCode = normalizeStation(findValue(raw, ["Station", "Station Code", "Delivery Station"])) || selectedStation;
    const lastUpdatedAt = timestamp(findValue(raw, ["Last Updated Time", "Delivery Time", "Delivered At"]));
    const driverId = clean(findValue(raw, ["Driver ID", "Associate ID", "DA ID"])).toUpperCase();
    const postalCode = clean(findValue(raw, ["Postal", "Pincode", "Postal Code"])).match(/\d{6}/)?.[0] ?? "";
    const finalState = clean(findValue(raw, ["State", "Final State", "Shipment State"]));
    const lastScanStatus = clean(findValue(raw, ["Last Scan Status", "Scan Status"]));
    if (!trackingId || !stationCode || !lastUpdatedAt || !driverId || !postalCode) {
      rejected.push({ rowNumber, issue: "Missing tracking ID, station, timestamp, Driver ID or postal code." });
      return;
    }
    if (!allowedStations.has(stationCode)) {
      rejected.push({ rowNumber, issue: `Station ${stationCode} is not mapped under ${selectedStation}.` });
      return;
    }
    if (lastScanStatus && key(lastScanStatus) !== "successful") {
      rejected.push({ rowNumber, issue: `Last scan status is ${lastScanStatus}.` });
      return;
    }
    const lengthCm = measurement(findValue(raw, ["Package Length", "Length"]), "length");
    const widthCm = measurement(findValue(raw, ["Package Width", "Width"]), "length");
    const heightCm = measurement(findValue(raw, ["Package Height", "Height"]), "length");
    const actualWeightKg = measurement(findValue(raw, ["Package Weight", "Weight"]), "weight");
    const cubicVolumeCm3 = lengthCm != null && widthCm != null && heightCm != null
      ? lengthCm * widthCm * heightCm
      : null;
    const fact: DeliveredShipmentFact = {
      actual_weight_kg: actualWeightKg,
      city: clean(findValue(raw, ["City"])) || null,
      company_id: companyId,
      cubic_volume_cm3: cubicVolumeCm3,
      driver_id: driverId,
      driver_name: clean(findValue(raw, ["Driver Name", "Associate Name", "Last Scan By"])) || null,
      final_state: finalState,
      height_cm: heightCm,
      last_scan_status: lastScanStatus || null,
      last_updated_at: lastUpdatedAt,
      length_cm: lengthCm,
      package_count: Math.max(1, toNumber(findValue(raw, ["Package Count"])) || 1),
      postal_code: postalCode,
      // Shipment facts already persist every field used by capacity, CPS and
      // volumetric analysis. Repeating the full spreadsheet row here makes
      // large monthly files several times larger over the database API.
      raw_payload: {},
      source_batch_id: batchId,
      station_code: stationCode,
      tracking_id: trackingId,
      updated_at: new Date().toISOString(),
      width_cm: widthCm,
      work_date: preserveEmbeddedDates ? lastUpdatedAt.slice(0, 10) : selectedDate || lastUpdatedAt.slice(0, 10)
    };
    const existing = byTrackingId.get(trackingId);
    if (!existing || existing.last_updated_at <= fact.last_updated_at) byTrackingId.set(trackingId, fact);
  });
  return { facts: [...byTrackingId.values()], rejected, sourceRows: records.length };
}

function parseInboundShipmentFacts(rows: SheetRow[], companyId: string, batchId: string, selectedStation: string, selectedDate: string, allowedStations: Set<string>, fileName: string) {
  const headerIndex = locateHeader(rows, ["Tracking ID", "Tracking Number", "Shipment ID", "Container Id", "Container ID"]);
  const records = rowsToRecords(rows, headerIndex);
  const headers = rows[headerIndex].map(key);
  const isContainerHierarchy = headers.includes(key("Container Id")) && !headers.some((header) =>
    [key("Tracking ID"), key("Tracking Number"), key("Shipment ID")].includes(header));
  const normalizedFileName = key(fileName);
  const fileStation = [...allowedStations]
    .sort((left, right) => right.length - left.length)
    .find((station) => normalizedFileName.includes(key(station))) ?? "";
  const fallbackStation = selectedStation || fileStation;
  const rejected: Array<{ rowNumber: number; issue: string }> = [];
  const byTrackingId = new Map<string, InboundShipmentFact>();
  const embeddedDates = new Set(records.map(({ raw }) => parseDate(findValue(raw, [
    "Estimated Arrival Date", "Expected Arrival Date", "Arrival Date",
    "Promised Delivery Date", "Scheduled Delivery Start time"
  ]))).filter(Boolean));
  const preserveEmbeddedDates = embeddedDates.size > 1;
  records.forEach(({ raw, rowNumber }) => {
    const trackingId = clean(findValue(raw, ["Tracking ID", "Tracking Number", "Shipment ID", "Container Id", "Container ID"]));
    const stationCode = normalizeStation(findValue(raw, ["Station", "Station Code", "Delivery Station"])) || fallbackStation;
    const embeddedArrivalDate = parseDate(findValue(raw, [
      "Estimated Arrival Date", "Expected Arrival Date", "Arrival Date",
      "Promised Delivery Date", "Scheduled Delivery Start time"
    ]));
    const expectedArrivalDate = preserveEmbeddedDates ? embeddedArrivalDate : selectedDate || embeddedArrivalDate;
    const postalCode = clean(findValue(raw, ["Postal", "Pincode", "Postal Code"])).match(/\d{6}/)?.[0] ?? "";
    const containerCount = clean(findValue(raw, ["Container Count"]));
    if (isContainerHierarchy && containerCount && !/^0\s*items?$/i.test(containerCount)) return;
    if (!trackingId || !stationCode || !expectedArrivalDate || (!isContainerHierarchy && !postalCode)) {
      rejected.push({ rowNumber, issue: isContainerHierarchy
        ? "Missing container ID, station code in filename, or selected inbound date."
        : "Missing tracking ID, station, expected-arrival date or postal code." });
      return;
    }
    if (!allowedStations.has(stationCode)) {
      rejected.push({ rowNumber, issue: `Station ${stationCode} is not mapped under ${selectedStation}.` });
      return;
    }
    const lengthCm = measurement(findValue(raw, ["Package Length", "Length"]), "length");
    const widthCm = measurement(findValue(raw, ["Package Width", "Width"]), "length");
    const heightCm = measurement(findValue(raw, ["Package Height", "Height"]), "length");
    const actualWeightKg = measurement(findValue(raw, ["Package Weight", "Weight"]), "weight");
    const cubicVolumeCm3 = lengthCm != null && widthCm != null && heightCm != null
      ? lengthCm * widthCm * heightCm
      : null;
    const fact: InboundShipmentFact = {
      actual_weight_kg: actualWeightKg,
      city: clean(findValue(raw, ["City"])) || null,
      company_id: companyId,
      cubic_volume_cm3: cubicVolumeCm3,
      expected_arrival_date: expectedArrivalDate,
      height_cm: heightCm,
      length_cm: lengthCm,
      package_count: isContainerHierarchy ? 1 : Math.max(1, toNumber(findValue(raw, ["Package Count"])) || 1),
      postal_code: postalCode,
      raw_payload: isContainerHierarchy ? { source_format: "container_hierarchy" } : {},
      shipment_state: isContainerHierarchy ? "Inbound container" : clean(findValue(raw, ["State", "Shipment State"])) || null,
      snapshot_at: timestamp(findValue(raw, ["Last Updated Time", "Snapshot Time", "Report Time"])),
      source_batch_id: batchId,
      station_code: stationCode,
      tracking_id: trackingId,
      updated_at: new Date().toISOString(),
      width_cm: widthCm
    };
    const existing = byTrackingId.get(trackingId);
    if (!existing || (existing.snapshot_at ?? "") <= (fact.snapshot_at ?? "")) byTrackingId.set(trackingId, fact);
  });
  return { facts: [...byTrackingId.values()], rejected, sourceRows: records.length };
}

async function mapFuelStations(companyId: string, rows: Array<{ normalized: NormalizedImport | null }>) {
  if (!supabaseAdmin) return;
  const vehicles = Array.from(new Set(rows.map((row) => clean(row.normalized?.normalizedData.vehicle_no)).filter(Boolean)));
  if (!vehicles.length) return;
  const { data } = await supabaseAdmin
    .from("fleet_vehicles")
    .select("vehicle_no, station_code")
    .eq("company_id", companyId)
    .in("vehicle_no", vehicles);
  const stationByVehicle = new Map((data ?? []).map((row) => [normalizeVehicle(row.vehicle_no), normalizeStation(row.station_code)]));
  rows.forEach((row) => {
    if (!row.normalized || row.normalized.stationCode) return;
    const vehicleStation = stationByVehicle.get(normalizeVehicle(row.normalized.normalizedData.vehicle_no));
    if (!vehicleStation) return;
    row.normalized.stationCode = vehicleStation;
    row.normalized.normalizedData.station_code = vehicleStation;
  });
}

async function recalculateCps(companyId: string, touched: Array<{ stationCode?: string; workDate?: string }>) {
  if (!supabaseAdmin) return;
  const pairs = Array.from(new Map(touched
    .filter((item) => item.stationCode && item.workDate)
    .map((item) => [`${item.workDate}|${item.stationCode}`, { workDate: item.workDate!, stationCode: item.stationCode! }])
  ).values());

  for (const pair of pairs) {
    const [shipments, fuel, cashbook, target] = await Promise.all([
      supabaseAdmin
        .from("cps_shipment_daily")
        .select("total_delivery, total_activity, c_return, mfn, mfn_return, da_total_pay")
        .eq("company_id", companyId)
        .eq("work_date", pair.workDate)
        .eq("station_code", pair.stationCode),
      supabaseAdmin
        .from("cps_fuel_daily")
        .select("amount, provider, product, vehicle_no")
        .eq("company_id", companyId)
        .eq("transaction_date", pair.workDate)
        .eq("station_code", pair.stationCode),
      supabaseAdmin
        .from("cps_cashbook_daily")
        .select("amount, cps_head, cps_sub_head, category, expense_type")
        .eq("company_id", companyId)
        .eq("expense_date", pair.workDate)
        .eq("station_code", pair.stationCode),
      supabaseAdmin
        .from("cps_station_targets")
        .select("target_cps")
        .eq("company_id", companyId)
        .eq("station_code", pair.stationCode)
        .eq("is_active", true)
        .lte("effective_from", pair.workDate)
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);
    if (shipments.error || fuel.error || cashbook.error || target.error) continue;

    const totalDelivery = (shipments.data ?? []).reduce((sum, row) => sum + Number(row.total_delivery ?? 0), 0);
    const totalActivity = (shipments.data ?? []).reduce((sum, row) => sum + Number(row.total_activity ?? 0), 0);
    const cReturn = (shipments.data ?? []).reduce((sum, row) => sum + Number(row.c_return ?? 0), 0);
    const mfn = (shipments.data ?? []).reduce((sum, row) => sum + Number(row.mfn ?? 0), 0);
    const mfnReturn = (shipments.data ?? []).reduce((sum, row) => sum + Number(row.mfn_return ?? 0), 0);
    const shipmentDaPay = (shipments.data ?? []).reduce((sum, row) => sum + Number(row.da_total_pay ?? 0), 0);
    const importedFuelCost = (fuel.data ?? []).reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    const cashRows = cashbook.data ?? [];
    const cashVan = cashRows.filter((row) => row.cps_head === "VAN CPS").reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    const daPayCost = shipmentDaPay + cashRows.filter((row) => row.cps_head === "DA Variable CPS").reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    const staffCost = cashRows.filter((row) => row.cps_head === "UTR CPS").reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    const otherCost = cashRows.filter((row) => row.cps_head === "Other CPS").reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    const fuelCost = importedFuelCost;
    const vehicleCost = cashVan;
    const rentCost = 0;
    const vanCost = fuelCost + vehicleCost;
    const utrCost = staffCost;
    const totalCost = daPayCost + utrCost + vanCost + otherCost;
    const divisor = totalDelivery > 0 ? totalDelivery : 0;
    const targetCps = Number(target.data?.target_cps ?? 0);
    const overallCps = divisor ? totalCost / divisor : 0;
    const targetGap = targetCps ? targetCps - overallCps : 0;
    const targetImpact = targetCps ? targetGap * totalDelivery : 0;

    const breakupRows: CpsBreakupRow[] = [];
    const addBreakup = (head: string, subHead: string, source: string, amount: number, count = totalDelivery, notes: string | null = null) => {
      if (!amount && !count) return;
      breakupRows.push({
        amount,
        company_id: companyId,
        count,
        cps: count ? amount / count : 0,
        head,
        notes,
        source,
        station_code: pair.stationCode,
        sub_head: subHead,
        work_date: pair.workDate
      });
    };

    addBreakup("DA Variable CPS", "Mapped DA payout", "Amazon payroll mapping", shipmentDaPay);
    addBreakup("DA Variable CPS", "Cashbook DA payout", "Cashbook", daPayCost - shipmentDaPay);
    addBreakup("UTR CPS", "Staff / UTR payout", "Cashbook / Payroll", utrCost);
    addBreakup("VAN CPS", "Fuel card spend", "Fuel import", fuelCost);
    addBreakup("VAN CPS", "Vehicle cashbook spend", "Cashbook", vehicleCost);
    addBreakup("Other CPS", "Other operating expense", "Cashbook", otherCost);

    await supabaseAdmin
      .from("cps_cost_breakup_daily")
      .delete()
      .eq("company_id", companyId)
      .eq("work_date", pair.workDate)
      .eq("station_code", pair.stationCode);
    if (breakupRows.length) await supabaseAdmin.from("cps_cost_breakup_daily").insert(breakupRows);

    await supabaseAdmin.from("cps_station_daily").upsert({
      company_id: companyId,
      work_date: pair.workDate,
      station_code: pair.stationCode,
      total_delivery: totalDelivery,
      total_activity: totalActivity,
      c_return: cReturn,
      mfn,
      mfn_return: mfnReturn,
      da_pay_cost: daPayCost,
      staff_cost: staffCost,
      fuel_cost: fuelCost,
      vehicle_cost: vehicleCost,
      rent_cost: rentCost,
      other_cost: otherCost,
      total_cost: totalCost,
      da_cps: divisor ? daPayCost / divisor : 0,
      staff_cps: divisor ? staffCost / divisor : 0,
      fuel_cps: divisor ? vanCost / divisor : 0,
      other_cps: divisor ? otherCost / divisor : 0,
      utr_cost: utrCost,
      van_cost: vanCost,
      overall_cps: overallCps,
      target_cps: targetCps,
      target_gap: targetGap,
      target_impact: targetImpact,
      calculated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,work_date,station_code" });
  }
}

function databaseSetupError(message: string) {
  if (message.includes("does not exist") || message.includes("schema cache")) {
    return Response.json({ error: `${message} Run scripts/cps_report_imports_v1.sql in Supabase SQL Editor, then retry.` }, { status: 400 });
  }
  return Response.json({ error: message }, { status: 400 });
}

async function loadExistingImportHashes(companyId: string, sourceType: SourceType, hashes: string[]) {
  if (!supabaseAdmin || !hashes.length) return new Set<string>();
  const existing = new Set<string>();
  for (let index = 0; index < hashes.length; index += HASH_LOOKUP_CHUNK_SIZE) {
    const chunk = hashes.slice(index, index + HASH_LOOKUP_CHUNK_SIZE);
    const { data, error } = await supabaseAdmin
      .from("report_import_rows")
      .select("row_hash")
      .eq("company_id", companyId)
      .eq("source_type", sourceType)
      .eq("status", "Imported")
      .in("row_hash", chunk);
    if (error) {
      const message = readableError(error);
      if (message.includes("does not exist") || message.includes("schema cache")) {
        throw new Error(`report_import_rows hash lookup rows ${index + 1}-${index + chunk.length}: ${message}`);
      }
      console.warn(`Skipping historical duplicate lookup rows ${index + 1}-${index + chunk.length}: ${message}`);
      continue;
    }
    (data ?? []).forEach((row) => existing.add(row.row_hash));
  }
  return existing;
}

async function auditParsedRows(companyId: string, sourceType: SourceType, parsed: Array<{ normalized: NormalizedImport | null; raw: RawRecord; rowNumber: number }>, dedupeFields: string[] = []) {
  const rows = parsed.map((row) => ({ ...row, hash: dedupeHash(row.raw, dedupeFields) }));
  const existingHashes = await loadExistingImportHashes(companyId, sourceType, Array.from(new Set(rows.map((row) => row.hash))));
  const seenInFile = new Set<string>();

  return rows.map<ParsedImportRow>((row) => {
    if (!row.normalized) {
      return {
        ...row,
        duplicateScope: null,
        isDuplicate: false,
        issue: "Required date/station/amount columns were missing or zero.",
        status: "Skipped"
      };
    }

    const duplicateScope = seenInFile.has(row.hash) ? "file" : existingHashes.has(row.hash) ? "existing" : null;
    const isDuplicate = duplicateScope !== null;
    seenInFile.add(row.hash);
    return {
      ...row,
      duplicateScope,
      isDuplicate,
      issue: isDuplicate
        ? duplicateScope === "file"
          ? "Duplicate row ignored; this exact row is repeated in the same file."
          : "Duplicate raw row already imported earlier. Daily totals will still be refreshed from this weekly file."
        : null,
      status: isDuplicate ? "Skipped" : "Imported"
    };
  });
}

async function insertInChunks<T extends Record<string, unknown>>(table: string, rows: T[], chunkSize = 500) {
  if (!supabaseAdmin || !rows.length) return;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const result = await supabaseAdmin.from(table).insert(rows.slice(index, index + chunkSize) as never[]);
    if (result.error) throw new Error(`${table} insert rows ${index + 1}-${Math.min(index + chunkSize, rows.length)}: ${readableError(result.error)}`);
  }
}

async function upsertInChunks<T extends Record<string, unknown>>(table: string, rows: T[], onConflict: string, chunkSize = 500, retry = 0) {
  if (!supabaseAdmin || !rows.length) return;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const result = await supabaseAdmin.from(table).upsert(chunk as never[], { onConflict });
    if (result.error) {
      const rawError = JSON.stringify(result.error);
      const transient = /statement timeout|57014|canceling statement|<html|<!doctype|error code 5(?:02|03|04|20)|\b5(?:02|03|04|20)\b|fetch failed|network/i.test(rawError);
      if (transient && chunkSize > 100) {
        await upsertInChunks(table, chunk, onConflict, Math.max(100, Math.floor(chunkSize / 3)), retry);
        continue;
      }
      if (transient && retry < 3) {
        await new Promise((resolve) => setTimeout(resolve, 750 * (retry + 1)));
        await upsertInChunks(table, chunk, onConflict, chunkSize, retry + 1);
        continue;
      }
      throw new Error(`${table} upsert rows ${index + 1}-${Math.min(index + chunkSize, rows.length)} on ${onConflict}: ${readableError(result.error)}`);
    }
  }
}

async function refreshShipmentCoverage(
  companyId: string,
  sourceType: "delivered_shipment_detail" | "inbound_shipment_detail",
  dates: string[],
  batchId: string,
  chunkSize = 7,
  retry = 0
) {
  if (!supabaseAdmin || !dates.length) return;
  for (let index = 0; index < dates.length; index += chunkSize) {
    const chunk = dates.slice(index, index + chunkSize);
    const result = await supabaseAdmin.rpc("refresh_shipment_import_coverage", {
      p_batch_id: batchId,
      p_company_id: companyId,
      p_dates: chunk,
      p_source_type: sourceType
    });
    if (!result.error) continue;
    const timedOut = /statement timeout|57014|canceling statement/i.test(readableError(result.error));
    if (timedOut && chunk.length > 1) {
      await refreshShipmentCoverage(companyId, sourceType, chunk, batchId, Math.max(1, Math.floor(chunk.length / 2)), retry);
      continue;
    }
    if (timedOut && retry < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (retry + 1)));
      await refreshShipmentCoverage(companyId, sourceType, chunk, batchId, 1, retry + 1);
      continue;
    }
    throw new Error(`dates ${chunk[0]}${chunk.length > 1 ? ` to ${chunk.at(-1)}` : ""}: ${readableError(result.error)}`);
  }
}

async function shipmentParentCodes(companyId: string, stationCodes: string[]) {
  if (!supabaseAdmin || !stationCodes.length) return [];
  const result = await supabaseAdmin.from("stations").select("id, station_code, parent_station_id")
    .eq("company_id", companyId)
    .eq("is_active", true);
  if (result.error) throw new Error(result.error.message);
  const codeById = new Map((result.data ?? []).map((row) => [row.id, normalizeStation(row.station_code)]));
  const rowByCode = new Map((result.data ?? []).map((row) => [normalizeStation(row.station_code), row]));
  return Array.from(new Set(stationCodes.map((stationCode) => {
    const row = rowByCode.get(normalizeStation(stationCode));
    return row?.parent_station_id ? codeById.get(row.parent_station_id) ?? normalizeStation(stationCode) : normalizeStation(stationCode);
  }))).filter(Boolean).sort();
}

export async function GET() {
  if (!supabaseAdmin) return Response.json({ error: "Supabase service key is not configured." }, { status: 500 });
  const authorization = await getAuthorization();
  if (!authorization) return Response.json({ error: "Login required." }, { status: 401 });
  const companyId = requireCompanyId(authorization);
  if (!hasPermission(authorization, "imports", "access")) return Response.json({ error: "Permission denied." }, { status: 403 });
  const { data, error } = await supabaseAdmin
    .from("report_import_batches")
    .select("id, source_type, file_name, row_count, imported_row_count, skipped_row_count, status, message, report_from, report_to, created_at")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return databaseSetupError(error.message);
  return Response.json({ imports: data ?? [] });
}

export async function POST(request: Request) {
  if (!supabaseAdmin) return Response.json({ error: "Supabase service key is not configured." }, { status: 500 });
  const db = supabaseAdmin;
  let authorization: AuthorizationContext | null;
  try {
    authorization = (await getServiceAuthorization(request)) ?? (await getAuthorization());
  } catch (error) {
    return Response.json(
      { error: error instanceof ServiceAuthError ? error.message : "Service authentication failed." },
      { status: 401 }
    );
  }
  if (!authorization) return Response.json({ error: "Login required." }, { status: 401 });
  const companyId = requireCompanyId(authorization);
  if (!hasPermission(authorization, "imports", "add") && !hasPermission(authorization, "imports", "edit")) {
    return Response.json({ error: "Report import permission denied." }, { status: 403 });
  }

  const formData = await importStep("Read uploaded form", () => request.formData());
  const sourceType = clean(formData.get("source_type")) as SourceType;
  const requestedStation = normalizeStation(formData.get("station_code"));
  const requestedReportDate = parseDate(formData.get("report_date"));
  const file = formData.get("file");
  const storageBucket = clean(formData.get("storage_bucket"));
  const storagePath = clean(formData.get("storage_path"));
  const stagedFileName = clean(formData.get("original_file_name"));
  const stagedFileSize = Number(clean(formData.get("original_file_size")) || 0);
  const master = await db.from("report_import_master")
    .select("source_code, name, file_types, parser_type, dedupe_fields, is_active, requires_station, station_scope, requires_report_date")
    .eq("company_id", companyId)
    .eq("source_code", sourceType)
    .eq("is_active", true)
    .maybeSingle();
  if (master.error) return databaseSetupError(master.error.message);
  if (!master.data) return Response.json({ error: "Select an active report from Import Master." }, { status: 400 });
  const masterData = master.data;
  const isShipmentDetail = masterData.parser_type === "delivered_shipment_detail" || masterData.parser_type === "inbound_shipment_detail";
  // Ignore stale/hidden browser fields when Import Master says that the file
  // itself is authoritative for station and date detection.
  const selectedStation = masterData.requires_station ? requestedStation : "";
  const selectedReportDate = isShipmentDetail ? requestedReportDate : masterData.requires_report_date ? requestedReportDate : null;
  const shipmentStationCodes = new Set<string>(selectedStation ? [selectedStation] : []);
  if (isShipmentDetail && !selectedStation) {
    // Report-import permission is the authority for this workflow. Auto-detection
    // must recognise every eligible company station even when the uploader's
    // day-to-day dashboard access is limited to a smaller location scope.
    const locationResult = await loadCodLocations(companyId, [], true);
    if (locationResult.error) return Response.json({ error: locationResult.error }, { status: 500 });
    const parentLocations = locationResult.locations.filter((location) => {
      const provider = providerName(location).toUpperCase();
      const model = locationModelName(location).toUpperCase();
      return provider.includes("AMAZON") && ["DSP", "EDSP"].includes(model);
    });
    parentLocations.forEach((location) => shipmentStationCodes.add(normalizeStation(location.station_code)));
    if (parentLocations.length) {
      const children = await db.from("stations").select("station_code")
        .eq("company_id", companyId)
        .in("parent_station_id", parentLocations.map((location) => location.id))
        .eq("is_active", true);
      if (children.error) return databaseSetupError(children.error.message);
      (children.data ?? []).forEach((child) => shipmentStationCodes.add(normalizeStation(child.station_code)));
    }
  } else if (masterData.requires_station || masterData.requires_report_date) {
    if ((masterData.requires_station && !selectedStation) || (masterData.requires_report_date && !selectedReportDate)) {
      return Response.json({ error: "Select the station and data date." }, { status: 400 });
    }
    const locationResult = masterData.requires_station
      ? await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess)
      : { locations: [], error: null };
    if (locationResult.error) return Response.json({ error: locationResult.error }, { status: 500 });
    const selectedLocation = locationResult.locations.find((location) => location.station_code === selectedStation);
    const selectedParentResult = selectedLocation
      ? await db.from("stations").select("parent_station_id").eq("company_id", companyId).eq("id", selectedLocation.id).maybeSingle()
      : { data: null, error: null };
    if (selectedParentResult.error) return databaseSetupError(selectedParentResult.error.message);
    if (selectedLocation && ["amazon_dsp_xpt", "amazon_dsp_xpd"].includes(masterData.station_scope)) {
      const children = await db.from("stations").select("station_code")
        .eq("company_id", companyId)
        .eq("parent_station_id", selectedLocation.id)
        .eq("is_active", true);
      if (children.error) return databaseSetupError(children.error.message);
      (children.data ?? []).forEach((child) => shipmentStationCodes.add(normalizeStation(child.station_code)));
    }
    const eligible = !masterData.requires_station || locationResult.locations.some((location) => {
      const provider = providerName(location).toUpperCase();
      const model = locationModelName(location).toUpperCase();
      return location.station_code === selectedStation
        && (!["amazon_dsp_xpt", "amazon_dsp_xpd"].includes(masterData.station_scope)
          || (provider.includes("AMAZON") && ["DSP", "EDSP"].includes(model) && !selectedParentResult.data?.parent_station_id));
    });
    if (!eligible) return Response.json({ error: "Select an eligible station for this report." }, { status: 400 });
  }
  if (!(file instanceof File) && (!storageBucket || !storagePath || !stagedFileName)) {
    return Response.json({ error: "Upload a report file." }, { status: 400 });
  }
  const fileName = file instanceof File ? file.name : stagedFileName;
  const fileSize = file instanceof File ? file.size : stagedFileSize;
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  if (!(masterData.file_types as string[]).includes(extension)) {
    return Response.json({ error: `${masterData.name} accepts ${(masterData.file_types as string[]).map((item) => `.${item}`).join(", ")} files.` }, { status: 400 });
  }

  const batch = await importStep("Create import batch", async () => db.from("report_import_batches").insert({
    company_id: companyId,
    created_by: authorization.userId,
    file_name: fileName,
    file_size: fileSize,
    source_type: sourceType,
    station_code: selectedStation || (isShipmentDetail ? "Auto-detect" : null),
    status: "Processing"
  }).select("id").single());
  if (batch.error) return databaseSetupError(batch.error.message);

  try {
    const fileBuffer = await importStep("Read uploaded file", async () => {
      if (file instanceof File) return file.arrayBuffer();
      const expectedPrefix = `${companyId}/${authorization.userId}/`;
      if (storageBucket !== "report-import-staging" || !storagePath.startsWith(expectedPrefix)) {
        throw new Error("The staged report path is invalid.");
      }
      const downloaded = await db.storage.from(storageBucket).download(storagePath);
      if (downloaded.error || !downloaded.data) throw new Error(downloaded.error?.message ?? "Unable to read the staged report.");
      const buffer = await downloaded.data.arrayBuffer();
      await db.storage.from(storageBucket).remove([storagePath]);
      return buffer;
    });
    if (masterData.parser_type === "pdf_scorecard" || masterData.parser_type === "pdf_daily_metrics") {
      const pdf = await importStep("Convert PDF to metric rows", () => readPdfMetricRows(
        fileBuffer,
        masterData.parser_type === "pdf_daily_metrics",
        masterData.parser_type === "pdf_scorecard"
      ));
      const metricRows = pdf.rows.map((row) => {
        const hash = crypto.createHash("sha256").update(JSON.stringify({
          sourceType,
          reportDate: pdf.reportDate,
          reportWeek: pdf.reportWeek,
          reportYear: pdf.reportYear,
          page: row.pageNumber,
          row: row.rowNumber,
          text: row.rawText,
          parserVersion: masterData.parser_type === "pdf_scorecard" ? 2 : 1
        })).digest("hex");
        return {
          batch_id: batch.data.id,
          company_id: companyId,
          page_number: row.pageNumber,
          raw_text: row.rawText,
          report_date: pdf.reportDate,
          report_week: pdf.reportWeek,
          report_year: pdf.reportYear,
          row_hash: hash,
          row_label: row.rowLabel,
          row_number: row.rowNumber,
          source_type: sourceType,
          station_code: row.stationCode,
          values_json: row.values
        };
      });
      const hashes = metricRows.map((row) => row.row_hash);
      const existing = new Set<string>();
      for (let index = 0; index < hashes.length; index += HASH_LOOKUP_CHUNK_SIZE) {
        const result = await db.from("report_metric_facts").select("row_hash")
          .eq("company_id", companyId).eq("source_type", sourceType).in("row_hash", hashes.slice(index, index + HASH_LOOKUP_CHUNK_SIZE));
        if (result.error) throw result.error;
        (result.data ?? []).forEach((row) => existing.add(row.row_hash));
      }
      const seen = new Set<string>();
      const validMetrics = metricRows.filter((row) => {
        if (existing.has(row.row_hash) || seen.has(row.row_hash)) return false;
        seen.add(row.row_hash);
        return true;
      });
      await importStep("Save PDF metric facts", () => insertInChunks("report_metric_facts", validMetrics, 250));
      const duplicateRows = metricRows.length - validMetrics.length;
      const message = `${validMetrics.length} table row${validMetrics.length === 1 ? "" : "s"} extracted from ${fileName}. ${duplicateRows} duplicate${duplicateRows === 1 ? "" : "s"} ignored.`;
      const scorecardPeriod = masterData.parser_type === "pdf_scorecard" && pdf.reportYear && pdf.reportWeek
        ? amazonWeekRange(pdf.reportYear, pdf.reportWeek)
        : null;
      await db.from("report_import_batches").update({
        completed_at: new Date().toISOString(),
        imported_row_count: validMetrics.length,
        message,
        report_from: pdf.reportDate ?? scorecardPeriod?.from ?? null,
        report_to: pdf.reportDate ?? scorecardPeriod?.to ?? null,
        row_count: metricRows.length,
        skipped_row_count: duplicateRows,
        status: "Completed"
      }).eq("id", batch.data.id).eq("company_id", companyId);
      return Response.json({ duplicateRows, imported: validMetrics.length, message, skipped: duplicateRows, totalRows: metricRows.length });
    }

    const workbookRows = readWorkbookRows(
      fileBuffer,
      masterData.parser_type === "delivered_shipment_detail" || masterData.parser_type === "inbound_shipment_detail"
    );
    if (masterData.parser_type === "delivered_shipment_detail") {
      const parsedFacts = await importStep("Parse delivered shipment details", () => Promise.resolve(
        parseDeliveredShipmentFacts(workbookRows, companyId, batch.data.id, selectedStation, selectedReportDate ?? "", shipmentStationCodes)
      ));
      if (!parsedFacts.facts.length) {
        const issueCounts = new Map<string, number>();
        parsedFacts.rejected.forEach((row) => issueCounts.set(row.issue, (issueCounts.get(row.issue) ?? 0) + 1));
        const reasons = [...issueCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([issue, count]) => `${count.toLocaleString("en-IN")} rows: ${issue}`)
          .join(" ");
        const message = `No valid delivered shipments were found. ${reasons || "Required shipment columns were not recognised."}`;
        await db.from("report_import_batches").update({
          completed_at: new Date().toISOString(),
          message,
          row_count: parsedFacts.sourceRows,
          skipped_row_count: parsedFacts.sourceRows,
          status: "Failed"
        }).eq("id", batch.data.id).eq("company_id", companyId);
        return Response.json({ error: message }, { status: 400 });
      }
      const dates = Array.from(new Set(parsedFacts.facts.map((row) => row.work_date))).sort();
      const detectedParents = await importStep("Resolve detected parent stations", () =>
        shipmentParentCodes(companyId, parsedFacts.facts.map((row) => row.station_code)));
      const detected = await importStep("Record detected shipment coverage", async () => db.from("report_import_batches").update({
        report_from: dates[0] ?? null,
        report_to: dates.at(-1) ?? null,
        station_code: detectedParents.join(", ") || "Auto-detect"
      }).eq("id", batch.data.id).eq("company_id", companyId));
      if (detected.error) throw new Error(detected.error.message);
      await importStep("Save delivered shipment facts", () => upsertInChunks(
        "delivered_shipment_facts",
        parsedFacts.facts,
        "company_id,tracking_id",
        750
      ));
      await importStep("Refresh delivered station coverage", async () => {
        await refreshShipmentCoverage(companyId, "delivered_shipment_detail", dates, batch.data.id);
      });
      await importStep("Refresh capacity daily summary", async () => {
        const stationCodes = Array.from(new Set(parsedFacts.facts.map((row) => row.station_code)));
        const refreshed = await db.rpc("refresh_capacity_station_daily_cache", {
          p_company_id: companyId,
          p_station_codes: stationCodes,
          p_from: dates[0],
          p_to: dates.at(-1)
        });
        if (refreshed.error) throw new Error(refreshed.error.message);
      });
      const duplicateRows = parsedFacts.sourceRows - parsedFacts.rejected.length - parsedFacts.facts.length;
      const skipped = parsedFacts.rejected.length;
      const volumeReady = parsedFacts.facts.filter((row) => row.cubic_volume_cm3 != null && row.actual_weight_kg != null).length;
      const message = `${parsedFacts.facts.length} unique tracking shipment${parsedFacts.facts.length === 1 ? "" : "s"} saved or refreshed across all worksheets. ${duplicateRows} repeated row${duplicateRows === 1 ? "" : "s"} consolidated, and ${skipped} invalid row${skipped === 1 ? "" : "s"} skipped.`;
      const update = await importStep("Mark delivered shipment import completed", async () => db.from("report_import_batches").update({
        completed_at: new Date().toISOString(),
        imported_row_count: parsedFacts.facts.length,
        message,
        report_from: dates[0] ?? null,
        report_to: dates.at(-1) ?? null,
        row_count: parsedFacts.sourceRows,
        skipped_row_count: skipped,
        station_code: detectedParents.join(", ") || "Auto-detect",
        status: "Completed"
      }).eq("id", batch.data.id).eq("company_id", companyId));
      if (update.error) throw new Error(update.error.message);
      return Response.json({
        duplicateRows,
        imported: parsedFacts.facts.length,
        message,
        skipped,
        totalRows: parsedFacts.sourceRows
      });
    }
    if (masterData.parser_type === "inbound_shipment_detail") {
      const parsedFacts = await importStep("Parse inbound shipment details", () => Promise.resolve(
        parseInboundShipmentFacts(workbookRows, companyId, batch.data.id, selectedStation, selectedReportDate ?? "", shipmentStationCodes, fileName)
      ));
      if (!parsedFacts.facts.length) {
        const issueCounts = new Map<string, number>();
        parsedFacts.rejected.forEach((row) => issueCounts.set(row.issue, (issueCounts.get(row.issue) ?? 0) + 1));
        const reasons = [...issueCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([issue, count]) => `${count.toLocaleString("en-IN")} rows: ${issue}`)
          .join(" ");
        const message = `No valid inbound shipments were found. ${reasons || "Required shipment columns were not recognised."}`;
        await db.from("report_import_batches").update({
          completed_at: new Date().toISOString(),
          message,
          row_count: parsedFacts.sourceRows,
          skipped_row_count: parsedFacts.sourceRows,
          status: "Failed"
        }).eq("id", batch.data.id).eq("company_id", companyId);
        return Response.json({ error: message }, { status: 400 });
      }
      const dates = Array.from(new Set(parsedFacts.facts.map((row) => row.expected_arrival_date))).sort();
      const detectedParents = await importStep("Resolve detected parent stations", () =>
        shipmentParentCodes(companyId, parsedFacts.facts.map((row) => row.station_code)));
      const detected = await importStep("Record detected shipment coverage", async () => db.from("report_import_batches").update({
        report_from: dates[0] ?? null,
        report_to: dates.at(-1) ?? null,
        station_code: detectedParents.join(", ") || "Auto-detect"
      }).eq("id", batch.data.id).eq("company_id", companyId));
      if (detected.error) throw new Error(detected.error.message);
      await importStep("Save inbound shipment facts", () => upsertInChunks(
        "inbound_shipment_facts",
        parsedFacts.facts,
        "company_id,tracking_id",
        750
      ));
      await importStep("Refresh inbound station coverage", async () => {
        await refreshShipmentCoverage(companyId, "inbound_shipment_detail", dates, batch.data.id);
      });
      const duplicateRows = parsedFacts.sourceRows - parsedFacts.rejected.length - parsedFacts.facts.length;
      const skipped = parsedFacts.rejected.length;
      const volumeReady = parsedFacts.facts.filter((row) => row.cubic_volume_cm3 != null && row.actual_weight_kg != null).length;
      const message = `${parsedFacts.facts.length} unique inbound shipment${parsedFacts.facts.length === 1 ? "" : "s"} saved or refreshed across all worksheets. ${duplicateRows} repeated row${duplicateRows === 1 ? "" : "s"} consolidated, and ${skipped} invalid row${skipped === 1 ? "" : "s"} skipped.`;
      const update = await importStep("Mark inbound shipment import completed", async () => db.from("report_import_batches").update({
        completed_at: new Date().toISOString(),
        imported_row_count: parsedFacts.facts.length,
        message,
        report_from: dates[0] ?? null,
        report_to: dates.at(-1) ?? null,
        row_count: parsedFacts.sourceRows,
        skipped_row_count: skipped,
        station_code: detectedParents.join(", ") || "Auto-detect",
        status: "Completed"
      }).eq("id", batch.data.id).eq("company_id", companyId));
      if (update.error) throw new Error(update.error.message);
      return Response.json({
        duplicateRows,
        imported: parsedFacts.facts.length,
        message,
        skipped,
        totalRows: parsedFacts.sourceRows
      });
    }
    const parsed = await importStep("Parse uploaded report rows", async () => masterData.parser_type === "generic_table"
      ? parseGenericFile(workbookRows)
      : parseFile(sourceType as CoreSourceType, workbookRows));
    if (sourceType === "iocl_fuel" || sourceType === "bpcl_fuel") await importStep("Map fuel vehicles to stations", () => mapFuelStations(companyId, parsed));

    const audited = await importStep("Audit duplicate rows", () => auditParsedRows(
      companyId,
      sourceType,
      parsed,
      (masterData.dedupe_fields as string[] | null) ?? []
    ));
    const valid = audited.filter((row) => row.status === "Imported" && row.normalized);
    const skipped = audited.length - valid.length;
    const duplicateRows = audited.filter((row) => row.isDuplicate).length;
    const factRows = sourceType === "amazon_shipments"
      ? audited.filter((row) => row.normalized && row.duplicateScope !== "file")
      : valid;
    const dates = factRows.map((row) => row.normalized?.workDate).filter(Boolean).sort() as string[];
    const amazonWeeks = sourceType === "amazon_shipments"
      ? Array.from(new Map(factRows.map((row) => {
        const workDate = row.normalized?.workDate;
        if (!workDate) return null;
        const week = amazonWeekInfo(workDate);
        return [`${week.amazon_week_year}-W${week.amazon_week_no}`, week] as const;
      }).filter(Boolean) as Array<readonly [string, ReturnType<typeof amazonWeekInfo>]>).values())
      : [];

    const rowPayload = audited.map((row) => ({
      amount: row.normalized?.amount ?? null,
      batch_id: batch.data.id,
      company_id: companyId,
      external_worker_id: row.normalized?.externalWorkerId ?? null,
      normalized_data: row.normalized?.normalizedData ?? {},
      raw_data: row.raw,
      row_hash: row.hash,
      row_number: row.rowNumber,
      shipment_count: row.normalized?.shipmentCount ?? null,
      source_type: sourceType,
      station_code: row.normalized?.stationCode ?? null,
      status: row.status,
      issue: row.issue,
      work_date: row.normalized?.workDate ?? null
    }));
    await importStep("Save raw import audit rows", () => insertInChunks("report_import_rows", rowPayload, 250));

    if (sourceType === "amazon_shipments") {
      const payload = aggregateAmazonRows(factRows, batch.data.id, companyId);
      await importStep("Refresh Amazon shipment totals", () => upsertInChunks("cps_shipment_daily", payload, "company_id,client,work_date,station_code,provider_employee_id", 250));
    }

    if (sourceType === "iocl_fuel" || sourceType === "bpcl_fuel") {
      const payload = valid.map((row) => ({
        amount: row.normalized!.amount ?? 0,
        company_id: companyId,
        litres: Number(row.normalized!.normalizedData.litres ?? 0),
        product: clean(row.normalized!.normalizedData.product) || null,
        provider: sourceType === "iocl_fuel" ? "IOC" : "BPCL",
        raw_payload: row.raw,
        source_batch_id: batch.data.id,
        station_code: row.normalized!.stationCode ?? null,
        transaction_date: row.normalized!.workDate!,
        transaction_id: clean(row.normalized!.normalizedData.transaction_id),
        vehicle_no: clean(row.normalized!.normalizedData.vehicle_no) || null
      }));
      await importStep("Save fuel transactions", () => upsertInChunks("cps_fuel_daily", payload, "company_id,provider,transaction_id", 250));
    }

    if (sourceType === "cashbook") {
      const payload = valid.map((row) => ({
        amount: row.normalized!.amount ?? 0,
        category: clean(row.normalized!.normalizedData.category) || null,
        company_id: companyId,
        cps_head: clean(row.normalized!.normalizedData.cps_head) || "Other CPS",
        cps_sub_head: clean(row.normalized!.normalizedData.cps_sub_head) || null,
        expense_date: row.normalized!.workDate!,
        expense_type: clean(row.normalized!.normalizedData.expense_type) || null,
        raw_payload: row.raw,
        source_file_name: fileName,
        source_row_hash: row.hash,
        remarks: clean(row.normalized!.normalizedData.remarks) || null,
        source_batch_id: batch.data.id,
        station_code: row.normalized!.stationCode!
      }));
      await importStep("Save cashbook expenses", () => upsertInChunks("cps_cashbook_daily", payload, "company_id,source_row_hash", 250));
    }

    await importStep("Recalculate CPS rows", () => recalculateCps(companyId, factRows.map((row) => ({ stationCode: row.normalized?.stationCode, workDate: row.normalized?.workDate }))));
    const factRowCount = sourceType === "amazon_shipments" ? aggregateAmazonRows(factRows, batch.data.id, companyId).length : valid.length;
    const amazonWeekMessage = amazonWeeks.length
      ? ` Amazon week${amazonWeeks.length === 1 ? "" : "s"} ${amazonWeeks.map((week) => `${week.amazon_week_no} (${week.amazon_week_from} to ${week.amazon_week_to})`).join(", ")}.`
      : "";
    const message = sourceType === "amazon_shipments"
      ? `${factRowCount} station/date/associate shipment total${factRowCount === 1 ? "" : "s"} refreshed from ${factRows.length} weekly row${factRows.length === 1 ? "" : "s"}.${amazonWeekMessage} ${skipped} raw rows skipped, including ${duplicateRows} duplicate${duplicateRows === 1 ? "" : "s"}.`
      : `${valid.length} ${sourceLabels[sourceType] ?? masterData.name} row${valid.length === 1 ? "" : "s"} imported. ${skipped} skipped, including ${duplicateRows} duplicate${duplicateRows === 1 ? "" : "s"}.`;

    const update = await importStep("Mark import completed", async () => db.from("report_import_batches").update({
      completed_at: new Date().toISOString(),
      imported_row_count: valid.length,
      message,
      report_from: dates[0] ?? null,
      report_to: dates.at(-1) ?? null,
      row_count: audited.length,
      skipped_row_count: skipped,
      status: "Completed"
    }).eq("id", batch.data.id).eq("company_id", companyId));
    if (update.error) throw new Error(update.error.message);

    return Response.json({
      duplicateRows,
      imported: sourceType === "amazon_shipments" ? factRowCount : valid.length,
      message,
      skipped,
      totalRows: audited.length
    });
  } catch (error) {
    await db.from("report_import_batches").update({
      completed_at: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Import failed.",
      status: "Failed"
    }).eq("id", batch.data.id).eq("company_id", companyId);
    return databaseSetupError(error instanceof Error ? error.message : "Unable to import report.");
  }
}
