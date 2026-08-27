import * as XLSX from "xlsx";

/**
 * Builds a multi-sheet .xlsx download response — same approach already used
 * by src/app/api/ops-pulse/reports/download/route.ts (XLSX.utils.json_to_sheet
 * per sheet, written as a buffer), pulled out here so every "Download report"
 * button across Ops Pulse (Ageing, Performance, CIA) shares one implementation
 * instead of re-deriving it per route.
 *
 * Each row must be a flat object — its keys become that sheet's header row,
 * in insertion order. Sheet names are truncated to Excel's 31-character cap.
 * A sheet with zero rows still gets a one-column "No data" placeholder so a
 * blank tab in the workbook never reads as a rendering bug.
 */
export function workbookResponse(sheets: Array<{ name: string; rows: Record<string, unknown>[] }>, filename: string): Response {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const rows = sheet.rows.length ? sheet.rows : [{ "No data": "Nothing to report for this selection." }];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), sheet.name.slice(0, 31));
  }
  const body = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
  return new Response(body, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}
