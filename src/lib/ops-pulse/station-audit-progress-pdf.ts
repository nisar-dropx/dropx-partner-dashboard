import "regenerator-runtime/runtime";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, rgb } from "pdf-lib";
import * as XLSX from "xlsx";

type Row = Record<string, unknown>;
type Column = { key: string; label: string; width: number };
const navy = rgb(0.12, 0.18, 0.28),
  muted = rgb(0.38, 0.44, 0.52);
const teal = rgb(0.08, 0.45, 0.39),
  orange = rgb(0.67, 0.31, 0.07);
const pale = rgb(0.95, 0.97, 0.98),
  white = rgb(1, 1, 1);
const clean = (value: unknown) =>
  String(value ?? "-")
    .replace(/[–—−]/g, "-")
    .replace(/·/g, " / ")
    .replace(/[\u0000-\u001f]/g, " ");

/** Compact management summary; the workbook retains the full inspection history. */
export async function renderAuditProgressPdf(
  book: XLSX.WorkBook,
  from: string,
  to: string,
) {
  const rows = (name: string) =>
    XLSX.utils.sheet_to_json<Row>(book.Sheets[name]);
  const overview = rows("Overview")[0];
  const doc = await PDFDocument.create();
  doc.setTitle(`Station audit completion | ${from} to ${to}`);
  doc.setAuthor("DropX / OpsPulse");
  doc.registerFontkit(fontkit);
  const script = (s: string) =>
    /[\u0D00-\u0D7F]/.test(s)
      ? "NotoSansMalayalam"
      : /[\u0C00-\u0C7F]/.test(s)
        ? "NotoSansTelugu"
        : /[\u0900-\u097F]/.test(s)
          ? "NotoSansDevanagari"
          : /[\u0B80-\u0BFF]/.test(s)
            ? "NotoSansTamil"
            : /[\u0C80-\u0CFF]/.test(s)
              ? "NotoSansKannada"
              : "NotoSans";
  const fontNames = new Set([
    "NotoSans",
    ...Array.from(
      JSON.stringify([
        overview,
        rows("Station summary"),
        rows("Auditor summary"),
        rows("Audit register"),
      ]),
    ).map(script),
  ]);
  const fonts = new Map<string, PDFFont>();
  for (const name of fontNames)
    fonts.set(
      name,
      await doc.embedFont(
        await readFile(
          path.join(
            process.cwd(),
            "assets/report-fonts",
            `${name}-Regular.ttf`,
          ),
        ),
        { subset: true },
      ),
    );
  const runs = (value: string) => {
    const result: { text: string; font: PDFFont }[] = [];
    for (const ch of value) {
      const font = fonts.get(script(ch))!;
      if (result.at(-1)?.font === font) result[result.length - 1].text += ch;
      else result.push({ text: ch, font });
    }
    return result;
  };
  const measured = new Map<string, number>();
  const width = (text: string, size: number) => {
    const key = `${size}:${text}`;
    let value = measured.get(key);
    if (value === undefined) {
      value = runs(text).reduce(
        (sum, run) => sum + run.font.widthOfTextAtSize(run.text, size),
        0,
      );
      measured.set(key, value);
    }
    return value;
  };
  const wrap = (value: unknown, size: number, maxWidth: number) => {
    const lines: string[] = [];
    let line = "";
    for (const word of clean(value).split(/\s+/)) {
      if (line && width(`${line} ${word}`, size) > maxWidth) {
        lines.push(line);
        line = "";
      }
      // Long identifiers and URLs must wrap as well; never truncate an audit ID.
      for (const ch of `${line ? " " : ""}${word}`) {
        if (line && width(line + ch, size) > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += ch;
      }
    }
    if (line || !lines.length) lines.push(line);
    return lines;
  };
  const W = 842,
    H = 595,
    M = 32,
    contentWidth = W - M * 2;
  let page = doc.addPage([W, H]),
    y = H - 32;
  const text = (
    value: unknown,
    x: number,
    top: number,
    size = 9,
    color = navy,
  ) => {
    for (const run of runs(clean(value))) {
      page.drawText(run.text, {
        x,
        y: top - size,
        size,
        font: run.font,
        color,
      });
      x += run.font.widthOfTextAtSize(run.text, size);
    }
  };
  const header = (section: string) => {
    text("DROPX / OPSPULSE", M, H - 26, 9, teal);
    text(section, M, H - 45, 20);
    text(`${from} to ${to} / Scheduled dates / IST`, M, H - 75, 10, muted);
    y = H - 101;
  };
  const next = (section: string) => {
    page = doc.addPage([W, H]);
    header(section);
  };
  const paragraph = (value: unknown, size = 10, color = muted) => {
    for (const line of wrap(value, size, contentWidth)) {
      if (y < 60) next("Audit completion / continued");
      text(line, M, y, size, color);
      y -= size + 6;
    }
    y -= 8;
  };
  header("Audit completion report");
  const cards = [
    ["Audits", overview["Total audits"]],
    ["Completed & closed", overview["Completed & closed"]],
    ["Not completed", overview["Not completed"]],
    ["Overdue audits", overview["Overdue audits"]],
  ];
  cards.forEach(([label, value], i) => {
    const x = M + (i * (contentWidth + 12)) / 4,
      w = (contentWidth - 36) / 4;
    page.drawRectangle({ x, y: y - 76, width: w, height: 76, color: pale });
    text(label, x + 12, y - 11, 9, muted);
    text(value, x + 12, y - 31, 25, i === 1 ? teal : i === 3 ? orange : navy);
  });
  y -= 100;
  paragraph(
    `Completion: ${overview["Completion %"] == null ? "No audits in this range" : `${(Number(overview["Completion %"]) * 100).toFixed(1)}%`} / Fieldwork submitted: ${overview["Fieldwork submitted"]} / Not submitted: ${overview["Not submitted"]}`,
    12,
    navy,
  );
  paragraph(
    `Station responses pending: ${overview["Station response pending"]} / Responses overdue: ${overview["Overdue station responses"]} / Review pending: ${overview["Review pending"]} / Not yet due: ${overview["Not yet due"]}`,
  );
  paragraph(`Status as of ${overview["Status as of (IST)"]} IST`);
  paragraph(`Filters: ${overview.Filters}`);
  paragraph("How to read this report", 12, teal);
  paragraph(overview["Completion definition"]);
  paragraph(overview["Date basis"]);
  paragraph(overview.Scope);
  paragraph(
    "The audit register below identifies who needs to act. Use Excel for editable team follow-up columns and full cash, checklist, shipment, corrective-action and history records.",
  );

  const table = (
    title: string,
    columns: Column[],
    data: Row[],
    statusKey?: string,
  ) => {
    next(title);
    const tableHeader = () => {
      const wrapped = columns.map((c) => wrap(c.label, 8, c.width - 14));
      const h = Math.max(...wrapped.map((v) => v.length)) * 11 + 14;
      page.drawRectangle({
        x: M,
        y: y - h,
        width: contentWidth,
        height: h,
        color: navy,
      });
      let x = M;
      wrapped.forEach((lines, i) => {
        lines.forEach((line, n) => text(line, x + 7, y - 7 - n * 11, 8, white));
        x += columns[i].width;
      });
      y -= h;
    };
    tableHeader();
    if (!data.length || data[0].Result) {
      y -= 16;
      paragraph("No audits match these dates and filters.");
      return;
    }
    data.forEach((row, index) => {
      const lines = columns.map((c) =>
        wrap(
          c.key === "Completion %" && row[c.key] != null
            ? `${(Number(row[c.key]) * 100).toFixed(1)}%`
            : row[c.key],
          8,
          c.width - 14,
        ),
      );
      // Allow unusually long values to continue on another page, with repeated headings.
      let offset = 0,
        count = Math.max(...lines.map((v) => v.length));
      while (offset < count) {
        if (y < 85) {
          next(`${title} / continued`);
          tableHeader();
        }
        const shown = Math.min(count - offset, Math.floor((y - 55 - 14) / 11));
        const h = shown * 11 + 14;
        if (index % 2 === 0)
          page.drawRectangle({
            x: M,
            y: y - h,
            width: contentWidth,
            height: h,
            color: pale,
          });
        let x = M;
        columns.forEach((c, i) => {
          const color =
            c.key === statusKey
              ? String(row[c.key]).startsWith("Completed")
                ? teal
                : String(row[c.key]).startsWith("Overdue")
                  ? orange
                  : navy
              : navy;
          lines[i]
            .slice(offset, offset + shown)
            .forEach((line, n) => text(line, x + 7, y - 7 - n * 11, 8, color));
          x += c.width;
        });
        y -= h;
        offset += shown;
      }
    });
  };
  const counts: Column[] = [
    { key: "Total audits", label: "Total", width: 60 },
    { key: "Completed & closed", label: "Completed", width: 75 },
    { key: "Not completed", label: "Not completed", width: 82 },
    { key: "Overdue audits", label: "Overdue", width: 70 },
    {
      key: "Station response pending",
      label: "Station reply pending",
      width: 92,
    },
    { key: "Review pending", label: "Review pending", width: 85 },
    { key: "Completion %", label: "Completion", width: 80 },
  ];
  table(
    "Station summary",
    [
      { key: "Station", label: "Station", width: 80 },
      { key: "Station name", label: "Location", width: 154 },
      ...counts,
    ],
    rows("Station summary"),
  );
  table(
    "Auditor summary",
    [
      { key: "Assigned auditor", label: "Assigned auditor", width: 234 },
      ...counts,
    ],
    rows("Auditor summary"),
  );
  table(
    "Audit register / completion and next action",
    [
      { key: "Station", label: "Station", width: 48 },
      { key: "Audit number", label: "Audit ID", width: 128 },
      { key: "Audit type", label: "Type", width: 84 },
      { key: "Scheduled (IST)", label: "Scheduled / IST", width: 85 },
      { key: "Assigned auditor", label: "Auditor", width: 106 },
      { key: "Completion", label: "Completion", width: 103 },
      { key: "Station response status", label: "Station response", width: 94 },
      { key: "Next action", label: "Next action", width: 130 },
    ],
    rows("Audit register"),
    "Completion",
  );
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    text(
      "OpsPulse / Status at export / Authorized stations only",
      M,
      28,
      8,
      muted,
    );
    text(`${i + 1} / ${pages.length}`, W - 68, 28, 8, muted);
  });
  return doc.save();
}
