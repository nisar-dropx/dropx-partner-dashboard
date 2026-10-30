import "regenerator-runtime/runtime.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
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

type Column = { key: keyof RosterTemplateRow; label: string; width: number; align?: "left" | "center" };

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
  doc.setTitle(`DropX station roster / ${input.today}`);
  doc.setAuthor("DropX / OpsPulse");
  doc.registerFontkit(fontkit);

  const sample = JSON.stringify([input.stations, rows.slice(0, 400), input.shifts]);
  const fontNames = new Set(["NotoSans", ...Array.from(sample).map(scriptFont)]);
  const fonts = new Map<string, PDFFont>();
  for (const name of fontNames) {
    fonts.set(
      name,
      await doc.embedFont(await readFile(path.join(process.cwd(), "assets/report-fonts", `${name}-Regular.ttf`)), { subset: true })
    );
  }
  const bodyFont = fonts.get("NotoSans")!;

  const runs = (value: string) => {
    const result: { text: string; font: PDFFont }[] = [];
    for (const char of value) {
      const font = fonts.get(scriptFont(char)) ?? bodyFont;
      const last = result.at(-1);
      if (last?.font === font) last.text += char;
      else result.push({ text: char, font });
    }
    return result;
  };
  const measured = new Map<string, number>();
  const textWidth = (value: string, size: number) => {
    const key = `${size}:${value}`;
    let width = measured.get(key);
    if (width === undefined) {
      width = runs(value).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0);
      measured.set(key, width);
    }
    return width;
  };
  const drawText = (page: PDFPage, value: string, x: number, baseline: number, size: number, color = navy) => {
    let cursor = x;
    for (const run of runs(value)) {
      page.drawText(run.text, { x: cursor, y: baseline, size, font: run.font, color });
      cursor += run.font.widthOfTextAtSize(run.text, size);
    }
    return cursor - x;
  };
  /** Word-wrap first; hard-wrap long tokens so nothing is clipped. */
  const wrap = (value: unknown, size: number, maxWidth: number) => {
    const text = clean(value);
    if (!text) return ["-"];
    const lines: string[] = [];
    let line = "";
    const pushWord = (word: string) => {
      if (!word) return;
      if (line && textWidth(`${line} ${word}`, size) <= maxWidth) {
        line = `${line} ${word}`;
        return;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      if (textWidth(word, size) <= maxWidth) {
        line = word;
        return;
      }
      let chunk = "";
      for (const char of word) {
        if (chunk && textWidth(chunk + char, size) > maxWidth) {
          lines.push(chunk);
          chunk = "";
        }
        chunk += char;
      }
      line = chunk;
    };
    for (const word of text.split(/\s+/)) pushWord(word);
    if (line || !lines.length) lines.push(line || "-");
    return lines;
  };

  const pageWidth = 842;
  const pageHeight = 595;
  const marginX = 24;
  const marginY = 22;
  const contentWidth = pageWidth - marginX * 2;
  const dayWidth = 46;
  const idWidth = 72;
  const designationWidth = 110;
  const nameWidth = contentWidth - idWidth - designationWidth - dayWidth * recurringRosterDays.length;
  const columns: Column[] = [
    { key: "DROPX_ID", label: "DropX ID", width: idWidth },
    { key: "NAME", label: "Name", width: Math.max(140, nameWidth) },
    { key: "DESIGNATION", label: "Designation", width: designationWidth },
    ...recurringRosterDays.map((day) => ({
      key: day as keyof RosterTemplateRow,
      label: day.slice(0, 3),
      width: dayWidth,
      align: "center" as const
    }))
  ];
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const lineHeight = 11;
  const cellPadY = 5;
  const cellPadX = 5;

  const byStation = new Map<string, RosterTemplateRow[]>();
  for (const row of rows) {
    const list = byStation.get(row.LOCATION_CODE) ?? [];
    list.push(row);
    byStation.set(row.LOCATION_CODE, list);
  }

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - marginY;

  const startPage = (continued = false) => {
    page = continued ? doc.addPage([pageWidth, pageHeight]) : page;
    y = pageHeight - marginY;
    page.drawRectangle({ x: 0, y: pageHeight - 6, width: pageWidth, height: 6, color: orange });
    drawText(page, continued ? "DropX / OpsPulse station roster (continued)" : "DropX / OpsPulse station roster", marginX, y - 12, continued ? 10 : 15, navy);
    y -= continued ? 22 : 28;
    if (!continued) {
      drawText(
        page,
        `Generated ${input.today} IST / ${input.stations.length} station(s) / approved recurring Mon-Sun pattern`,
        marginX,
        y - 8,
        9,
        muted
      );
      y -= 20;
    }
  };

  const ensure = (needed: number) => {
    if (y - needed < marginY + 12) {
      startPage(true);
      return true;
    }
    return false;
  };

  const drawStationBanner = (code: string, name: string, period: string) => {
    const bannerLines = wrap(`${code}  /  ${name}  /  week from ${period}`, 10, tableWidth - 16);
    const height = Math.max(22, bannerLines.length * 12 + 10);
    ensure(height + 28);
    page.drawRectangle({ x: marginX, y: y - height, width: tableWidth, height, color: navy });
    bannerLines.forEach((text, index) => {
      drawText(page, text, marginX + 8, y - 14 - index * 12, 10, white);
    });
    y -= height + 4;
  };

  const drawColumnHeader = () => {
    const headerLines = columns.map((column) => wrap(column.label, 8, column.width - cellPadX * 2));
    const height = Math.max(...headerLines.map((lines) => lines.length)) * lineHeight + cellPadY * 2;
    ensure(height + 8);
    page.drawRectangle({ x: marginX, y: y - height, width: tableWidth, height, color: pale });
    let x = marginX;
    columns.forEach((column, index) => {
      headerLines[index].forEach((text, lineIndex) => {
        const width = textWidth(text, 8);
        const textX = column.align === "center"
          ? x + (column.width - width) / 2
          : x + cellPadX;
        drawText(page, text, textX, y - cellPadY - 8 - lineIndex * lineHeight, 8, muted);
      });
      x += column.width;
    });
    y -= height;
  };

  const drawDataRow = (row: RosterTemplateRow, zebra: boolean) => {
    const cellLines = columns.map((column) => wrap(row[column.key], 8, column.width - cellPadX * 2));
    let offset = 0;
    const totalLines = Math.max(1, ...cellLines.map((lines) => lines.length));
    while (offset < totalLines) {
      const room = Math.max(1, Math.floor((y - marginY - 16) / lineHeight));
      if (room < 1 || y < marginY + 28) {
        startPage(true);
        drawColumnHeader();
      }
      const available = Math.max(1, Math.floor((y - marginY - 16) / lineHeight));
      const shown = Math.min(totalLines - offset, available);
      const height = shown * lineHeight + cellPadY * 2;
      if (zebra) {
        page.drawRectangle({ x: marginX, y: y - height, width: tableWidth, height, color: pale });
      }
      let x = marginX;
      columns.forEach((column, index) => {
        const slice = cellLines[index].slice(offset, offset + shown);
        slice.forEach((text, lineIndex) => {
          const width = textWidth(text, 8);
          const textX = column.align === "center"
            ? x + Math.max(cellPadX, (column.width - width) / 2)
            : x + cellPadX;
          drawText(page, text, textX, y - cellPadY - 8 - lineIndex * lineHeight, 8, navy);
        });
        x += column.width;
      });
      page.drawLine({
        start: { x: marginX, y: y - height },
        end: { x: marginX + tableWidth, y: y - height },
        thickness: 0.4,
        color: line
      });
      y -= height;
      offset += shown;
    }
  };

  startPage(false);

  for (const station of [...input.stations].sort((left, right) => left.station_code.localeCompare(right.station_code))) {
    const stationRows = byStation.get(station.station_code) ?? [];
    const period = stationRows[0]?.PERIOD_START || input.fallbackPeriodStart;
    drawStationBanner(station.station_code, station.station_name || station.station_code, period);
    drawColumnHeader();
    stationRows.forEach((row, index) => drawDataRow(row, index % 2 === 1));
    y -= 10;
  }

  ensure(36);
  drawText(page, "Shift master", marginX, y - 10, 11, navy);
  y -= 18;
  for (const shift of input.shifts) {
    const shiftLines = wrap(
      `${shift.code}  ${clean(shift.name)}  ${String(shift.start_time).slice(0, 5)}-${String(shift.end_time).slice(0, 5)}`,
      8,
      contentWidth
    );
    for (const text of shiftLines) {
      ensure(12);
      drawText(page, text, marginX, y - 8, 8, muted);
      y -= 11;
    }
  }

  return Buffer.from(await doc.save());
}
