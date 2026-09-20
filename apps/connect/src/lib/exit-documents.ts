// Hand-duplicated from dropx-hrms/src/lib/exit-documents.ts, matching the existing
// pattern used for approval-workflow-routing.ts and approval-designation-labels.ts —
// Connect and HRMS are separately deployed apps that only share the database, never
// each other's code or an internal API, so an exit document downloaded from Connect
// (regenerated on demand, never stored) must render byte-identically to one
// downloaded from HRMS using the exact same layout logic. Any change to letter/
// certificate layout in the HRMS original must be mirrored here by hand.
import { PDFDocument, PDFFont, StandardFonts, rgb } from "pdf-lib";

export type ExitDocumentValues = Record<string, string>;

export function fillExitTemplate(template: string, values: ExitDocumentValues) {
  return template.replace(/{{\s*([a-z0-9_]+)\s*}}/gi, (_, key: string) => values[key] ?? "");
}

function wrapLine(text: string, font: PDFFont, size: number, maxWidth: number) {
  if (!text) return [""];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

export async function createExitPdf(input: {
  title: string;
  body: string;
  companyName: string;
  registeredAddress?: string | null;
  footerText?: string | null;
  signatoryName?: string | null;
  signatoryTitle?: string | null;
}) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = 595.28;
  const height = 841.89;
  const margin = 58;
  let page = pdf.addPage([width, height]);
  let y = height - 62;

  const header = () => {
    page.drawRectangle({ x: 0, y: height - 12, width, height: 12, color: rgb(0.82, 0.12, 0.21) });
    page.drawText(input.companyName, { x: margin, y, size: 18, font: bold, color: rgb(0.13, 0.13, 0.13) });
    y -= 18;
    if (input.registeredAddress) {
      for (const line of wrapLine(input.registeredAddress, regular, 8.5, width - margin * 2)) {
        page.drawText(line, { x: margin, y, size: 8.5, font: regular, color: rgb(0.42, 0.42, 0.42) });
        y -= 11;
      }
    }
    y -= 9;
    page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: rgb(0.9, 0.9, 0.9) });
    y -= 34;
  };
  const newPage = () => { page = pdf.addPage([width, height]); y = height - 62; header(); };
  header();
  const titleWidth = bold.widthOfTextAtSize(input.title, 16);
  page.drawText(input.title, { x: Math.max(margin, (width - titleWidth) / 2), y, size: 16, font: bold, color: rgb(0.82, 0.12, 0.21) });
  y -= 38;

  for (const paragraph of input.body.replace(/\r/g, "").split("\n")) {
    const lines = wrapLine(paragraph, regular, 10.5, width - margin * 2);
    for (const line of lines) {
      if (y < 118) newPage();
      page.drawText(line, { x: margin, y, size: 10.5, font: regular, color: rgb(0.15, 0.15, 0.15) });
      y -= 16;
    }
    y -= 6;
  }
  if (input.signatoryName || input.signatoryTitle) {
    if (y < 145) newPage();
    y -= 26;
    page.drawText(input.signatoryName || "Authorised signatory", { x: margin, y, size: 10.5, font: bold });
    y -= 15;
    if (input.signatoryTitle) page.drawText(input.signatoryTitle, { x: margin, y, size: 9.5, font: regular, color: rgb(0.35, 0.35, 0.35) });
  }
  const pages = pdf.getPages();
  pages.forEach((item, index) => {
    item.drawLine({ start: { x: margin, y: 52 }, end: { x: width - margin, y: 52 }, thickness: .6, color: rgb(0.88, 0.88, 0.88) });
    const footer = input.footerText || "System-generated document from DropX People & Culture";
    item.drawText(footer, { x: margin, y: 36, size: 7.5, font: regular, color: rgb(0.48, 0.48, 0.48), maxWidth: width - margin * 2 - 42 });
    item.drawText(`${index + 1}/${pages.length}`, { x: width - margin - 25, y: 36, size: 7.5, font: regular, color: rgb(0.48, 0.48, 0.48) });
  });
  return pdf.save();
}

export type ExperienceCertificateVariant = "standard" | "manager" | "custom";

export async function createExperienceCertificatePdf(input: {
  companyName: string;
  registeredAddress?: string | null;
  footerText?: string | null;
  signatoryName?: string | null;
  signatoryTitle?: string | null;
  referenceNumber: string;
  issueDate: string;
  employeeName: string;
  employeeCode: string;
  designation: string;
  dateOfJoining: string;
  lastWorkingDate: string;
  variant: ExperienceCertificateVariant;
  roleDuties?: string | null;
  bodyOverride?: string | null;
}) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = 595.28;
  const height = 841.89;
  const margin = 54;
  const page = pdf.addPage([width, height]);
  let y = height - 48;

  page.drawRectangle({ x: 0, y: height - 10, width, height: 10, color: rgb(0.82, 0.12, 0.21) });
  page.drawText("DropX", { x: margin, y, size: 22, font: bold, color: rgb(0.82, 0.12, 0.21) });
  const logisticsWidth = bold.widthOfTextAtSize("Logistics", 11);
  page.drawText("Logistics", { x: width - margin - logisticsWidth, y: y + 4, size: 11, font: bold, color: rgb(0.2, 0.2, 0.2) });
  y -= 18;
  if (input.registeredAddress) {
    for (const line of wrapLine(input.registeredAddress, regular, 8, width - margin * 2)) {
      page.drawText(line, { x: margin, y, size: 8, font: regular, color: rgb(0.4, 0.4, 0.4) });
      y -= 10;
    }
  }
  y -= 8;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.8, color: rgb(0.85, 0.85, 0.85) });
  y -= 28;

  page.drawText(`Ref: ${input.referenceNumber}`, { x: margin, y, size: 10, font: regular });
  const dateLabel = `Date: ${input.issueDate}`;
  page.drawText(dateLabel, { x: width - margin - regular.widthOfTextAtSize(dateLabel, 10), y, size: 10, font: regular });
  y -= 36;

  const title = "TO WHOMSOEVER IT MAY CONCERN";
  page.drawText(title, { x: Math.max(margin, (width - bold.widthOfTextAtSize(title, 13)) / 2), y, size: 13, font: bold });
  y -= 28;

  const paragraphs: string[] = [];
  if (input.bodyOverride?.trim()) {
    paragraphs.push(...input.bodyOverride.replace(/\r/g, "").split("\n"));
  } else {
    paragraphs.push(
      `This is to certify that ${input.employeeName} (Employee ID: ${input.employeeCode}) was employed with ${input.companyName} as ${input.designation} from ${input.dateOfJoining} to ${input.lastWorkingDate}.`
    );
    paragraphs.push(
      `${input.companyName} is engaged in last-mile logistics and related operations across its network.`
    );
    if (input.variant === "manager") {
      paragraphs.push(
        input.roleDuties?.trim()
          || `During the tenure, ${input.employeeName} carried out managerial responsibilities including team coordination, operational delivery, and adherence to company processes.`
      );
      paragraphs.push(
        `We found ${input.employeeName} to be diligent, professional, and committed. We wish continued success in future endeavours.`
      );
    } else {
      paragraphs.push(
        `We found ${input.employeeName} to be sincere and diligent in the assigned duties. We wish success in future endeavours.`
      );
    }
  }

  for (const paragraph of paragraphs) {
    for (const line of wrapLine(paragraph, regular, 10.5, width - margin * 2)) {
      page.drawText(line, { x: margin, y, size: 10.5, font: regular, color: rgb(0.15, 0.15, 0.15) });
      y -= 15;
    }
    y -= 8;
  }

  y -= 28;
  page.drawText("For DropX Logistics,", { x: margin, y, size: 10.5, font: regular });
  y -= 48;
  page.drawText(input.signatoryName || "Head Human Resources", { x: margin, y, size: 10.5, font: bold });
  y -= 14;
  page.drawText(input.signatoryTitle || "Human Resources", { x: margin, y, size: 9.5, font: regular, color: rgb(0.35, 0.35, 0.35) });

  page.drawLine({ start: { x: margin, y: 52 }, end: { x: width - margin, y: 52 }, thickness: 0.6, color: rgb(0.88, 0.88, 0.88) });
  page.drawText(input.footerText || "System-generated Experience Certificate · DropX People & Culture", {
    x: margin,
    y: 36,
    size: 7.5,
    font: regular,
    color: rgb(0.48, 0.48, 0.48),
    maxWidth: width - margin * 2
  });

  return pdf.save();
}

export function buildExperienceCertificateReference(issueDateIso: string, sequence: number) {
  const [year, month] = issueDateIso.split("-");
  const seq = String(Math.max(1, sequence)).padStart(3, "0");
  return `DROPX/HRD/EC/${month}/${year}/${seq}`;
}
