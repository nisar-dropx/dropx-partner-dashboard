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

const imageText = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim() || "—";

function fitImageText(context: CanvasRenderingContext2D, value: unknown, width: number) {
  const source = imageText(value);
  if (context.measureText(source).width <= width) return source;
  let text = source;
  while (text.length > 1 && context.measureText(`${text}…`).width > width) text = text.slice(0, -1);
  return `${text.trimEnd()}…`;
}

export async function downloadFleetImage(report: FleetReportTable) {
  const width = 1800;
  const edge = 48;
  const brandHeight = 126;
  const headerHeight = 58;
  const rowHeight = 52;
  const footerHeight = 48;
  const maximumHeight = 15_500;
  const maximumRows = Math.max(1, Math.floor((maximumHeight - brandHeight - headerHeight - footerHeight - edge * 2) / rowHeight));
  const rows = report.rows.slice(0, maximumRows);
  const height = edge * 2 + brandHeight + headerHeight + rows.length * rowHeight + footerHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image export is not supported by this browser.");

  const usableWidth = width - edge * 2;
  const rawWidths = report.headers.map((header, index) => {
    const longest = Math.max(header.length, ...rows.slice(0, 120).map((row) => imageText(row[index]).length));
    return Math.max(105, Math.min(265, longest * 10 + 34));
  });
  const rawTotal = rawWidths.reduce((sum, value) => sum + value, 0);
  const columns = rawWidths.map((value) => value / rawTotal * usableWidth);
  const generated = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date());

  context.fillStyle = "#f4f6f8";
  context.fillRect(0, 0, width, height);
  const gradient = context.createLinearGradient(edge, edge, width - edge, edge + brandHeight);
  gradient.addColorStop(0, "#111a2e");
  gradient.addColorStop(1, "#283650");
  context.fillStyle = gradient;
  context.fillRect(edge, edge, usableWidth, brandHeight);
  context.fillStyle = "#db2d67";
  context.fillRect(edge, edge, 10, brandHeight);
  context.fillStyle = "#ffffff";
  context.font = "700 27px Arial, sans-serif";
  context.fillText("DropX Fleet", edge + 34, edge + 42);
  context.fillStyle = "#c7d0dc";
  context.font = "700 12px Arial, sans-serif";
  context.fillText("VEHICLE OPERATIONS", edge + 35, edge + 65);
  context.fillStyle = "#ffffff";
  context.font = "700 30px Arial, sans-serif";
  context.fillText(fitImageText(context, report.title, 820), edge + 330, edge + 47);
  context.fillStyle = "#c7d0dc";
  context.font = "400 16px Arial, sans-serif";
  context.fillText(fitImageText(context, report.subtitle || "Fleet operations report", 900), edge + 330, edge + 76);
  context.fillStyle = "#ffcd4c";
  context.font = "700 16px Arial, sans-serif";
  context.textAlign = "right";
  context.fillText(`${report.rows.length} records`, width - edge - 28, edge + 43);
  context.fillStyle = "#c7d0dc";
  context.font = "400 13px Arial, sans-serif";
  context.fillText(`Generated ${generated}`, width - edge - 28, edge + 70);
  context.textAlign = "left";

  let y = edge + brandHeight;
  context.fillStyle = "#202b40";
  context.fillRect(edge, y, usableWidth, headerHeight);
  context.fillStyle = "#ef5931";
  context.fillRect(edge, y, usableWidth, 5);
  let x = edge;
  context.font = "700 13px Arial, sans-serif";
  report.headers.forEach((header, index) => {
    context.fillStyle = "#ffffff";
    context.fillText(fitImageText(context, header.toUpperCase(), columns[index] - 20), x + 10, y + 36);
    x += columns[index];
    if (index < columns.length - 1) { context.strokeStyle = "#435066"; context.beginPath(); context.moveTo(x, y + 5); context.lineTo(x, y + headerHeight); context.stroke(); }
  });
  y += headerHeight;

  rows.forEach((row, rowIndex) => {
    context.fillStyle = rowIndex % 2 ? "#f8fafb" : "#ffffff";
    context.fillRect(edge, y, usableWidth, rowHeight);
    x = edge;
    row.forEach((value, index) => {
      if (index >= columns.length) return;
      const tone = statusTone(value);
      if (tone && imageText(value).length <= 24) {
        context.fillStyle = tone === "green" ? "#e8f7f1" : tone === "red" ? "#ffeaee" : tone === "amber" ? "#fff4d6" : "#eaf5fb";
        context.fillRect(x + 6, y + 9, Math.max(8, columns[index] - 12), rowHeight - 18);
      }
      context.fillStyle = index === 0 ? "#172136" : "#475466";
      context.font = `${index === 0 ? "700" : "400"} 14px Arial, sans-serif`;
      context.fillText(fitImageText(context, value, columns[index] - 20), x + 10, y + 32);
      x += columns[index];
      if (index < columns.length - 1) { context.strokeStyle = "#e0e5e8"; context.beginPath(); context.moveTo(x, y); context.lineTo(x, y + rowHeight); context.stroke(); }
    });
    context.strokeStyle = "#e0e5e8";
    context.beginPath(); context.moveTo(edge, y + rowHeight); context.lineTo(width - edge, y + rowHeight); context.stroke();
    y += rowHeight;
  });

  context.fillStyle = "#ffffff";
  context.fillRect(edge, y, usableWidth, footerHeight);
  context.fillStyle = "#778392";
  context.font = "400 12px Arial, sans-serif";
  context.fillText("DropX Fleet  |  Controlled vehicle operations report", edge + 10, y + 30);
  context.textAlign = "right";
  context.fillStyle = "#b52b59";
  context.font = "700 12px Arial, sans-serif";
  context.fillText(rows.length < report.rows.length ? `Showing ${rows.length} of ${report.rows.length} records` : `${rows.length} records`, width - edge - 10, y + 30);
  context.textAlign = "left";

  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Image export could not be created.")), "image/png"));
  save(blob, `${report.fileName}.png`);
}

const pdfText = (value: unknown) => String(value ?? "").replaceAll("₹", "INR ").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();

const palette = {
  ink: [0.067, 0.102, 0.184] as const,
  slate: [0.28, 0.34, 0.42] as const,
  muted: [0.48, 0.53, 0.59] as const,
  line: [0.87, 0.9, 0.92] as const,
  surface: [0.967, 0.975, 0.976] as const,
  coral: [0.946, 0.353, 0.141] as const,
  pink: [0.851, 0.176, 0.404] as const,
  amber: [0.961, 0.659, 0] as const,
  green: [0.086, 0.545, 0.373] as const,
  red: [0.835, 0.173, 0.231] as const,
  blue: [0.153, 0.42, 0.8] as const
};

function statusTone(value: unknown) {
  const text = pdfText(value).toLowerCase();
  if (/approved|active|operational|completed|passed|paid|connected|compliant/.test(text) && !/non[- ]?operational/.test(text)) return "green";
  if (/rejected|expired|breakdown|failed|overdue|non[- ]?operational|inactive/.test(text)) return "red";
  if (/pending|processing|service|maintenance|due|expiring|scheduled/.test(text)) return "amber";
  if (/driver|video|gps|live/.test(text)) return "blue";
  return null;
}

function wrapText(value: unknown, maxCharacters: number, maxLines = 2) {
  const words = pdfText(value).split(" ").filter(Boolean);
  if (!words.length) return ["-"];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxCharacters) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word.length > maxCharacters ? word.slice(0, Math.max(1, maxCharacters - 1)) : word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  const source = pdfText(value);
  const joined = lines.join(" ");
  if (source.length > joined.length && lines.length) {
    const last = lines.length - 1;
    lines[last] = `${lines[last].slice(0, Math.max(1, maxCharacters - 3)).trimEnd()}...`;
  }
  return lines.slice(0, maxLines);
}

export async function createFleetPdfBytes(report: FleetReportTable) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const document = await PDFDocument.create();
  document.setTitle(pdfText(report.title));
  document.setAuthor("DropX Fleet");
  document.setSubject(pdfText(report.subtitle || "Fleet operations report"));
  document.setCreator("DropX Fleet reporting");
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [842, 595];
  const margin = 28;
  const usable = pageSize[0] - margin * 2;
  const rawWidths = report.headers.map((header, index) => {
    const values = [header, ...report.rows.slice(0, 80).map((row) => pdfText(row[index]))];
    const longest = Math.max(...values.map((value) => Math.min(value.length, 28)));
    return Math.max(60, Math.min(150, longest * 4.4 + 18));
  });
  const totalRaw = rawWidths.reduce((sum, width) => sum + width, 0);
  const columns = rawWidths.map((width) => (width / totalRaw) * usable);
  const generated = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date());
  let page = document.addPage(pageSize);
  let y = pageSize[1] - margin;

  const drawBrandHeader = () => {
    page.drawRectangle({ x: margin, y: y - 55, width: usable, height: 55, color: rgb(...palette.ink) });
    page.drawRectangle({ x: margin, y: y - 55, width: 7, height: 55, color: rgb(...palette.pink) });
    page.drawCircle({ x: margin + 29, y: y - 27, size: 14, color: rgb(0.12, 0.18, 0.29) });
    page.drawLine({ start: { x: margin + 21, y: y - 34 }, end: { x: margin + 28, y: y - 19 }, thickness: 3.2, color: rgb(...palette.amber) });
    page.drawLine({ start: { x: margin + 28, y: y - 19 }, end: { x: margin + 37, y: y - 31 }, thickness: 3.2, color: rgb(...palette.coral) });
    page.drawCircle({ x: margin + 21, y: y - 34, size: 2.2, color: rgb(1, 1, 1) });
    page.drawCircle({ x: margin + 28, y: y - 19, size: 2.2, color: rgb(1, 1, 1) });
    page.drawText("DropX Fleet", { x: margin + 51, y: y - 24, size: 14, font: bold, color: rgb(1, 1, 1) });
    page.drawText("VEHICLE OPERATIONS", { x: margin + 51, y: y - 38, size: 6.5, font: bold, color: rgb(0.77, 0.81, 0.87) });
    page.drawText(pdfText(report.title).slice(0, 64), { x: margin + 190, y: y - 25, size: 15.5, font: bold, color: rgb(1, 1, 1) });
    page.drawText(pdfText(report.subtitle || "Fleet operations report").slice(0, 92), { x: margin + 190, y: y - 39, size: 7, font: regular, color: rgb(0.77, 0.81, 0.87) });
    page.drawText(`${report.rows.length} records`, { x: pageSize[0] - margin - 112, y: y - 21, size: 7.2, font: bold, color: rgb(1, 0.78, 0.2) });
    page.drawText(`Generated ${generated}`, { x: pageSize[0] - margin - 150, y: y - 36, size: 6.6, font: regular, color: rgb(0.77, 0.81, 0.87) });
    y -= 69;
  };

  const drawTableHeader = () => {
    page.drawRectangle({ x: margin, y: y - 21, width: usable, height: 24, color: rgb(...palette.ink) });
    page.drawRectangle({ x: margin, y: y + 3, width: usable, height: 3, color: rgb(...palette.coral) });
    let x = margin;
    report.headers.forEach((header, index) => {
      const lines = wrapText(header.toUpperCase(), Math.max(5, Math.floor((columns[index] - 8) / 4.3)), 2);
      lines.forEach((line, lineIndex) => page.drawText(line, { x: x + 4, y: y - 7 - lineIndex * 7, size: 6.2, font: bold, color: rgb(1, 1, 1) }));
      if (index > 0) page.drawLine({ start: { x, y: y + 3 }, end: { x, y: y - 21 }, thickness: 0.45, color: rgb(0.3, 0.36, 0.45) });
      x += columns[index];
    });
    y -= 24;
  };

  const beginPage = () => {
    drawBrandHeader();
    drawTableHeader();
  };

  beginPage();
  report.rows.forEach((row, rowIndex) => {
    const cellLines = report.headers.map((_, index) => wrapText(row[index], Math.max(6, Math.floor((columns[index] - 8) / 3.65)), 2));
    const rowHeight = Math.max(20, Math.min(31, 9 + Math.max(...cellLines.map((lines) => lines.length)) * 8));
    if (y - rowHeight < margin + 16) {
      page = document.addPage(pageSize);
      y = pageSize[1] - margin;
      beginPage();
    }
    const rowColor: readonly [number, number, number] = rowIndex % 2 ? palette.surface : [1, 1, 1];
    page.drawRectangle({ x: margin, y: y - rowHeight, width: usable, height: rowHeight, color: rgb(rowColor[0], rowColor[1], rowColor[2]) });
    let x = margin;
    cellLines.forEach((lines, index) => {
      const tone = statusTone(row[index]);
      if (tone && pdfText(row[index]).length <= 24) {
        const color = tone === "green" ? palette.green : tone === "red" ? palette.red : tone === "amber" ? palette.amber : palette.blue;
        page.drawRectangle({ x: x + 3, y: y - rowHeight + 5, width: Math.max(12, columns[index] - 6), height: rowHeight - 10, color: rgb(color[0], color[1], color[2]), opacity: 0.1 });
      }
      lines.forEach((line, lineIndex) => page.drawText(line, { x: x + 4, y: y - 12 - lineIndex * 8, size: 6.65, font: index === 0 ? bold : regular, color: rgb(...palette.slate) }));
      x += columns[index];
      if (index < columns.length - 1) page.drawLine({ start: { x, y }, end: { x, y: y - rowHeight }, thickness: 0.35, color: rgb(...palette.line) });
    });
    page.drawLine({ start: { x: margin, y: y - rowHeight }, end: { x: margin + usable, y: y - rowHeight }, thickness: 0.5, color: rgb(...palette.line) });
    y -= rowHeight;
  });

  const pages = document.getPages();
  pages.forEach((item, index) => {
    item.drawLine({ start: { x: margin, y: 22 }, end: { x: pageSize[0] - margin, y: 22 }, thickness: 0.6, color: rgb(...palette.line) });
    item.drawText("DropX Fleet  |  Controlled vehicle operations report", { x: margin, y: 10, size: 6.2, font: regular, color: rgb(...palette.muted) });
    item.drawText(`Page ${index + 1} of ${pages.length}`, { x: pageSize[0] - margin - 47, y: 10, size: 6.2, font: bold, color: rgb(...palette.pink) });
  });
  return Uint8Array.from(await document.save());
}

export async function downloadFleetPdf(report: FleetReportTable) {
  const bytes = await createFleetPdfBytes(report);
  save(new Blob([bytes.buffer], { type: "application/pdf" }), `${report.fileName}.pdf`);
}
