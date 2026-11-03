import { excelReportValue } from "./report-table-values";

export type ExcelSheetAoa = {
  name: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
};

export type ExcelReport = {
  title: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
  scope: string;
  /** Extra sheets after Report (e.g. Station board All TIDs). */
  extraSheets?: ExcelSheetAoa[];
};

function appendAoaSheet(
  XLSX: typeof import("xlsx"),
  workbook: import("xlsx").WorkBook,
  name: string,
  headers: string[],
  rows: (string | number | boolean | null)[][],
) {
  const values = rows.map((row) =>
    row.map((v, i) => (typeof v === "string" ? excelReportValue(v, headers[i] || "") : v)),
  );
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...values]);
  if (headers.length) {
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: values.length, c: headers.length - 1 } }),
    };
    sheet["!cols"] = headers.map((h, i) => ({
      wch: Math.min(55, Math.max(12, h.length + 2, ...values.slice(0, 200).map((r) => String(r[i] ?? "").length + 2))),
    }));
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
}

export async function downloadReportExcel({ title, headers, rows, scope, extraSheets }: ExcelReport) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  appendAoaSheet(XLSX, workbook, "Report", headers, rows);
  for (const extra of extraSheets ?? []) {
    appendAoaSheet(XLSX, workbook, extra.name, extra.headers, extra.rows);
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["Report", title], ["Scope", scope], ["Rows", rows.length],
    ["TID rows", String((extraSheets ?? []).reduce((sum, sheet) => sum + sheet.rows.length, 0) || "")],
    ["Exported at (IST)", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })],
  ]), "Export details");
  XLSX.writeFile(workbook, `${title.replace(/[^a-z0-9 -]/gi, "").trim().replace(/\s+/g, "-").slice(0, 90) || "OpsPulse-report"}.xlsx`, { compression: true });
}
