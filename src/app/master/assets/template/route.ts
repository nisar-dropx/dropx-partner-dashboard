import * as XLSX from "xlsx";
import { financeContext } from "@/lib/finance/data";

export const dynamic = "force-dynamic";

export async function GET() {
  await financeContext("finance_assets");
  const headers = ["Category", "Asset type", "Location code", "Ownership", "Condition", "Manufacturer", "Model", "Serial number", "Invoice number", "Purchase order number", "Purchase date", "Taxable base value", "GST rate", "GST amount", "Total landed value", "Vendor", "Notes", "Rental vendor", "Agreement number", "Rental invoice", "Rental rate", "Billing frequency", "Security deposit", "Rental starts on", "Rental ends on", "Notice days"];
  const sample = ["IT", "Laptop", "BLR-01", "owned", "good", "Example Make", "Example model", "SERIAL-001", "INV-001", "PO-001", "2026-09-21", "50000", "18", "9000", "59000", "Example supplier", "One physical item per row", "", "", "", "", "monthly", "", "", "", ""];
  const instructions = [["DropX Asset Register – Bulk Upload Guide"], ["Start here", "Use one row for one physical asset. Do not enter your own asset code: the system generates a unique code and Code 39 barcode after import."], ["Required columns", "Category and Asset type are required. Ownership is owned, rented, or leased. Condition is good, fair, damaged, or unusable."], ["Location", "Location code must exactly match the Finance location/station code. Leave it empty for Finance holding/unassigned assets."], ["Owned purchase value", "Taxable base value is before GST. GST rate is a percentage (for example 18). GST amount and Total landed value are amounts in INR. All commercial values are optional but strongly recommended."], ["Rented / leased", "Rental vendor, Rental rate, and Rental starts on are required. Billing frequency is daily, weekly, monthly, or yearly. Record security deposit, agreement, invoice, end date and notice days where available."], ["Dates", "Use YYYY-MM-DD (for example 2026-09-21)."], ["Before upload", "Do not rename the Assets sheet headers. Maximum 200 assets per file. Correct rows with a reported error and upload them again."]];
  const workbook = XLSX.utils.book_new();
  const assets = XLSX.utils.aoa_to_sheet([headers, sample]);
  assets["!cols"] = headers.map((header) => ({ wch: Math.max(14, header.length + 3) }));
  XLSX.utils.book_append_sheet(workbook, assets, "Assets");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(instructions), "Instructions");
  const body = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
  return new Response(new Uint8Array(body), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": "attachment; filename=dropx-asset-register-template.xlsx", "cache-control": "no-store" } });
}
