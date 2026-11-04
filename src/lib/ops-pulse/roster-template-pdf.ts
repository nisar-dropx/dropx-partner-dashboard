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

const navy = rgb(0.07, 0.12, 0.22);
const ink = rgb(0.12, 0.16, 0.22);
const muted = rgb(0.42, 0.47, 0.55);
const orange = rgb(0.9, 0.33, 0.16);
const pale = rgb(0.96, 0.97, 0.99);
const soft = rgb(0.93, 0.95, 0.98);
const white = rgb(1, 1, 1);
const line = rgb(0.84, 0.88, 0.93);
const weekOff = rgb(0.55, 0.35, 0.12);

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

/** Readable day cell for PDF (Excel keeps SHIFT codes for import). */
export function rosterPdfDayLabel(code: string, shiftByCode: Map<string, Pick<RosterTemplateShift, "start_time" | "end_time">>) {
  const value = clean(code);
  if (!value) return "—";
  if (value.toUpperCase() === "WO") return "WO";
  const shift = shiftByCode.get(value);
  if (!shift) return value;
  const start = String(shift.start_time ?? "").slice(0, 5);
  const end = String(shift.end_time ?? "").slice(0, 5);
  return start && end ? `${start}-${end}` : value;
}

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

  const shiftByCode = new Map(input.shifts.map((shift) => [shift.code, shift]));
  const displayRows = rows.map((row) => {
    const next = { ...row };
    for (const day of recurringRosterDays) {
      next[day] = rosterPdfDayLabel(row[day], shiftByCode);
    }
    return next;
  });

  const usedCodes = new Set<string>();
  for (const row of rows) {
    for (const day of recurringRosterDays) {
      const code = clean(row[day]);
      if (code && code.toUpperCase() !== "WO") usedCodes.add(code);
    }
  }
  const usedShifts = input.shifts
    .filter((shift) => usedCodes.has(shift.code))
    .sort((left, right) => String(left.start_time).localeCompare(String(right.start_time)) || left.code.localeCompare(right.code));

  const doc = await PDFDocument.create();
  doc.setTitle(`DropX station roster / ${input.today}`);
  doc.setAuthor("DropX / OpsPulse");
  doc.registerFontkit(fontkit);

  const sample = JSON.stringify([input.stations, displayRows.slice(0, 400), usedShifts]);
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
  const drawText = (page: PDFPage, value: string, x: number, baseline: number, size: number, color = ink) => {
    let cursor = x;
    for (const run of runs(value)) {
      page.drawText(run.text, { x: cursor, y: baseline, size, font: run.font, color });
      cursor += run.font.widthOfTextAtSize(run.text, size);
    }
    return cursor - x;
  };
  const wrap = (value: unknown, size: number, maxWidth: number) => {
    const text = clean(value);
    if (!text) return ["—"];
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
    if (line || !lines.length) lines.push(line || "—");
    return lines;
  };

  const pageWidth = 842;
  const pageHeight = 595;
  const marginX = 28;
  const marginY = 26;
  const contentWidth = pageWidth - marginX * 2;
  const dayWidth = 64;
  const idWidth = 64;
  const designationWidth = 88;
  const nameWidth = contentWidth - idWidth - designationWidth - dayWidth * recurringRosterDays.length;
  const columns: Column[] = [
    { key: "DROPX_ID", label: "DropX ID", width: idWidth },
    { key: "NAME", label: "Name", width: Math.max(120, nameWidth) },
    { key: "DESIGNATION", label: "Role", width: designationWidth },
    ...recurringRosterDays.map((day) => ({
      key: day as keyof RosterTemplateRow,
      label: day.slice(0, 3),
      width: dayWidth,
      align: "center" as const
    }))
  ];
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const lineHeight = 10;
  const cellPadY = 5;
  const cellPadX = 4;
  const dayKeys = new Set<string>(recurringRosterDays);

  const byStation = new Map<string, RosterTemplateRow[]>();
  for (const row of displayRows) {
    const list = byStation.get(row.LOCATION_CODE) ?? [];
    list.push(row);
    byStation.set(row.LOCATION_CODE, list);
  }

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - marginY;
  let pageNo = 1;

  const stampFooter = () => {
    page.drawLine({
      start: { x: marginX, y: marginY + 10 },
      end: { x: marginX + contentWidth, y: marginY + 10 },
      thickness: 0.5,
      color: line
    });
    drawText(page, "DropX OpsPulse · Approved recurring roster · Read-only print", marginX, marginY - 2, 7, muted);
    const label = `Page ${pageNo}`;
    drawText(page, label, marginX + contentWidth - textWidth(label, 7), marginY - 2, 7, muted);
  };

  const startPage = (continued = false) => {
    if (continued) {
      stampFooter();
      page = doc.addPage([pageWidth, pageHeight]);
      pageNo += 1;
    }
    y = pageHeight - marginY;
    page.drawRectangle({ x: 0, y: pageHeight - 8, width: pageWidth, height: 8, color: orange });
    page.drawRectangle({ x: 0, y: pageHeight - 42, width: pageWidth, height: 34, color: navy });
    drawText(page, continued ? "Station roster (continued)" : "Station roster", marginX, pageHeight - 28, continued ? 12 : 16, white);
    drawText(
      page,
      `${input.today} IST  ·  ${input.stations.length} station${input.stations.length === 1 ? "" : "s"}  ·  Mon-Sun approved pattern`,
      marginX + (continued ? 170 : 150),
      pageHeight - 28,
      8,
      rgb(0.78, 0.84, 0.92)
    );
    y = pageHeight - 54;
  };

  const ensure = (needed: number) => {
    if (y - needed < marginY + 22) {
      startPage(true);
      return true;
    }
    return false;
  };

  const drawStationBanner = (code: string, name: string, period: string, peopleCount: number) => {
    const title = `${code}  ·  ${name}`;
    const meta = `Template week from ${period}  ·  ${peopleCount} people`;
    const titleLines = wrap(title, 11, tableWidth - 20);
    const height = Math.max(30, titleLines.length * 13 + 18);
    ensure(height + 36);
    page.drawRectangle({ x: marginX, y: y - height, width: tableWidth, height, color: soft });
    page.drawRectangle({ x: marginX, y: y - height, width: 4, height, color: orange });
    titleLines.forEach((text, index) => drawText(page, text, marginX + 12, y - 14 - index * 13, 11, navy));
    drawText(page, meta, marginX + 12, y - height + 8, 8, muted);
    y -= height + 6;
  };

  const drawColumnHeader = () => {
    const headerLines = columns.map((column) => wrap(column.label, 8, column.width - cellPadX * 2));
    const height = Math.max(...headerLines.map((lines) => lines.length)) * lineHeight + cellPadY * 2;
    ensure(height + 10);
    page.drawRectangle({ x: marginX, y: y - height, width: tableWidth, height, color: navy });
    let x = marginX;
    columns.forEach((column, index) => {
      headerLines[index].forEach((text, lineIndex) => {
        const width = textWidth(text, 8);
        const textX = column.align === "center" ? x + (column.width - width) / 2 : x + cellPadX;
        drawText(page, text, textX, y - cellPadY - 8 - lineIndex * lineHeight, 8, white);
      });
      if (index > 0) {
        page.drawLine({
          start: { x, y },
          end: { x, y: y - height },
          thickness: 0.4,
          color: rgb(0.22, 0.3, 0.42)
        });
      }
      x += column.width;
    });
    y -= height;
  };

  const drawDataRow = (row: RosterTemplateRow, zebra: boolean) => {
    const cellLines = columns.map((column) => {
      const size = dayKeys.has(String(column.key)) ? 7.5 : 8;
      return wrap(row[column.key], size, column.width - cellPadX * 2).map((text) => ({ text, size }));
    });
    let offset = 0;
    const totalLines = Math.max(1, ...cellLines.map((lines) => lines.length));
    while (offset < totalLines) {
      if (y < marginY + 34) {
        startPage(true);
        drawColumnHeader();
      }
      const available = Math.max(1, Math.floor((y - marginY - 20) / lineHeight));
      const shown = Math.min(totalLines - offset, available);
      const height = shown * lineHeight + cellPadY * 2;
      if (zebra) page.drawRectangle({ x: marginX, y: y - height, width: tableWidth, height, color: pale });
      let x = marginX;
      columns.forEach((column, index) => {
        const slice = cellLines[index].slice(offset, offset + shown);
        slice.forEach((entry, lineIndex) => {
          const width = textWidth(entry.text, entry.size);
          const textX = column.align === "center"
            ? x + Math.max(cellPadX / 2, (column.width - width) / 2)
            : x + cellPadX;
          const color = entry.text === "WO" ? weekOff : ink;
          drawText(page, entry.text, textX, y - cellPadY - 8 - lineIndex * lineHeight, entry.size, color);
        });
        if (index > 0) {
          page.drawLine({
            start: { x, y },
            end: { x, y: y - height },
            thickness: 0.35,
            color: line
          });
        }
        x += column.width;
      });
      page.drawLine({
        start: { x: marginX, y: y - height },
        end: { x: marginX + tableWidth, y: y - height },
        thickness: 0.45,
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
    const peopleCount = stationRows.filter((row) => row.DROPX_ID).length;
    drawStationBanner(station.station_code, station.station_name || station.station_code, period, peopleCount);
    drawColumnHeader();
    stationRows.forEach((row, index) => drawDataRow(row, index % 2 === 1));
    y -= 12;
  }

  if (usedShifts.length) {
    ensure(28 + usedShifts.length * 11);
    drawText(page, "Shifts used on this roster", marginX, y - 10, 10, navy);
    y -= 16;
    for (const shift of usedShifts) {
      const label = `${String(shift.start_time).slice(0, 5)}-${String(shift.end_time).slice(0, 5)}   ${clean(shift.name) || shift.code}   (${shift.code})`;
      for (const text of wrap(label, 8, contentWidth)) {
        ensure(12);
        drawText(page, text, marginX, y - 8, 8, muted);
        y -= 11;
      }
    }
  } else {
    ensure(18);
    drawText(page, "No working shifts on this roster (weekly offs only, or empty station).", marginX, y - 10, 8, muted);
    y -= 14;
  }

  stampFooter();
  return Buffer.from(await doc.save());
}
