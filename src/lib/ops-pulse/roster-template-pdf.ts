import "regenerator-runtime/runtime";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import { recurringRosterDays } from "./recurring-roster-import.ts";
import {
  buildRecurringRosterRows,
  type RosterTemplateEntry,
  type RosterTemplatePerson,
  type RosterTemplateRow,
  type RosterTemplateShift,
  type RosterTemplateStation,
  type RosterTemplateStationPeriod
} from "./roster-template-export.ts";

const navy = rgb(0.09, 0.14, 0.24);
const muted = rgb(0.38, 0.44, 0.52);
const orange = rgb(0.9, 0.33, 0.16);
const pale = rgb(0.95, 0.97, 0.99);
const white = rgb(1, 1, 1);
const line = rgb(0.86, 0.89, 0.93);

const clean = (value: unknown) =>
  String(value ?? "")
    .replace(/[–—−]/g, "-")
    .replace(/·/g, " / ")
    .replace(/[\u0000-\u001f]/g, " ")
    .trim();

const scriptFont = (value: string) =>
  /[\u0D00-\u0D7F]/.test(value) ? "NotoSansMalayalam"
    : /[\u0C00-\u0C7F]/.test(value) ? "NotoSansTelugu"
      : /[\u0900-\u097F]/.test(value) ? "NotoSansDevanagari"
        : /[\u0B80-\u0BFF]/.test(value) ? "NotoSansTamil"
          : /[\u0C80-\u0CFF]/.test(value) ? "NotoSansKannada"
            : "NotoSans";

/** Landscape PDF of approved recurring Mon–Sun rosters for the selected stations. */
export async function buildRecurringRosterPdf(input: {
  stations: RosterTemplateStation[];
  people: RosterTemplatePerson[];
  shifts: RosterTemplateShift[];
  entries: RosterTemplateEntry[];
  periods: RosterTemplateStationPeriod[];
  today: string;
  fallbackPeriodStart: string;
}) {
  const rows = buildRecurringRosterRows(input);
  if (rows.length > 8_000) throw new Error("Too many roster rows for one PDF. Select fewer stations or download Excel.");

  const doc = await PDFDocument.create();
  doc.setTitle(`DropX station roster · ${input.today}`);
  doc.setAuthor("DropX / OpsPulse");
  doc.registerFontkit(fontkit);

  const sample = JSON.stringify([input.stations, rows.slice(0, 200), input.shifts]);
  const fontNames = new Set(["NotoSans", ...Array.from(sample).map(scriptFont)]);
  const fonts = new Map<string, PDFFont>();
  for (const name of fontNames) {
    fonts.set(
      name,
      await doc.embedFont(await readFile(path.join(process.cwd(), "assets/report-fonts", `${name}-Regular.ttf`)), { subset: true })
    );
  }
  const bold = await doc.embedFont(await readFile(path.join(process.cwd(), "assets/report-fonts", "NotoSans-Regular.ttf")), { subset: true });

  const runs = (value: string) => {
    const result: { text: string; font: PDFFont }[] = [];
    for (const char of value) {
      const font = fonts.get(scriptFont(char)) ?? bold;
      const last = result.at(-1);
      if (last?.font === font) last.text += char;
      else result.push({ text: char, font });
    }
    return result;
  };
  const textWidth = (value: string, size: number) =>
    runs(value).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0);
  const drawText = (page: ReturnType<typeof doc.addPage>, value: string, x: number, y: number, size: number, color = navy) => {
    let cursor = x;
    for (const run of runs(value)) {
      page.drawText(run.text, { x: cursor, y, size, font: run.font, color });
      cursor += run.font.widthOfTextAtSize(run.text, size);
    }
  };
  const fit = (value: string, size: number, maxWidth: number) => {
    const text = clean(value) || "—";
    if (textWidth(text, size) <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && textWidth(`${out}…`, size) > maxWidth) out = out.slice(0, -1);
    return `${out}…`;
  };

  const pageWidth = 842;
  const pageHeight = 595;
  const margin = 28;
  const columns: Array<{ key: keyof RosterTemplateRow; label: string; width: number }> = [
    { key: "DROPX_ID", label: "DropX ID", width: 68 },
    { key: "NAME", label: "Name", width: 118 },
    { key: "DESIGNATION", label: "Designation", width: 92 },
    ...recurringRosterDays.map((day) => ({ key: day as keyof RosterTemplateRow, label: day.slice(0, 3), width: 48 }))
  ];
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);

  const byStation = new Map<string, RosterTemplateRow[]>();
  for (const row of rows) {
    const list = byStation.get(row.LOCATION_CODE) ?? [];
    list.push(row);
    byStation.set(row.LOCATION_CODE, list);
  }

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const newPage = () => {
    page = doc.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
    page.drawText("DropX · Station roster (continued)", { x: margin, y, size: 9, font: bold, color: muted });
    y -= 16;
  };

  const ensure = (needed: number) => {
    if (y - needed < margin + 18) newPage();
  };

  page.drawRectangle({ x: 0, y: pageHeight - 8, width: pageWidth, height: 8, color: orange });
  drawText(page, "DropX · OpsPulse station roster", margin, y - 4, 16, navy);
  y -= 22;
  drawText(page, `Generated ${input.today} IST · ${input.stations.length} station(s) · approved recurring Mon–Sun pattern`, margin, y, 9, muted);
  y -= 18;

  for (const station of [...input.stations].sort((left, right) => left.station_code.localeCompare(right.station_code))) {
    const stationRows = byStation.get(station.station_code) ?? [];
    const period = stationRows[0]?.PERIOD_START || input.fallbackPeriodStart;
    ensure(54);
    page.drawRectangle({ x: margin, y: y - 4, width: tableWidth, height: 18, color: navy });
    drawText(page, `${station.station_code}  ·  ${clean(station.station_name || station.station_code)}  ·  week from ${period}`, margin + 6, y, 10, white);
    y -= 22;

    page.drawRectangle({ x: margin, y: y - 3, width: tableWidth, height: 16, color: pale });
    let x = margin;
    for (const column of columns) {
      drawText(page, column.label, x + 3, y, 8, muted);
      x += column.width;
    }
    y -= 16;

    for (const [index, row] of stationRows.entries()) {
      ensure(14);
      if (index % 2) page.drawRectangle({ x: margin, y: y - 3, width: tableWidth, height: 13, color: pale });
      x = margin;
      for (const column of columns) {
        drawText(page, fit(String(row[column.key] ?? ""), 8, column.width - 6), x + 3, y, 8, navy);
        x += column.width;
      }
      page.drawLine({ start: { x: margin, y: y - 3 }, end: { x: margin + tableWidth, y: y - 3 }, thickness: 0.4, color: line });
      y -= 13;
    }
    y -= 12;
  }

  ensure(40);
  drawText(page, "Shift master", margin, y, 11, navy);
  y -= 14;
  for (const shift of input.shifts) {
    ensure(12);
    drawText(
      page,
      `${shift.code}  ${clean(shift.name)}  ${String(shift.start_time).slice(0, 5)}–${String(shift.end_time).slice(0, 5)}`,
      margin,
      y,
      8,
      muted
    );
    y -= 11;
  }

  return Buffer.from(await doc.save());
}
