export type FleetReportTable = {
  title: string;
  subtitle?: string;
  fileName: string;
  headers: string[];
  rows: Array<Array<string | number | boolean | null | undefined>>;
};

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadFleetExcel(report: FleetReportTable) {
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet([
    [report.title],
    [report.subtitle ?? ""],
    [],
    report.headers,
    ...report.rows
  ]);
  sheet["!cols"] = report.headers.map((header, index) => ({
    wch: Math.min(42, Math.max(header.length + 3, ...report.rows.slice(0, 250).map((row) => String(row[index] ?? "").length + 2)))
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Fleet report");
  XLSX.writeFile(workbook, `${report.fileName}.xlsx`, { compression: true });
}

const pdfText = (value: unknown) => String(value ?? "").replaceAll("₹", "INR ").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();

export async function downloadFleetPdf(report: FleetReportTable) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [842, 595];
  const margin = 28;
  const usable = pageSize[0] - margin * 2;
  const widths = report.headers.map((_, index) => {
    const sample = [report.headers[index], ...report.rows.slice(0, 60).map((row) => pdfText(row[index]))];
    return Math.min(190, Math.max(66, Math.max(...sample.map((value) => value.length)) * 4.8));
  });
  const scale = usable / widths.reduce((sum, width) => sum + width, 0);
  const columns = widths.map((width) => width * Math.min(1, scale));
  let page = document.addPage(pageSize);
  let y = pageSize[1] - margin;

  const drawHeader = () => {
    page.drawText(pdfText(report.title), { x: margin, y, size: 17, font: bold, color: rgb(0.08, 0.13, 0.21) });
    y -= 17;
    page.drawText(pdfText(report.subtitle ?? `Generated ${new Date().toLocaleString("en-IN")}`), { x: margin, y, size: 8, font: regular, color: rgb(0.38, 0.45, 0.5) });
    y -= 20;
    page.drawRectangle({ x: margin, y: y - 4, width: usable, height: 18, color: rgb(0.09, 0.14, 0.22) });
    let x = margin + 4;
    report.headers.forEach((header, index) => {
      const max = Math.max(4, Math.floor(columns[index] / 5));
      page.drawText(pdfText(header).slice(0, max), { x, y, size: 7, font: bold, color: rgb(1, 1, 1) });
      x += columns[index];
    });
    y -= 16;
  };
  drawHeader();
  report.rows.forEach((row, rowIndex) => {
    if (y < margin + 16) {
      page = document.addPage(pageSize);
      y = pageSize[1] - margin;
      drawHeader();
    }
    if (rowIndex % 2) page.drawRectangle({ x: margin, y: y - 4, width: usable, height: 15, color: rgb(0.965, 0.975, 0.975) });
    let x = margin + 4;
    row.forEach((value, index) => {
      if (index >= columns.length) return;
      const max = Math.max(4, Math.floor(columns[index] / 4.5));
      page.drawText(pdfText(value).slice(0, max), { x, y, size: 6.8, font: regular, color: rgb(0.15, 0.2, 0.24) });
      x += columns[index];
    });
    y -= 15;
  });
  const pages = document.getPages();
  pages.forEach((item, index) => item.drawText(`DropX Fleet  |  Page ${index + 1} of ${pages.length}`, { x: margin, y: 12, size: 6.5, font: regular, color: rgb(0.5, 0.55, 0.58) }));
  const bytes = Uint8Array.from(await document.save());
  save(new Blob([bytes.buffer], { type: "application/pdf" }), `${report.fileName}.pdf`);
}
