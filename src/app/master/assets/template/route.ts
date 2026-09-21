import * as XLSX from "xlsx";
import { financeContext } from "@/lib/finance/data";

export const dynamic = "force-dynamic";

export async function GET() {
  await financeContext("finance_assets");
  const headers = ["Category", "Asset type", "Location code", "Ownership", "Condition", "Manufacturer", "Model", "Serial number", "Invoice number", "Purchase order number", "Purchase date", "Purchase value", "Vendor", "Notes", "Rental vendor", "Agreement number", "Rental invoice", "Rental rate", "Billing frequency", "Security deposit", "Rental starts on", "Rental ends on", "Notice days"];
  const sample = ["IT", "Laptop", "BLR-01", "owned", "good", "Example Make", "Example model", "SERIAL-001", "INV-001", "PO-001", "2026-09-21", "50000", "Example supplier", "One physical item per row", "", "", "", "", "monthly", "", "", "", ""];
  const instructions = [["Asset register bulk upload"], ["One physical asset per row. Location code must match the Finance location/station code."], ["Ownership must be owned, rented, or leased. For rented/leased assets, Rental vendor, Rental rate, and Rental starts on are required."], ["Dates use YYYY-MM-DD. Do not change the header row on the Assets sheet."]];
  const workbook = XLSX.utils.book_new();
  const assets = XLSX.utils.aoa_to_sheet([headers, sample]);
  assets["!cols"] = headers.map((header) => ({ wch: Math.max(14, header.length + 3) }));
  XLSX.utils.book_append_sheet(workbook, assets, "Assets");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(instructions), "Instructions");
  const body = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
  return new Response(new Uint8Array(body), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": "attachment; filename=dropx-asset-register-template.xlsx", "cache-control": "no-store" } });
}
