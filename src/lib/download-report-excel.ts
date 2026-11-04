import { styleReportWorkbook, type ReportCellStyle, type ReportColourRule } from "./styled-report-workbook";
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
  cellStyles?: ReportCellStyle[][];
  colourRules?: ReportColourRule[];
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
  rows.forEach((row,r)=>row.forEach((value,c)=>{
    if(typeof value === 'string' && /^-?[\d,.]+%$/.test(value.trim())) {
      const cell=sheet[XLSX.utils.encode_cell({r:r+1,c})];
      if(cell){cell.v=Number(value.replace(/[,%]/g,''))/100;cell.t='n';cell.z='0.00%';}
    }
  }));
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

export async function downloadReportExcel({ title, headers, rows, scope, extraSheets, cellStyles, colourRules }: ExcelReport) {
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
  const bytes=await styleReportWorkbook(XLSX.write(workbook,{type:"array",compression:true}),cellStyles,colourRules,rows.length);
  const url=URL.createObjectURL(new Blob([bytes as BlobPart],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
  const link=document.createElement("a");link.href=url;link.download= `${title.replace(/[^a-z0-9 -]/gi, "").trim().replace(/\s+/g, "-").slice(0, 90) || "OpsPulse-report"}.xlsx`;
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
