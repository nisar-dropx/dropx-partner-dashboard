import { PDFDocument, PDFFont, PDFPage, RGB, StandardFonts, rgb } from "pdf-lib";

export type PayLineItem = {
  name: string;
  /** Amount actually paid / deducted this period. */
  amount: number;
  /** Full-month (un-prorated) rate. When any earning has one, a "Full Month" column is shown. */
  rate?: number | null;
};

export type SalaryVersion = {
  /** Display label such as "V1". Defaults to V{index + 1}. */
  label?: string | null;
  effectiveFrom: string;
  /** ISO date, or null when the version is still open. */
  effectiveTo: string | null;
  /** Monthly salary / contract rate for this version. */
  monthlyAmount: number;
};

export type PayDocumentInput = {
  companyName: string;
  registeredAddress?: string;
  footerText?: string;
  /** Shown under the title while the month is still open, so a saved copy is not read as final. */
  provisionalNote?: string;
  /**
   * Adds a "for {company} / Authorised Signatory" block for a copy HR will sign and stamp
   * (bank loans, visas). Off by default: standard payslips are computer-generated and unsigned.
   */
  includeSignature?: boolean;
  /** Signatory title printed under the signature line when `includeSignature` is set. */
  authorisedSignatory?: string;
  showAttendance?: boolean;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  documentNumber: string;
  workerType: "employee" | "contractor";
  workerCode: string | null;
  workerName: string;
  locationName: string | null;
  departmentName: string | null;
  designationName: string | null;
  paymentBasis: string | null;
  expectedDays: number;
  presentDays: number;
  /** Paid leave days, including any WFH days (wfhDays is shown separately). */
  paidLeaveDays: number;
  absenceDays: number;
  halfDays: number;
  payableDays?: number;
  weekoffDays?: number;
  wfhDays?: number;
  grossPay: number;
  statutoryDeductions: number;
  attendanceDeductions: number;
  otherDeductions: number;
  employerContributions: number;
  netPay: number;
  earnings: PayLineItem[];
  deductions: PayLineItem[];
  employerItems?: PayLineItem[];
  publishedAt: string;
  dateOfJoining?: string | null;
  bankAccountNo?: string | null;
  ifscCode?: string | null;
  panNumber?: string | null;
  pfUan?: string | null;
  pfAccountNo?: string | null;
  esiNo?: string | null;
  /** "old" (shown as "Regular Tax Regime") or "new" ("New Tax Regime"). Row is hidden when unset. */
  taxRegime?: string | null;
  /** PR Account Number (NPS). Row is hidden when unset — most workers will not have one. */
  pran?: string | null;
  /**
   * Legacy pre-formatted versions string ("V1 2026-08-05 → 2026-09-23 @ 22,000; V2 ...").
   * Parsed into `salaryVersions` when possible. Prefer passing `salaryVersions` directly.
   */
  salaryVersionsLabel?: string | null;
  /** Salary versions that applied during the period. Only shown when the salary changed mid-period. */
  salaryVersions?: SalaryVersion[] | null;
  /** PNG bytes for the letterhead logo (top-right). Falls back to a text wordmark when omitted. */
  logoPng?: Uint8Array | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const COLORS = {
  ink: rgb(0.1, 0.11, 0.14),
  muted: rgb(0.4, 0.43, 0.48),
  border: rgb(0.62, 0.65, 0.7),
  headFill: rgb(0.94, 0.95, 0.96),
  brand: rgb(0.95, 0.45, 0.08),
  logoGrey: rgb(0.36, 0.38, 0.42)
};

function taxRegimeLabel(value: string | null | undefined) {
  if (value === "old") return "Regular Tax Regime";
  if (value === "new") return "New Tax Regime";
  return null;
}

function amount(value: number) {
  return Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function days(value: number | undefined) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function inrWords(value: number) {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const chunk = (n: number): string => {
    if (n < 20) return ones[n];
    if (n < 100) return `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`;
    return `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${chunk(n % 100)}` : ""}`;
  };
  const words = (n: number): string => {
    const crore = Math.floor(n / 1e7);
    const lakh = Math.floor((n % 1e7) / 1e5);
    const thousand = Math.floor((n % 1e5) / 1e3);
    const hundred = n % 1000;
    return [
      crore ? `${words(crore)} Crore` : "",
      lakh ? `${chunk(lakh)} Lakh` : "",
      thousand ? `${chunk(thousand)} Thousand` : "",
      hundred ? chunk(hundred) : ""
    ].filter(Boolean).join(" ");
  };
  const totalPaise = Math.round(Math.abs(Number(value || 0)) * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;
  if (!rupees && !paise) return "INR Zero Only";
  const rupeeText = rupees ? words(rupees) : "Zero";
  return `INR ${rupeeText}${paise ? ` and ${chunk(paise)} Paise` : ""} Only`;
}

/** Standard PDF fonts only cover WinAnsi; map the common Unicode punctuation instead of silently dropping it. */
function safe(text: string | null | undefined) {
  return String(text ?? "")
    .replace(/[→⇒➝]/g, " to ")
    .replace(/[–—−]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/₹/g, "INR ")
    .replace(/[·•]/g, "|")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

function fit(text: string, font: PDFFont, size: number, maxWidth: number) {
  const value = safe(text);
  if (!value) return "";
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  let clipped = value;
  while (clipped.length > 1 && font.widthOfTextAtSize(`${clipped}...`, size) > maxWidth) clipped = clipped.slice(0, -1);
  return `${clipped.trimEnd()}...`;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number) {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ").filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  return `${Number(match[3])}-${MONTHS[Number(match[2]) - 1]}-${match[1]}`;
}

/** Parses the legacy "V1 2026-08-05 → 2026-09-23 @ 22,000; V2 2026-09-24 → open @ 24,500" label. */
export function parseSalaryVersionsLabel(label: string | null | undefined): SalaryVersion[] {
  const versions: SalaryVersion[] = [];
  const pattern = /(V\d+)\s*(\d{4}-\d{2}-\d{2})\D*?(\d{4}-\d{2}-\d{2}|open)\s*@\s*(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)/gi;
  for (const match of String(label || "").matchAll(pattern)) {
    versions.push({
      label: match[1].toUpperCase(),
      effectiveFrom: match[2],
      effectiveTo: match[3].toLowerCase() === "open" ? null : match[3],
      monthlyAmount: Number(match[4].replace(/,/g, ""))
    });
  }
  return versions;
}

/**
 * Salary versions as they applied inside the pay period: versions outside it are dropped and
 * the dates are clipped to the period, so the table never shows a date from another month.
 */
export function salaryVersionsInPeriod(versions: SalaryVersion[], periodStart: string, periodEnd: string): SalaryVersion[] {
  return versions
    .filter((version) => version.effectiveFrom <= periodEnd && (!version.effectiveTo || version.effectiveTo >= periodStart))
    .map((version) => ({
      ...version,
      effectiveFrom: version.effectiveFrom < periodStart ? periodStart : version.effectiveFrom,
      effectiveTo: !version.effectiveTo || version.effectiveTo > periodEnd ? periodEnd : version.effectiveTo
    }));
}

/** Collapses rows that would not fit into a single "Other ..." row so totals stay correct on one page. */
function capRows(items: PayLineItem[], max: number, otherLabel: string) {
  if (items.length <= max) return items;
  const kept = items.slice(0, max - 1);
  const rest = items.slice(max - 1);
  return [...kept, { name: `${otherLabel} (${rest.length} items)`, amount: rest.reduce((sum, item) => sum + Number(item.amount || 0), 0) }];
}

type Align = "left" | "right" | "center";

class Canvas {
  constructor(
    readonly page: PDFPage,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly italic: PDFFont
  ) {}

  text(value: string, x: number, y: number, opts: { size?: number; font?: PDFFont; color?: RGB; align?: Align; maxWidth?: number } = {}) {
    const size = opts.size ?? 8.5;
    const font = opts.font ?? this.regular;
    const content = opts.maxWidth ? fit(value, font, size, opts.maxWidth) : safe(value);
    if (!content) return;
    const width = font.widthOfTextAtSize(content, size);
    const drawX = opts.align === "right" ? x - width : opts.align === "center" ? x - width / 2 : x;
    this.page.drawText(content, { x: drawX, y, size, font, color: opts.color ?? COLORS.ink });
  }

  /** Text vertically centred inside a cell whose top edge is `top`. */
  cell(value: string, x: number, top: number, width: number, height: number, opts: { size?: number; font?: PDFFont; color?: RGB; align?: Align } = {}) {
    const size = opts.size ?? 8.5;
    const pad = 5;
    const baseline = top - height / 2 - size * 0.35;
    const anchor = opts.align === "right" ? x + width - pad : opts.align === "center" ? x + width / 2 : x + pad;
    this.text(value, anchor, baseline, { ...opts, size, maxWidth: width - pad * 2 });
  }

  rect(x: number, top: number, width: number, height: number, opts: { fill?: RGB; border?: RGB; borderWidth?: number } = {}) {
    this.page.drawRectangle({
      x,
      y: top - height,
      width,
      height,
      color: opts.fill,
      borderColor: opts.border,
      borderWidth: opts.border ? opts.borderWidth ?? 0.6 : 0
    });
  }

  hline(x1: number, x2: number, y: number, color: RGB = COLORS.border, thickness = 0.6) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  vline(x: number, top: number, bottom: number, color: RGB = COLORS.border, thickness = 0.6) {
    this.page.drawLine({ start: { x, y: top }, end: { x, y: bottom }, thickness, color });
  }
}

/**
 * DropX payslip for employees and contractors, following the layout used by large Indian
 * employers' payroll systems (ADP, Workday, greytHR): letterhead, title bar, ruled employee
 * grid, attendance, side-by-side earnings and deductions, Net Pay with amount in words,
 * employer contributions, and a "computer-generated, no signature required" footer.
 */
export async function createPayDocumentPdf(input: PayDocumentInput) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const page = pdf.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  const c = new Canvas(page, regular, bold, italic);
  const margin = 36;
  const right = width - margin;
  const contentWidth = right - margin;
  const half = contentWidth / 2;
  const isEmployee = input.workerType === "employee";
  const company = safe(input.companyName) || "DROPX LOGISTICS";

  pdf.setTitle(`Payslip - ${safe(input.workerName)} - ${safe(input.periodLabel)}`);
  pdf.setAuthor(company);
  pdf.setSubject(safe(input.documentNumber));
  pdf.setCreator(company);

  /** Small uppercase heading above a table. */
  const sectionHeading = (label: string) => {
    c.text(label.toUpperCase(), margin, y - 8, { size: 7.5, font: bold, color: COLORS.muted });
    y -= 13;
  };

  // ── Letterhead ──────────────────────────────────────────────────────────
  let y = height - 48;
  const logoHeight = 34;
  let logoDrawn = false;
  if (input.logoPng?.length) {
    try {
      const logo = await pdf.embedPng(input.logoPng);
      const logoWidth = Math.min((logo.width / logo.height) * logoHeight, 150);
      const drawHeight = (logo.height / logo.width) * logoWidth;
      page.drawImage(logo, { x: right - logoWidth, y: y + 14 - drawHeight, width: logoWidth, height: drawHeight });
      logoDrawn = true;
    } catch {
      logoDrawn = false;
    }
  }
  if (!logoDrawn) {
    const markSize = 20;
    const xWidth = bold.widthOfTextAtSize("X", markSize);
    const dropWidth = bold.widthOfTextAtSize("Drop", markSize);
    page.drawText("Drop", { x: right - xWidth - dropWidth, y: y - 6, size: markSize, font: bold, color: COLORS.logoGrey });
    page.drawText("X", { x: right - xWidth, y: y - 6, size: markSize, font: bold, color: COLORS.brand });
  }

  c.text(company.toUpperCase(), margin, y, { size: 14, font: bold, maxWidth: 330 });
  y -= 13;
  // Split before sanitising — safe() collapses newlines, which used to glue address lines together.
  const addressLines = String(input.registeredAddress || "")
    .split(/\r?\n/)
    .flatMap((part) => wrap(safe(part), regular, 8.5, 330))
    .slice(0, 4);
  for (const lineText of addressLines) {
    c.text(lineText, margin, y, { size: 8.5, color: COLORS.muted, maxWidth: 330 });
    y -= 11;
  }
  y = Math.min(y, height - 48 - logoHeight) - 6;

  // ── Title bar ───────────────────────────────────────────────────────────
  const titleH = 22;
  c.rect(margin, y, contentWidth, titleH, { fill: COLORS.headFill, border: COLORS.border });
  c.cell(`Payslip for the month of ${input.periodLabel}`, margin, y, contentWidth, titleH, { size: 11, font: bold, align: "center" });
  y -= titleH + 10;
  if (input.provisionalNote) {
    c.text(input.provisionalNote, margin, y, { size: 8.5, font: italic, color: COLORS.brand, maxWidth: contentWidth });
    y -= 14;
  }

  // ── Employee details (fully ruled key/value grid) ──────────────────────
  const rowH = 16;
  const labelW = 112;
  type Pair = [string, string];
  // Optional statutory fields (Tax Regime, PRAN) are hidden rather than shown as blank placeholders.
  // Contractors are not covered by PF/ESI, so those rows only appear for them when a value exists.
  const statutoryRow = (label: string, value: string | null | undefined): Pair[] =>
    isEmployee || value?.trim() ? [[label, value?.trim() || "-"]] : [];
  const regime = taxRegimeLabel(input.taxRegime);
  // Left column: who the person is. Right column: the pay period first, then bank and statutory details.
  const leftPairs: Pair[] = [
    [isEmployee ? "Employee Name" : "Contractor Name", input.workerName || "-"],
    [isEmployee ? "Employee ID" : "Contractor ID", input.workerCode || "-"],
    ["Designation", input.designationName || "-"],
    ["Department", input.departmentName || "-"],
    ["Location", input.locationName || "-"],
    ["Date of Joining", formatDate(input.dateOfJoining) || "-"]
  ];
  const rightPairs: Pair[] = [
    ["Pay Period", `${formatDate(input.periodStart)} to ${formatDate(input.periodEnd)}`],
    ["Bank Account No.", input.bankAccountNo?.trim() || "-"],
    ["IFSC Code", input.ifscCode?.trim().toUpperCase() || "-"],
    ["PAN", input.panNumber || "-"],
    ...statutoryRow("UAN", input.pfUan),
    ...statutoryRow("PF Account Number", input.pfAccountNo),
    ...statutoryRow("ESI Number", input.esiNo),
    ...(regime ? [["Tax Regime", regime] as Pair] : []),
    ...(input.pran?.trim() ? [["PRAN", input.pran.trim()] as Pair] : [])
  ];
  // Keep the columns within one row of each other so neither ends in a run of empty cells.
  while (rightPairs.length - leftPairs.length > 1) leftPairs.push(rightPairs.pop() as Pair);
  while (leftPairs.length - rightPairs.length > 1) rightPairs.push(leftPairs.pop() as Pair);
  const detailRows = Math.max(leftPairs.length, rightPairs.length);
  const detailsH = detailRows * rowH;
  const pairCols = [margin, margin + labelW, margin + half, margin + half + labelW];
  for (let i = 0; i < detailRows; i += 1) {
    if (leftPairs[i]) c.rect(margin, y - i * rowH, labelW, rowH, { fill: COLORS.headFill });
    if (rightPairs[i]) c.rect(margin + half, y - i * rowH, labelW, rowH, { fill: COLORS.headFill });
  }
  c.rect(margin, y, contentWidth, detailsH, { border: COLORS.border });
  pairCols.slice(1).forEach((x) => c.vline(x, y, y - detailsH));
  for (let i = 0; i < detailRows; i += 1) {
    const top = y - i * rowH;
    if (i) c.hline(margin, right, top);
    const l = leftPairs[i];
    const r = rightPairs[i];
    if (l) {
      c.cell(l[0], pairCols[0], top, labelW, rowH, { size: 8, font: bold, color: COLORS.muted });
      c.cell(l[1], pairCols[1], top, half - labelW, rowH, { size: 8.5, font: i === 0 ? bold : regular });
    }
    if (r) {
      c.cell(r[0], pairCols[2], top, labelW, rowH, { size: 8, font: bold, color: COLORS.muted });
      c.cell(r[1], pairCols[3], top, half - labelW, rowH, { size: 8.5 });
    }
  }
  y -= detailsH + 12;

  // ── Attendance details ─────────────────────────────────────────────────
  if (input.showAttendance !== false) {
    const wfh = Number(input.wfhDays || 0);
    const weekoff = Number(input.weekoffDays || 0);
    const payable = input.payableDays ?? input.presentDays + input.halfDays * 0.5 + input.paidLeaveDays + weekoff;
    const cols: Array<[string, string]> = [
      ["Total Days", days(input.expectedDays)],
      ["Present", days(input.presentDays)],
      ["Half Days", days(input.halfDays)],
      ["Paid Leave", days(Math.max(0, input.paidLeaveDays - wfh))],
      ["WFH", days(wfh)],
      ["Week Off", days(weekoff)],
      ["LOP Days", days(input.absenceDays)],
      ["Paid Days", days(payable)]
    ];
    const headH = 15;
    const valH = 17;
    const colW = contentWidth / cols.length;
    sectionHeading("Attendance Details");
    c.rect(margin, y, contentWidth, headH, { fill: COLORS.headFill });
    c.rect(margin, y, contentWidth, headH + valH, { border: COLORS.border });
    c.hline(margin, right, y - headH);
    cols.forEach(([label, value], index) => {
      const x = margin + colW * index;
      if (index) c.vline(x, y, y - headH - valH);
      const isPaid = index === cols.length - 1;
      c.cell(label, x, y, colW, headH, { size: 7.5, font: bold, align: "center" });
      c.cell(value, x, y - headH, colW, valH, { size: 9, font: isPaid ? bold : regular, align: "center" });
    });
    y -= headH + valH + 12;
  }

  // ── Salary revision (only when pay changed mid-period) ─────────────────
  const versions = salaryVersionsInPeriod(
    input.salaryVersions?.length ? input.salaryVersions : parseSalaryVersionsLabel(input.salaryVersionsLabel),
    input.periodStart,
    input.periodEnd
  );
  if (versions.length > 1) {
    const shown = versions.slice(0, 4);
    const headH = 15;
    const verRowH = 15;
    const widths = [70, 250, contentWidth - 320];
    const xs = [margin, margin + widths[0], margin + widths[0] + widths[1]];
    sectionHeading("Salary Revision Details (earnings pro-rated)");
    const tableH = headH + shown.length * verRowH;
    c.rect(margin, y, contentWidth, headH, { fill: COLORS.headFill });
    c.rect(margin, y, contentWidth, tableH, { border: COLORS.border });
    c.hline(margin, right, y - headH);
    ["Revision", "Effective Period", isEmployee ? "Monthly Gross (INR)" : "Monthly Rate (INR)"].forEach((label, i) => {
      c.cell(label, xs[i], y, widths[i], headH, { size: 8, font: bold, align: i === 2 ? "right" : "left" });
    });
    xs.slice(1).forEach((x) => c.vline(x, y, y - tableH));
    let vTop = y - headH;
    shown.forEach((version, index) => {
      if (index) c.hline(margin, right, vTop);
      const period = `${formatDate(version.effectiveFrom)} to ${formatDate(version.effectiveTo ?? input.periodEnd)}`;
      c.cell(version.label || `V${index + 1}`, xs[0], vTop, widths[0], verRowH);
      c.cell(period, xs[1], vTop, widths[1], verRowH);
      c.cell(amount(version.monthlyAmount), xs[2], vTop, widths[2], verRowH, { align: "right" });
      vTop -= verRowH;
    });
    y -= tableH + 12;
  }

  // ── Earnings & deductions ──────────────────────────────────────────────
  const earnings = input.earnings.length ? input.earnings : [{ name: "Gross Pay", amount: input.grossPay }];
  const deductions = input.deductions.length
    ? input.deductions
    : [
        ...(input.statutoryDeductions ? [{ name: "Statutory Deductions", amount: input.statutoryDeductions }] : []),
        ...(input.attendanceDeductions ? [{ name: "Loss of Pay", amount: input.attendanceDeductions }] : []),
        ...(input.otherDeductions ? [{ name: "Other Deductions", amount: input.otherDeductions }] : [])
      ];
  const employerItems = input.employerItems?.length
    ? input.employerItems
    : input.employerContributions
      ? [{ name: "Employer Contribution", amount: input.employerContributions }]
      : [];

  const lineH = 15;
  // Everything below the line items (net pay rows, employer table, footer) needs this much room.
  const employerBlockH = employerItems.length ? 14 * (employerItems.length + 2) + 25 : 0;
  const signatureBlockH = input.includeSignature ? 70 : 0;
  const reserved = lineH * 3 + 12 + Math.max(employerBlockH, signatureBlockH) + 60;
  const maxLines = Math.max(4, Math.floor((y - reserved - lineH * 2) / lineH));
  const earningRows = capRows(earnings, maxLines, "Other Earnings");
  const deductionRows = capRows(deductions, maxLines, "Other Deductions");
  const lines = Math.max(earningRows.length, deductionRows.length, 1);
  const totalEarnings = earningRows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalDeductions = deductionRows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  // "Full month" rate column, shown only when the caller supplies rates (standard on MNC payslips).
  const showRate = earningRows.some((item) => item.rate != null);
  const totalRate = earningRows.reduce((sum, item) => sum + Number(item.rate ?? item.amount ?? 0), 0);

  const amtW = 80;
  const earnCols = showRate
    ? [{ x: margin, w: half - 140 }, { x: margin + half - 140, w: 70 }, { x: margin + half - 70, w: 70 }]
    : [{ x: margin, w: half - amtW }, { x: margin + half - amtW, w: amtW }];
  const dedCols = [{ x: margin + half, w: half - amtW }, { x: right - amtW, w: amtW }];
  const tableH = lineH * (lines + 2);
  sectionHeading("Salary Details");
  c.rect(margin, y, contentWidth, lineH, { fill: COLORS.headFill });
  c.rect(margin, y, contentWidth, tableH, { border: COLORS.border });
  c.hline(margin, right, y - lineH);
  c.hline(margin, right, y - lineH * (lines + 1));
  [...earnCols.slice(1), ...dedCols].forEach(({ x }) => c.vline(x, y, y - tableH));
  const earnHead = showRate ? ["Earnings", "Full Month", "Earned"] : ["Earnings", "Amount (INR)"];
  earnHead.forEach((label, i) => c.cell(label, earnCols[i].x, y, earnCols[i].w, lineH, { font: bold, align: i ? "right" : "left" }));
  ["Deductions", "Amount (INR)"].forEach((label, i) => c.cell(label, dedCols[i].x, y, dedCols[i].w, lineH, { font: bold, align: i ? "right" : "left" }));
  let lineTop = y - lineH;
  for (let i = 0; i < lines; i += 1) {
    const e = earningRows[i];
    const d = deductionRows[i];
    if (e) {
      c.cell(e.name, earnCols[0].x, lineTop, earnCols[0].w, lineH);
      if (showRate) c.cell(amount(e.rate ?? e.amount), earnCols[1].x, lineTop, earnCols[1].w, lineH, { align: "right" });
      const last = earnCols[earnCols.length - 1];
      c.cell(amount(e.amount), last.x, lineTop, last.w, lineH, { align: "right" });
    }
    if (d) {
      c.cell(d.name, dedCols[0].x, lineTop, dedCols[0].w, lineH);
      c.cell(amount(d.amount), dedCols[1].x, lineTop, dedCols[1].w, lineH, { align: "right" });
    }
    lineTop -= lineH;
  }
  c.cell("Total Earnings", earnCols[0].x, lineTop, earnCols[0].w, lineH, { font: bold });
  if (showRate) c.cell(amount(totalRate), earnCols[1].x, lineTop, earnCols[1].w, lineH, { font: bold, align: "right" });
  const lastEarn = earnCols[earnCols.length - 1];
  c.cell(amount(totalEarnings), lastEarn.x, lineTop, lastEarn.w, lineH, { font: bold, align: "right" });
  c.cell("Total Deductions", dedCols[0].x, lineTop, dedCols[0].w, lineH, { font: bold });
  c.cell(amount(totalDeductions), dedCols[1].x, lineTop, dedCols[1].w, lineH, { font: bold, align: "right" });
  y -= tableH;

  // ── Net pay summary (same label/value grid style as the employee details) ──
  const netH = 22;
  const wordsH = 17;
  y -= 10;
  c.rect(margin, y, labelW, netH + wordsH, { fill: COLORS.headFill });
  c.rect(margin, y, contentWidth, netH + wordsH, { border: COLORS.border });
  c.hline(margin, right, y - netH);
  c.vline(margin + labelW, y, y - netH - wordsH);
  c.cell("Net Pay", margin, y, labelW, netH, { size: 9.5, font: bold });
  c.cell(`INR ${amount(input.netPay)}`, margin + labelW, y, contentWidth - labelW, netH, { size: 11, font: bold });
  c.cell("Amount in Words", margin, y - netH, labelW, wordsH, { size: 8, font: bold, color: COLORS.muted });
  c.cell(inrWords(input.netPay), margin + labelW, y - netH, contentWidth - labelW, wordsH, { size: 8.5 });
  y -= netH + wordsH + 14;

  // ── Employer contributions (left) and optional signature (right) ───────
  const blockTop = y;
  if (employerItems.length) {
    const ecH = 14;
    const ecW = half;
    const ecTableH = ecH * (employerItems.length + 2);
    sectionHeading("Employer Contributions");
    c.rect(margin, y, ecW, ecH, { fill: COLORS.headFill });
    c.rect(margin, y, ecW, ecTableH, { border: COLORS.border });
    c.hline(margin, margin + ecW, y - ecH);
    c.hline(margin, margin + ecW, y - ecH * (employerItems.length + 1));
    c.vline(margin + ecW - amtW, y, y - ecTableH);
    c.cell("Contribution", margin, y, ecW - amtW, ecH, { font: bold });
    c.cell("Amount (INR)", margin + ecW - amtW, y, amtW, ecH, { font: bold, align: "right" });
    let ecTop = y - ecH;
    for (const item of employerItems) {
      c.cell(item.name, margin, ecTop, ecW - amtW, ecH);
      c.cell(amount(item.amount), margin + ecW - amtW, ecTop, amtW, ecH, { align: "right" });
      ecTop -= ecH;
    }
    c.cell("Total", margin, ecTop, ecW - amtW, ecH, { font: bold });
    c.cell(amount(employerItems.reduce((sum, item) => sum + Number(item.amount || 0), 0)), margin + ecW - amtW, ecTop, amtW, ecH, { font: bold, align: "right" });
    y -= ecTableH + 12;
  }

  if (input.includeSignature) {
    const signW = half - 20;
    c.text(`For ${company.toUpperCase()}`, right, blockTop - 8, { size: 9, font: bold, align: "right", maxWidth: signW });
    // Space for a hand signature and company stamp.
    c.hline(right - 150, right, blockTop - 52);
    c.text(input.authorisedSignatory || "Authorised Signatory", right, blockTop - 63, { size: 8.5, align: "right", maxWidth: signW });
    y = Math.min(y, blockTop - signatureBlockH);
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  const footerY = 30;
  c.hline(margin, right, footerY + 12, COLORS.border, 0.5);
  const footerText = input.footerText
    || (input.includeSignature
      ? "This payslip is valid only with the authorised signatory's signature and company seal."
      : "This is a computer-generated payslip and does not require a signature.");
  wrap(safe(footerText), regular, 7, contentWidth - 205)
    .slice(0, 2)
    .forEach((lineText, index) => c.text(lineText, margin, footerY - index * 9, { size: 7, color: COLORS.muted }));
  const meta = [input.documentNumber ? `Doc No: ${input.documentNumber}` : "", input.publishedAt ? `Generated: ${formatDate(input.publishedAt)}` : ""]
    .filter(Boolean)
    .join("  |  ");
  c.text(meta, right, footerY, { size: 7, color: COLORS.muted, align: "right", maxWidth: 195 });

  return pdf.save();
}
