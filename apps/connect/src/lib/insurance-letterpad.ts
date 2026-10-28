import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type InsuranceLetterpadMember = {
  fullName: string;
  relationshipType: string;
  policyType?: string | null;
  membershipNo?: string | null;
  validTo?: string | null;
};

let cachedHeader: Uint8Array | null | undefined;

/** Header logo from dropx-letterpad.docx (word/media/image1.png). */
async function loadLetterpadHeaderPng() {
  if (cachedHeader !== undefined) return cachedHeader;
  const candidates = [
    path.join(process.cwd(), "public", "dropx-letterpad-header.png"),
    path.join(process.cwd(), "apps", "connect", "public", "dropx-letterpad-header.png")
  ];
  for (const file of candidates) {
    try {
      cachedHeader = new Uint8Array(await readFile(file));
      return cachedHeader;
    } catch {
      /* try next */
    }
  }
  cachedHeader = null;
  return cachedHeader;
}

function wrapLine(text: string, font: { widthOfTextAtSize: (t: string, s: number) => number }, size: number, maxWidth: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) current = next;
    else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

/** Official DropX letterpad cover confirmation (matches dropx-letterpad.docx header). */
export async function createInsuranceCoverLetterpadPdf(input: {
  primaryName: string;
  pan: string;
  workerCode?: string | null;
  policyNumber?: string | null;
  insurerName?: string | null;
  validTo?: string | null;
  members: InsuranceLetterpadMember[];
  issueDate?: string;
}) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const width = 595.28;
  const height = 841.89;
  const margin = 54;
  const page = pdf.addPage([width, height]);
  const maroon = rgb(0.72, 0.45, 0.48);
  let y = height - 36;

  page.drawText("DROPX LOGISTICS", { x: margin, y: y - 10, size: 18, font: bold, color: maroon });
  const headerPng = await loadLetterpadHeaderPng();
  if (headerPng?.length) {
    try {
      const logo = await pdf.embedPng(headerPng);
      const logoHeight = 44;
      const logoWidth = (logo.width / logo.height) * logoHeight;
      page.drawImage(logo, {
        x: width - margin - logoWidth,
        y: y - logoHeight + 14,
        width: logoWidth,
        height: logoHeight
      });
    } catch {
      /* wordmark already drawn */
    }
  }
  y -= 54;
  // Soft separator like the letterpad wavy rule.
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1.1, color: rgb(0.82, 0.82, 0.84) });
  y -= 8;
  page.drawLine({ start: { x: margin + 12, y }, end: { x: width - margin - 12, y }, thickness: 0.5, color: rgb(0.9, 0.9, 0.91) });
  y -= 28;

  const issueDate =
    input.issueDate ||
    new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date());
  page.drawText(`Date: ${issueDate}`, {
    x: width - margin - regular.widthOfTextAtSize(`Date: ${issueDate}`, 10),
    y,
    size: 10,
    font: regular
  });
  y -= 28;

  const title = "GROUP INSURANCE COVER CONFIRMATION";
  page.drawText(title, {
    x: Math.max(margin, (width - bold.widthOfTextAtSize(title, 12)) / 2),
    y,
    size: 12,
    font: bold
  });
  y -= 26;

  const intro =
    "This letter confirms that the following person(s) are covered under the DropX Logistics group insurance programme administered through Marsh / Qover.";
  for (const line of wrapLine(intro, regular, 10.5, width - margin * 2)) {
    page.drawText(line, { x: margin, y, size: 10.5, font: regular, color: rgb(0.15, 0.15, 0.15) });
    y -= 15;
  }
  y -= 10;

  const detailLines = [
    `Primary member: ${input.primaryName}`,
    input.workerCode ? `DropX ID: ${input.workerCode}` : null,
    `PAN: ${input.pan || "—"}`,
    input.policyNumber ? `Policy: ${input.policyNumber}` : null,
    `Insurer: ${input.insurerName || "Marsh / Qover"}`,
    input.validTo ? `Valid to: ${input.validTo}` : null
  ].filter(Boolean) as string[];
  for (const line of detailLines) {
    page.drawText(line, { x: margin, y, size: 10.5, font: regular });
    y -= 15;
  }
  y -= 12;

  page.drawText("Covered members", { x: margin, y, size: 11, font: bold, color: maroon });
  y -= 18;

  const members = input.members.length
    ? input.members
    : [{ fullName: input.primaryName, relationshipType: "Self" }];
  for (const [index, member] of members.entries()) {
    const row = `${index + 1}. ${member.fullName} · ${member.relationshipType}${
      member.policyType ? ` · ${String(member.policyType).toUpperCase()}` : ""
    }${member.membershipNo ? ` · Membership ${member.membershipNo}` : ""}${
      member.validTo ? ` · Valid to ${member.validTo}` : ""
    }`;
    for (const line of wrapLine(row, regular, 10.5, width - margin * 2)) {
      if (y < 90) break;
      page.drawText(line, { x: margin, y, size: 10.5, font: regular });
      y -= 14;
    }
    y -= 4;
  }

  y -= 16;
  const closing =
    "This letter is issued on company letterpad for HR and employee records. Ecards for Group Medical and Group Personal Accident are available separately in DropX One Documents.";
  for (const line of wrapLine(closing, regular, 10.5, width - margin * 2)) {
    page.drawText(line, { x: margin, y, size: 10.5, font: regular, color: rgb(0.15, 0.15, 0.15) });
    y -= 15;
  }

  y -= 28;
  page.drawText("For DropX Logistics,", { x: margin, y, size: 10.5, font: regular });
  y -= 40;
  page.drawText("People & Culture", { x: margin, y, size: 10.5, font: bold });

  page.drawLine({
    start: { x: margin, y: 52 },
    end: { x: width - margin, y: 52 },
    thickness: 0.6,
    color: rgb(0.88, 0.88, 0.88)
  });
  page.drawText("System-generated on DropX letterpad · People & Culture", {
    x: margin,
    y: 36,
    size: 8,
    font: regular,
    color: rgb(0.45, 0.45, 0.45)
  });

  return pdf.save();
}
