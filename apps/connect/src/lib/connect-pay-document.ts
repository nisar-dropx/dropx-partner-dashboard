import { PDFDocument, type PDFFont, StandardFonts, rgb } from "pdf-lib";

type PayLine = { name: string; amount: number };
export type ConnectPayDocumentInput = {
  companyName: string;
  title: string;
  address?: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  documentNumber: string;
  workerCode: string | null;
  workerName: string;
  designationName: string | null;
  departmentName: string | null;
  locationName: string | null;
  expectedDays: number;
  presentDays: number;
  paidLeaveDays: number;
  absenceDays: number;
  grossPay: number;
  netPay: number;
  earnings: PayLine[];
  deductions: PayLine[];
  footer: string;
  publishedAt: string;
};

function money(value: number) { return `INR ${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function ascii(value: unknown) { return String(value ?? "-").replace(/[^\x20-\x7E]/g, ""); }
function fit(value: unknown, font: PDFFont, size: number, width: number) {
  const text = ascii(value);
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let clipped = text;
  while (clipped.length > 3 && font.widthOfTextAtSize(`${clipped}...`, size) > width) clipped = clipped.slice(0, -1);
  return `${clipped}...`;
}

export async function createConnectPayDocument(input: ConnectPayDocumentInput) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  const margin = 42;
  const right = width - margin;
  const orange = rgb(.93, .29, .10);
  const navy = rgb(.08, .12, .22);
  const muted = rgb(.42, .46, .53);
  const line = rgb(.88, .89, .92);
  let y = height - 46;
  page.drawRectangle({ x: 0, y: height - 12, width, height: 12, color: orange });
  page.drawText(fit(input.companyName, bold, 18, 315), { x: margin, y, size: 18, font: bold, color: navy });
  page.drawText(fit(input.title.toUpperCase(), bold, 11, 205), { x: right - 205, y: y + 2, size: 11, font: bold, color: orange });
  y -= 25;
  page.drawText(fit(`${input.periodLabel} | ${input.periodStart} to ${input.periodEnd}${input.address ? ` | ${input.address}` : ""}`, regular, 9, 345), { x: margin, y, size: 9, font: regular, color: muted });
  page.drawText(fit(`Document: ${input.documentNumber}`, regular, 8.5, 200), { x: right - 200, y, size: 8.5, font: regular, color: muted });
  y -= 22;
  page.drawLine({ start: { x: margin, y }, end: { x: right, y }, thickness: 1, color: line });
  y -= 28;
  const detail = (label: string, value: unknown, x: number, rowY: number) => {
    page.drawText(label.toUpperCase(), { x, y: rowY, size: 7, font: bold, color: muted });
    page.drawText(fit(value, regular, 10, 220), { x, y: rowY - 14, size: 10, font: regular, color: navy });
  };
  detail("Name", input.workerName, margin, y); detail("Employee / contractor ID", input.workerCode, 315, y); y -= 47;
  detail("Designation", input.designationName, margin, y); detail("Department / location", `${ascii(input.departmentName)} / ${ascii(input.locationName)}`, 315, y); y -= 53;
  const gap = 18;
  const columnWidth = (right - margin - gap) / 2;
  const table = (title: string, rows: PayLine[], x: number) => {
    page.drawRectangle({ x, y: y - 2, width: columnWidth, height: 25, color: rgb(.98, .95, .92) });
    page.drawText(title, { x: x + 9, y: y + 7, size: 9, font: bold, color: navy });
    let rowY = y - 22;
    for (const row of (rows.length ? rows : [{ name: "None", amount: 0 }]).slice(0, 11)) {
      page.drawText(fit(row.name, regular, 8.5, columnWidth - 100), { x: x + 8, y: rowY, size: 8.5, font: regular, color: navy });
      const amount = money(row.amount);
      page.drawText(amount, { x: x + columnWidth - 8 - regular.widthOfTextAtSize(amount, 8.5), y: rowY, size: 8.5, font: regular, color: navy });
      rowY -= 19;
      page.drawLine({ start: { x: x + 8, y: rowY + 7 }, end: { x: x + columnWidth - 8, y: rowY + 7 }, thickness: .5, color: line });
    }
    return rowY;
  };
  y = Math.min(table("EARNINGS", input.earnings, margin), table("DEDUCTIONS", input.deductions, margin + columnWidth + gap)) - 2;
  page.drawRectangle({ x: margin, y: y - 43, width: right - margin, height: 45, color: navy });
  page.drawText("NET PAY", { x: margin + 13, y: y - 25, size: 10, font: bold, color: rgb(1, 1, 1) });
  const net = money(input.netPay);
  page.drawText(net, { x: right - 13 - bold.widthOfTextAtSize(net, 15), y: y - 28, size: 15, font: bold, color: rgb(1, 1, 1) });
  y -= 75;
  page.drawText(`Attendance: ${input.presentDays} present | ${input.paidLeaveDays} paid leave | ${input.absenceDays} absent | ${input.expectedDays} expected`, { x: margin, y, size: 8, font: regular, color: muted });
  y -= 28;
  page.drawText(fit(input.footer, regular, 8, right - margin), { x: margin, y, size: 8, font: regular, color: muted });
  page.drawLine({ start: { x: margin, y: 55 }, end: { x: right, y: 55 }, thickness: .6, color: line });
  page.drawText(`Published ${new Date(input.publishedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`, { x: margin, y: 39, size: 7, font: regular, color: muted });
  return pdf.save();
}
