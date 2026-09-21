"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { hasPermission } from "@/lib/authorization";
import { assetPrefix } from "@/lib/assets";
import { financeContext } from "@/lib/finance/data";

const ownership = new Set(["owned", "rented", "leased"]);
const conditions = new Set(["good", "fair", "damaged", "unusable"]);
const frequencies = new Set(["daily", "weekly", "monthly", "yearly"]);
const text = (value: unknown, max = 160) => String(value ?? "").trim().slice(0, max);
const nullable = (value: unknown, max = 160) => text(value, max) || null;
const date = (value: unknown) => {
  const result = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
};
const amount = (value: unknown, label: string, required = false) => {
  const raw = text(value, 30);
  if (!raw && !required) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) < 0) throw new Error(`${label} must be a non-negative amount.`);
  return raw;
};
const normalizedHeader = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const cell = (row: Record<string, unknown>, aliases: string[]) => {
  const values = new Map(Object.entries(row).map(([key, value]) => [normalizedHeader(key), value]));
  for (const alias of aliases) {
    const value = values.get(normalizedHeader(alias));
    if (value != null && String(value).trim()) return value;
  }
  return "";
};
const spreadsheetDate = (value: unknown) => {
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return match ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` : raw;
};

async function typeForInput(context: Awaited<ReturnType<typeof financeContext>>, categoryName: string, typeName: string) {
  const categoryCode = assetPrefix(categoryName);
  let category = await context.db.from("asset_categories").select("id").eq("company_id", context.companyId).eq("code", categoryCode).maybeSingle();
  if (category.error) throw new Error("Unable to load asset categories.");
  if (!category.data) {
    const created = await context.db.from("asset_categories").insert({ company_id: context.companyId, code: categoryCode, name: categoryName, created_by: context.authorization.userId, updated_by: context.authorization.userId }).select("id").single();
    if (created.error) throw new Error("Unable to create this asset category.");
    category = created;
  }
  const categoryId = category.data?.id;
  if (!categoryId) throw new Error("Unable to resolve this asset category.");
  const typeCode = assetPrefix(typeName);
  const assetCodePrefix = assetPrefix(`${categoryCode.slice(0, 3)}${typeCode.slice(0, 5)}`);
  let type = await context.db.from("asset_types").select("id,asset_code_prefix").eq("company_id", context.companyId).eq("category_id", categoryId).eq("code", typeCode).maybeSingle();
  if (type.error) throw new Error("Unable to load asset types.");
  if (!type.data) {
    const created = await context.db.from("asset_types").insert({ company_id: context.companyId, category_id: categoryId, code: typeCode, name: typeName, asset_code_prefix: assetCodePrefix, created_by: context.authorization.userId, updated_by: context.authorization.userId }).select("id,asset_code_prefix").single();
    if (created.error) throw new Error("Unable to create this asset type.");
    type = created;
  }
  if (!type.data) throw new Error("Unable to resolve this asset type.");
  return type.data;
}

export async function registerAsset(input: unknown) {
  try {
    const context = await financeContext("finance_assets");
    if (!hasPermission(context.authorization, "finance_assets", "add")) throw new Error("Your Finance role cannot add assets.");
    if (!input || typeof input !== "object") throw new Error("Enter the asset details.");
    const item = input as Record<string, unknown>;
    const categoryName = text(item.category_name, 100);
    const typeName = text(item.type_name, 100);
    const locationId = nullable(item.location_id, 36);
    const ownershipType = text(item.ownership_type, 16).toLowerCase();
    const condition = text(item.condition, 16).toLowerCase();
    const gstRate = amount(item.gst_rate, "GST rate");
    if (!categoryName || !typeName) throw new Error("Category and asset type are required.");
    if (!ownership.has(ownershipType)) throw new Error("Choose owned, rented or leased.");
    if (!conditions.has(condition)) throw new Error("Choose a valid asset condition.");
    if (gstRate && Number(gstRate) > 100) throw new Error("GST rate cannot exceed 100%.");
    if (locationId && !context.locations.some((location) => location.id === locationId)) throw new Error("This location is outside your Finance scope.");
    const rentalVendor = text(item.rental_vendor_name, 160);
    const rentalStartsOn = date(item.rental_starts_on);
    const rentalRate = ownershipType === "owned" ? null : amount(item.rental_rate, "Rental rate", true);
    if (ownershipType !== "owned" && (!rentalVendor || !rentalStartsOn || !rentalRate)) throw new Error("Rental vendor, start date and rate are required for rented or leased assets.");
    const type = await typeForInput(context, categoryName, typeName);
    const codeResult = await context.db.rpc("asset_next_code", { p_company_id: context.companyId, p_prefix: assetPrefix(String(type.asset_code_prefix || typeName)) });
    if (codeResult.error || !codeResult.data) throw new Error("Unable to allocate a unique asset code.");
    const assetCode = String(codeResult.data);
    const created = await context.db.from("assets").insert({
      company_id: context.companyId, asset_type_id: type.id, asset_code: assetCode, barcode_value: assetCode,
      location_id: locationId, manufacturer: nullable(item.manufacturer), model: nullable(item.model), serial_number: nullable(item.serial_number),
      purchase_order_number: nullable(item.purchase_order_number), invoice_number: nullable(item.invoice_number), purchase_date: date(item.purchase_date),
      purchase_value: amount(item.purchase_value, "Taxable/base value"), gst_rate: gstRate, gst_amount: amount(item.gst_amount, "GST amount"), total_value: amount(item.total_value, "Total landed value"), warranty_expiry_date: date(item.warranty_expiry_date), vendor_name: nullable(item.vendor_name),
      ownership_type: ownershipType, status: "available", condition, notes: nullable(item.notes, 1000), created_by: context.authorization.userId, updated_by: context.authorization.userId,
    }).select("id").single();
    if (created.error) throw new Error("Unable to save this asset.");
    if (ownershipType !== "owned") {
      const rental = await context.db.from("asset_rental_terms").insert({
        company_id: context.companyId, asset_id: created.data.id, vendor_name: rentalVendor, agreement_number: nullable(item.rental_agreement_number), invoice_number: nullable(item.rental_invoice_number),
        rental_rate: rentalRate, billing_frequency: frequencies.has(text(item.rental_billing_frequency, 16)) ? text(item.rental_billing_frequency, 16) : "monthly",
        security_deposit: amount(item.rental_security_deposit, "Security deposit") ?? "0", starts_on: rentalStartsOn, ends_on: date(item.rental_ends_on),
        notice_period_days: Math.max(0, Math.min(365, Number.parseInt(text(item.rental_notice_period_days, 4) || "0", 10) || 0)), status: "active", created_by: context.authorization.userId, updated_by: context.authorization.userId,
      });
      if (rental.error) throw new Error("Asset was added, but rental terms could not be saved. Please refresh and complete them before use.");
    }
    await context.db.from("asset_events").insert({ company_id: context.companyId, asset_id: created.data.id, event_type: "registered", to_status: "available", to_condition: condition, to_location_id: locationId, actor_user_id: context.authorization.userId, actor_name: context.authorization.fullName || context.authorization.email || "Finance" });
    revalidatePath("/master/assets"); revalidatePath("/finance"); revalidatePath("/people/assets");
    return { ok: true as const, id: created.data.id, code: assetCode };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Unable to add the asset." };
  }
}

export async function bulkRegisterAssets(form: FormData) {
  try {
    const context = await financeContext("finance_assets");
    if (!hasPermission(context.authorization, "finance_assets", "add")) throw new Error("Your Finance role cannot bulk upload assets.");
    const file = form.get("bulk_file");
    if (!(file instanceof File) || !file.size) throw new Error("Choose the completed Asset Register template.");
    if (file.size > 5 * 1024 * 1024) throw new Error("Bulk upload files must be 5 MB or smaller.");
    const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer", cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error("The uploaded file does not contain a worksheet.");
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    if (!rows.length) throw new Error("The uploaded file does not contain any asset rows.");
    if (rows.length > 200) throw new Error("Upload a maximum of 200 assets at a time.");
    const locations = new Map(context.locations.map((location) => [String(location.station_code).toUpperCase(), String(location.id)]));
    const results: string[] = [];
    let imported = 0;
    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      const locationCode = String(cell(row, ["Location code", "Location", "Station code"]) ?? "").trim().toUpperCase();
      const locationId = locationCode ? locations.get(locationCode) : "";
      if (locationCode && !locationId) { results.push(`Row ${rowNumber}: Location ${locationCode} is not in your Finance scope.`); continue; }
      const input = {
        category_name: cell(row, ["Category"]), type_name: cell(row, ["Asset type", "Type"]), location_id: locationId || "",
        ownership_type: String(cell(row, ["Ownership", "Ownership type"]) || "owned").toLowerCase(), condition: String(cell(row, ["Condition"]) || "good").toLowerCase(),
        manufacturer: cell(row, ["Manufacturer", "Make"]), model: cell(row, ["Model"]), serial_number: cell(row, ["Serial number", "Serial", "Chassis number"]),
        invoice_number: cell(row, ["Invoice number", "Invoice"]), purchase_order_number: cell(row, ["Purchase order number", "PO number"]), purchase_date: spreadsheetDate(cell(row, ["Purchase date"])), purchase_value: cell(row, ["Taxable base value", "Purchase value", "Purchase value inr"]), gst_rate: cell(row, ["GST rate", "GST rate percent"]), gst_amount: cell(row, ["GST amount"]), total_value: cell(row, ["Total landed value", "Total value"]), vendor_name: cell(row, ["Vendor", "Supplier"]), notes: cell(row, ["Notes"]),
        rental_vendor_name: cell(row, ["Rental vendor"]), rental_agreement_number: cell(row, ["Agreement number"]), rental_invoice_number: cell(row, ["Rental invoice"]), rental_rate: cell(row, ["Rental rate", "Rate"]), rental_billing_frequency: String(cell(row, ["Billing frequency", "Frequency"]) || "monthly").toLowerCase(), rental_security_deposit: cell(row, ["Security deposit"]), rental_starts_on: spreadsheetDate(cell(row, ["Rental starts on", "Starts on"])), rental_ends_on: spreadsheetDate(cell(row, ["Rental ends on", "Ends on"])), rental_notice_period_days: cell(row, ["Notice days", "Notice period days"]),
      };
      const saved = await registerAsset(input);
      if (saved.ok) imported += 1; else results.push(`Row ${rowNumber}: ${saved.error}`);
    }
    revalidatePath("/master/assets");
    return { ok: imported > 0, imported, errors: results.slice(0, 12), error: imported ? undefined : results[0] || "No assets were imported." };
  } catch (error) { return { ok: false as const, imported: 0, errors: [], error: error instanceof Error ? error.message : "Unable to bulk upload assets." }; }
}

export async function uploadAssetAttachment(form: FormData) {
  try {
    const context = await financeContext("finance_assets");
    if (!hasPermission(context.authorization, "finance_assets", "edit")) throw new Error("Your Finance role cannot attach asset documents.");
    const assetId = text(form.get("asset_id"), 36); const attachmentType = text(form.get("attachment_type"), 20).toLowerCase(); const file = form.get("file");
    if (!/^[0-9a-f-]{36}$/i.test(assetId) || !(file instanceof File)) throw new Error("Choose an asset and a file to attach.");
    if (!["invoice", "photo", "agreement", "other"].includes(attachmentType)) throw new Error("Choose a valid attachment type.");
    if (!Number.isInteger(file.size) || file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error("Choose a file up to 10 MB.");
    const asset = await context.db.from("assets").select("id,location_id").eq("company_id", context.companyId).eq("id", assetId).maybeSingle();
    if (asset.error || !asset.data || (!context.authorization.hasAllLocationAccess && asset.data.location_id && !context.authorization.locationScopeIds.includes(asset.data.location_id))) throw new Error("This asset is outside your Finance scope.");
    const extension = file.name.split(".").pop()?.toLowerCase(); const contentType = extension === "pdf" ? "application/pdf" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : null;
    if (!contentType || (file.type && file.type !== "application/octet-stream" && file.type !== contentType)) throw new Error("Upload a PDF, JPG, PNG or WEBP file.");
    const bytes = Buffer.from(await file.arrayBuffer()); const starts = (signature: number[]) => signature.every((part, index) => bytes[index] === part);
    if (!((contentType === "application/pdf" && starts([37,80,68,70,45])) || (contentType === "image/jpeg" && starts([255,216,255])) || (contentType === "image/png" && starts([137,80,78,71,13,10,26,10])) || (contentType === "image/webp" && bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP"))) throw new Error("The uploaded file content does not match its format.");
    const id = randomUUID(); const path = `${context.companyId}/${assetId}/${id}.${contentType === "image/jpeg" ? "jpg" : extension}`; const fileName = file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim().slice(0, 180);
    const upload = await context.db.storage.from("asset-evidence").upload(path, bytes, { contentType, upsert: false, cacheControl: "0" });
    if (upload.error) throw new Error("The file could not be uploaded.");
    const saved = await context.db.from("asset_attachments").insert({ id, company_id: context.companyId, asset_id: assetId, attachment_type: attachmentType, file_name: fileName, content_type: contentType, file_size: bytes.length, storage_bucket: "asset-evidence", storage_path: path, uploaded_by: context.authorization.userId });
    if (saved.error) { await context.db.storage.from("asset-evidence").remove([path]); throw new Error("The document could not be linked to the asset."); }
    await context.db.from("asset_events").insert({ company_id: context.companyId, asset_id: assetId, event_type: "attachment_added", notes: `${attachmentType}: ${fileName}`, actor_user_id: context.authorization.userId, actor_name: context.authorization.fullName || context.authorization.email || "Finance" });
    revalidatePath("/master/assets"); return { ok: true as const };
  } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Unable to attach this file." }; }
}
