import { excelReportValue } from "./report-table-values";

export type ExcelReport = { title: string; headers: string[]; rows: (string | number | boolean | null)[][]; scope: string };
export async function downloadReportExcel({ title, headers, rows, scope }: ExcelReport) {
  const XLSX = await import("xlsx");
  const values = rows.map(row => row.map((v, i) => typeof v === "string" ? excelReportValue(v, headers[i] || "") : v));
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...values]);
  if (headers.length) {
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: values.length, c: headers.length - 1 } }) };
    sheet["!cols"] = headers.map((h, i) => ({ wch: Math.min(55, Math.max(12, h.length + 2, ...values.slice(0, 200).map(r => String(r[i] ?? "").length + 2))) }));
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Report");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["Report", title], ["Scope", scope], ["Rows", rows.length],
    ["Exported at (IST)", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })],
  ]), "Export details");
  XLSX.writeFile(workbook, `${title.replace(/[^a-z0-9 -]/gi, "").trim().replace(/\s+/g, "-").slice(0, 90) || "OpsPulse-report"}.xlsx`, { compression: true });
}
