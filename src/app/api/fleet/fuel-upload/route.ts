export const dynamic = "force-dynamic";

import * as XLSX from "xlsx";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getWheelseyeAccessToken } from "@/lib/wheelseye";
import { saveDailyWheelseyeKm } from "@/lib/fleet/gps-storage";
import { loadWheelseyeMovement } from "@/lib/wheelseye-history";

type FuelProvider = "IOC" | "BPCL";
type SheetRow = Array<string | number | boolean | null | undefined>;

type ParsedFuelTransaction = {
  provider: FuelProvider;
  transaction_id: string;
  transaction_at: string;
  transaction_date: string;
  vehicle_no: string;
  card_no: string | null;
  product: string | null;
  station_name: string | null;
  station_location: string | null;
  fuel_quantity: number;
  fuel_amount: number;
  rate: number | null;
  odometer: number | null;
  raw_payload: Record<string, string>;
};

export async function POST(request: Request) {
  if (!supabaseAdmin) return Response.json({ error: "Supabase service key is not configured." }, { status: 500 });
  const authorization = await getAuthorization();
  if (!authorization) return Response.json({ error: "Login required." }, { status: 401 });
  const companyId = requireCompanyId(authorization);
  if (!hasPermission(authorization, "fleet_fuel_log", "add") && !hasPermission(authorization, "fleet_fuel_log", "edit") && !hasPermission(authorization, "fleet", "add") && !hasPermission(authorization, "fleet", "edit")) {
    return Response.json({ error: "Fuel upload permission denied." }, { status: 403 });
  }

  const formData = await request.formData();
  const provider = String(formData.get("provider") ?? "").trim().toUpperCase() as FuelProvider;
  const file = formData.get("file");
  if (provider !== "IOC" && provider !== "BPCL") return Response.json({ error: "Select fuel provider IOC or BPCL." }, { status: 400 });
  if (!(file instanceof File)) return Response.json({ error: "Upload a fuel transaction file." }, { status: 400 });

  try {
    const rows = readWorkbookRows(await file.arrayBuffer());
    const detectedProvider = detectProvider(rows);
    if (!detectedProvider) return Response.json({ error: "File format not recognised. Upload IOC CSV or BPCL Excel report." }, { status: 400 });
    if (detectedProvider !== provider) {
      return Response.json({ error: `Selected provider is ${provider}, but uploaded file looks like ${detectedProvider}.` }, { status: 400 });
    }

    const transactions = provider === "IOC" ? parseIocRows(rows) : parseBpclRows(rows);
    if (!transactions.length) {
      return Response.json({ error: provider === "IOC" ? "No IOC fuel Sale transactions found in this file." : "No BPCL SALE fuel transactions found in this file." }, { status: 400 });
    }
    const vehicleResult = await supabaseAdmin
      .from("fleet_vehicles")
      .select("vehicle_no")
      .eq("company_id", companyId)
      .in("vehicle_no", Array.from(new Set(transactions.map((row) => row.vehicle_no))));
    if (vehicleResult.error) return databaseSetupError(vehicleResult.error.message);
    const allowedVehicles = new Set((vehicleResult.data ?? []).map((row) => String(row.vehicle_no).toUpperCase()));
    const companyTransactions = transactions.filter((row) => allowedVehicles.has(row.vehicle_no));
    if (!companyTransactions.length) {
      return Response.json({ error: "No fuel rows matched vehicles in the current company." }, { status: 400 });
    }

    const existing = await supabaseAdmin
      .from("fleet_fuel_transactions")
      .select("transaction_id")
      .eq("company_id", companyId)
      .eq("provider", provider)
      .in("transaction_id", companyTransactions.map((row) => row.transaction_id));
    if (existing.error) return databaseSetupError(existing.error.message);

    const existingIds = new Set((existing.data ?? []).map((row) => row.transaction_id));
    const newTransactions = companyTransactions
      .filter((row) => !existingIds.has(row.transaction_id))
      .map((row) => ({ ...row, company_id: companyId }));
    let savedRows: Array<{ vehicle_no: string; transaction_date: string }> = [];
    if (newTransactions.length) {
      const inserted = await supabaseAdmin.from("fleet_fuel_transactions").insert(newTransactions).select("vehicle_no, transaction_date");
      if (inserted.error) return databaseSetupError(inserted.error.message);
      savedRows = inserted.data ?? [];
      await syncWheelseyeKm(savedRows, companyId);
    }

    const stored = await supabaseAdmin
      .from("fleet_fuel_transactions")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("provider", provider);
    if (stored.error) return databaseSetupError(stored.error.message);

    if (newTransactions.length && savedRows.length === 0) {
      return Response.json({ error: "Upload parsed fuel rows, but Supabase did not return saved rows. Please check fleet_fuel_transactions RLS/service key setup." }, { status: 500 });
    }

    return Response.json({
      provider,
      totalRows: companyTransactions.length,
      inserted: newTransactions.length,
      skipped: companyTransactions.length - newTransactions.length,
      storedTotal: stored.count ?? 0,
      message: `${newTransactions.length} fuel transaction${newTransactions.length === 1 ? "" : "s"} imported. ${companyTransactions.length - newTransactions.length} duplicate${companyTransactions.length - newTransactions.length === 1 ? "" : "s"} ignored. Stored ${stored.count ?? 0} ${provider} row${stored.count === 1 ? "" : "s"}.`
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to import fuel file." }, { status: 400 });
  }
}

function readWorkbookRows(buffer: ArrayBuffer) {
  const workbook = XLSX.read(buffer, { type: "array", raw: false, cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<SheetRow>(sheet, { header: 1, raw: false, defval: "" });
}

function detectProvider(rows: SheetRow[]): FuelProvider | null {
  const allText = rows.slice(0, 20).map((row) => row.map(cellText).join("|")).join("\n").toLowerCase();
  if (allText.includes("txn id") && allText.includes("vehicle no. (card)") && allText.includes("customer transaction details report")) return "IOC";
  if (allText.includes("sale transaction history report") && allText.includes("bharat petroleum")) return "BPCL";
  if (findHeaderRow(rows, ["Txn ID", "Vehicle No. (Card)", "Txn Type"]) >= 0) return "IOC";
  if (findHeaderRow(rows, ["Transaction ID", "Vehicle Number", "Product Volume /  Quantity (Litres)"]) >= 0) return "BPCL";
  return null;
}

function parseIocRows(rows: SheetRow[]) {
  const headerIndex = findHeaderRow(rows, ["Txn ID", "Vehicle No. (Card)", "Txn Type"]);
  if (headerIndex < 0) throw new Error("IOC transaction header was not found.");
  const header = buildHeader(rows[headerIndex]);

  return rows.slice(headerIndex + 1).map((row) => rowToObject(rows[headerIndex], row)).filter((raw) => clean(raw["Txn Type"]).toLowerCase() === "sale").map((raw) => {
    const transactionId = clean(raw["Txn ID"]);
    const vehicleNo = normalizeVehicle(raw["Vehicle No. (Card)"] || raw["VehicleNo (User Entry)"]);
    const quantity = toNumber(raw.Quantity);
    const amount = toNumber(raw.Amount);
    if (!transactionId || !vehicleNo || quantity <= 0 || amount <= 0) return null;
    const parsedDate = parseIndianDateTime(raw["Txn Date"]);
    if (!parsedDate) return null;
    return {
      provider: "IOC" as const,
      transaction_id: transactionId,
      transaction_at: parsedDate.iso,
      transaction_date: parsedDate.date,
      vehicle_no: vehicleNo,
      card_no: clean(raw["Customer ID/Card PAN"]) || clean(raw["Txn Mode Value"]) || null,
      product: clean(raw.Product).replace(/^'/, "") || null,
      station_name: clean(raw["Merchant Name"]) || null,
      station_location: clean(raw.Location) || null,
      fuel_quantity: quantity,
      fuel_amount: amount,
      rate: toNullableNumber(raw.RSP),
      odometer: toNullableNumber(raw["Odometer (User Entry)"]),
      raw_payload: normalizeRawPayload(raw, header)
    };
  }).filter(Boolean) as ParsedFuelTransaction[];
}

function parseBpclRows(rows: SheetRow[]) {
  const headerIndex = findHeaderRow(rows, ["Transaction ID", "Vehicle Number", "Product Volume /  Quantity (Litres)"]);
  if (headerIndex < 0) throw new Error("BPCL transaction header was not found.");
  const header = buildHeader(rows[headerIndex]);

  return rows.slice(headerIndex + 1).map((row) => rowToObject(rows[headerIndex], row)).filter((raw) => clean(raw["Transaction Category"]).toLowerCase() === "sale").map((raw) => {
    const transactionId = clean(raw["Transaction ID"]);
    const vehicleNo = normalizeVehicle(raw["Vehicle Number"] || raw["Name of Card"] || raw["Custom Card Name"]);
    const quantity = toNumber(raw["Product Volume /  Quantity (Litres)"]);
    const amount = toNumber(raw["Purchase Amount(Rs.)"] || raw["Total Transaction Amount (Rs.)"]);
    if (!transactionId || !vehicleNo || quantity <= 0 || amount <= 0) return null;
    const parsedDate = parseBpclDateTime(raw["Transaction Date"], raw["Transaction Time"]);
    if (!parsedDate) return null;
    return {
      provider: "BPCL" as const,
      transaction_id: transactionId,
      transaction_at: parsedDate.iso,
      transaction_date: parsedDate.date,
      vehicle_no: vehicleNo,
      card_no: clean(raw["Card Number"]) || null,
      product: clean(raw["Product Name"]) || null,
      station_name: clean(raw["Fuel Station Name (Retail Outlet Name)"]) || null,
      station_location: clean(raw["Fuel Station (Retail Outlet) City"] || raw["Fuel Station (Retail Outlet) Location"]) || null,
      fuel_quantity: quantity,
      fuel_amount: amount,
      rate: toNullableNumber(raw["Rate (Rs. / Litre)"]),
      odometer: null,
      raw_payload: normalizeRawPayload(raw, header)
    };
  }).filter(Boolean) as ParsedFuelTransaction[];
}

function findHeaderRow(rows: SheetRow[], requiredLabels: string[]) {
  return rows.findIndex((row) => {
    const labels = row.map((cell) => cellText(cell).toLowerCase());
    return requiredLabels.every((label) => labels.includes(label.toLowerCase()));
  });
}

function buildHeader(row: SheetRow) {
  return row.map(cellText).filter(Boolean);
}

function rowToObject(header: SheetRow, row: SheetRow) {
  const record: Record<string, string> = {};
  header.forEach((label, index) => {
    const key = cellText(label);
    if (key) record[key] = clean(row[index]);
  });
  return record;
}

function normalizeRawPayload(raw: Record<string, string>, header: string[]) {
  return header.reduce<Record<string, string>>((payload, key) => {
    payload[key] = clean(raw[key]);
    return payload;
  }, {});
}

async function syncWheelseyeKm(rows: Array<{ vehicle_no: string; transaction_date: string }>, companyId: string) {
  const token = await getWheelseyeAccessToken(companyId);
  if (!token || !supabaseAdmin) return;
  const uniquePairs = Array.from(new Map(rows.map((row) => [`${row.vehicle_no}|${row.transaction_date}`, row])).values());

  for (const row of uniquePairs) {
    try {
      const movement = await loadWheelseyeMovement(token, row.vehicle_no, row.transaction_date);
      await saveDailyWheelseyeKm(companyId, row.vehicle_no, row.transaction_date, movement.summary);
    } catch {
      // Fuel import should not fail when one vehicle has no WheelEye movement for that day.
    }
  }
}

function databaseSetupError(message: string) {
  if (message.includes("fleet_fuel_transactions") || message.includes("fleet_daily_km")) {
    return Response.json({ error: `${message} Run scripts/fleet_fuel_transactions_v1.sql in Supabase SQL Editor.` }, { status: 400 });
  }
  return Response.json({ error: message }, { status: 400 });
}

function clean(value: unknown) {
  return String(value ?? "").trim().replace(/^'+/, "").replace(/'+$/, "");
}

function cellText(value: unknown) {
  return clean(value);
}

function normalizeVehicle(value: unknown) {
  return clean(value).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function toNumber(value: unknown) {
  const parsed = Number(clean(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: unknown) {
  const parsed = toNumber(value);
  return parsed || parsed === 0 ? parsed : null;
}

function parseIndianDateTime(value: unknown) {
  const match = clean(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, dd, mm, yyyy, hour = "00", minute = "00", second = "00"] = match;
  return datePartsToIso(yyyy, mm, dd, hour, minute, second);
}

function parseBpclDateTime(dateValue: unknown, timeValue: unknown) {
  const dateMatch = clean(dateValue).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!dateMatch) return null;
  const [, dd, monthText, yyyy] = dateMatch;
  const month = monthNumber(monthText);
  if (!month) return null;
  let hour = 0;
  let minute = 0;
  let second = 0;
  const timeMatch = clean(timeValue).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
    second = Number(timeMatch[3] || 0);
    const meridian = (timeMatch[4] || "").toUpperCase();
    if (meridian === "PM" && hour < 12) hour += 12;
    if (meridian === "AM" && hour === 12) hour = 0;
  }
  return datePartsToIso(yyyy, month, dd, String(hour), String(minute), String(second));
}

function datePartsToIso(yyyy: string, mm: string, dd: string, hour: string, minute: string, second: string) {
  const date = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  const local = `${date}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}+05:30`;
  const parsed = new Date(local);
  if (Number.isNaN(parsed.getTime())) return null;
  return { date, iso: parsed.toISOString() };
}

function monthNumber(value: string) {
  const months: Record<string, string> = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12"
  };
  return months[value.toLowerCase()];
}
