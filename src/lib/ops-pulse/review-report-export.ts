// fontkit's Indic shaping state machine uses this runtime in its CJS build.
import "regenerator-runtime/runtime";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { reportIst, type ReviewReport, type ReportRow } from "./review-report";

export async function reviewReportXlsx(report: ReviewReport) {
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: "Ops Pulse Review Summary", Subject: `${report.from} to ${report.to}`, Author: "DropX Ops Pulse", CreatedDate: new Date(report.generatedAt) };
  const sheets = [{ name: "Read me", columns: ["Topic", "Detail"], rows: [
    { Topic: "Performance dates", Detail: `${report.from} to ${report.to}` },
    { Topic: "Generated", Detail: reportIst(report.generatedAt) },
    { Topic: "Selected locations", Detail: String(report.stationCount) },
    ...report.notes.map((Detail, i) => ({ Topic: `Note ${i + 1}`, Detail }))
  ] }, ...report.tables];
  for (const table of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet([table.columns, ...table.rows.map(row => table.columns.map(c => (row as ReportRow)[c] ?? null))]);
    sheet["!cols"] = table.columns.map(c => ({ wch: /reason|action|note|takeaway|coverage|Detail|Issue|Title|Feedback/i.test(c) ? 58 : /IST|name|reviewer|Metric/i.test(c) ? 27 : 20 }));
    sheet["!rows"] = [{ hpt: 30 }, ...table.rows.map(row => ({ hpt: Math.min(180, Math.max(30, ...table.columns.map(c => Math.ceil(String((row as ReportRow)[c] ?? "").length / 48) * 15 + 10))) }))];
    sheet["!autofilter"] = { ref: sheet["!ref"]! };
    // Values remain strings/numbers, never executable formulas or links.
    for (const address of Object.keys(sheet).filter(k => !k.startsWith("!"))) {
      const cell = sheet[address];
      const column = table.columns[XLSX.utils.decode_cell(address).c];
      if (cell.t === "n") cell.z = table.name === "Performance scorecard" && ["Actual", "Target"].includes(column) ? '0.0%' : /INR/.test(column) ? '#,##0.00;[Red](#,##0.00);0.00' : '#,##0.##;[Red](#,##0.##);0';
    }
    XLSX.utils.book_append_sheet(workbook, sheet, table.name);
  }
  const zip = await JSZip.loadAsync(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
  // SheetJS CE preserves cell data; add simple OOXML presentation consistently.
  const stylesFile = zip.file("xl/styles.xml")!;
  let styles = await stylesFile.async("string");
  const fontCount = Number(styles.match(/<fonts count="(\d+)"/)?.[1] ?? 1), fillCount = Number(styles.match(/<fills count="(\d+)"/)?.[1] ?? 2);
  styles = styles.replace(/<fonts count="\d+"/, `<fonts count="${fontCount + 1}"`).replace("</fonts>", '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>');
  styles = styles.replace(/<fills count="\d+"/, `<fills count="${fillCount + 1}"`).replace("</fills>", '<fill><patternFill patternType="solid"><fgColor rgb="FF17324D"/><bgColor indexed="64"/></patternFill></fill></fills>');
  const xfCount = Number(styles.match(/<cellXfs count="(\d+)"/)?.[1] ?? 1);
  styles = styles.replace(/<cellXfs count="\d+"/, `<cellXfs count="${xfCount + 2}"`).replace("</cellXfs>", `<xf numFmtId="0" fontId="${fontCount}" fillId="${fillCount}" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>`);
  zip.file("xl/styles.xml", styles);
  for (let i = 1; i <= sheets.length; i++) {
    const name = `xl/worksheets/sheet${i}.xml`, file = zip.file(name)!;
    let xml = await file.async("string");
    xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, '<sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>');
    xml = xml.replace(/<c\b([^>]*?)>/g, (tag, attrs: string) => {
      if (/\br="[A-Z]+1"/.test(attrs)) return `<c${attrs.replace(/\s+s="[^"]*"/, "")} s="${xfCount}">`;
      if (/\bt="(str|s|inlineStr)"/.test(attrs)) return `<c${attrs.replace(/\s+s="[^"]*"/, "")} s="${xfCount + 1}">`;
      return tag;
    });
    zip.file(name, xml);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const scriptFont = (s: string) => /[\u0D00-\u0D7F]/.test(s) ? "NotoSansMalayalam" : /[\u0C00-\u0C7F]/.test(s) ? "NotoSansTelugu" : /[\u0900-\u097F]/.test(s) ? "NotoSansDevanagari" : /[\u0B80-\u0BFF]/.test(s) ? "NotoSansTamil" : /[\u0C80-\u0CFF]/.test(s) ? "NotoSansKannada" : "NotoSans";
export async function reviewReportPdf(report: ReviewReport) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Ops Pulse Review Summary · ${report.from} to ${report.to}`);
  doc.setAuthor("DropX Ops Pulse");
  const contents = JSON.stringify(report), names = new Set(["NotoSans"]);
  for (const character of contents) names.add(scriptFont(character));
  const fonts = new Map<string, PDFFont>();
  for (const name of names) fonts.set(name, await doc.embedFont(await readFile(path.join(process.cwd(), "assets/report-fonts", `${name}-Regular.ttf`)), { subset: true }));
  const baseFont = fonts.get("NotoSans")!, color = rgb(.10, .18, .27), muted = rgb(.38, .44, .50), accent = rgb(.92, .30, .10);
  const supported = new Map([...fonts.values()].map(font => [font, new Set(font.getCharacterSet())]));
  let page: PDFPage, y = 0, section = "Overview";
  const runs = (text: string) => {
    const result: { text: string; font: PDFFont }[] = [];
    for (const ch of text.replace(/\r/g, "").replace(/[\u0000-\u0008\u000B-\u001F]/g, "")) {
      const font = fonts.get(scriptFont(ch)) || baseFont;
      // Do not silently drop an unsupported character or substitute a false name.
      if (!supported.get(font)!.has(ch.codePointAt(0)!) && ch !== "\n") throw Error("This PDF contains a character not supported by the report fonts. Download Excel to preserve the complete text.");
      const last = result.at(-1);
      if (last?.font === font) last.text += ch; else result.push({ text: ch, font });
    }
    return result;
  };
  const width = (s: string, size: number) => runs(s).reduce((n, r) => n + r.font.widthOfTextAtSize(r.text, size), 0);
  const draw = (s: string, x: number, at: number, size = 9, ink = color) => { for (const r of runs(s)) { page.drawText(r.text, { x, y: at, size, font: r.font, color: ink }); x += r.font.widthOfTextAtSize(r.text, size); } };
  const newPage = () => {
    if (doc.getPageCount() >= 1800) throw Error("PDF exceeds 1,800 pages. Download Excel or select a shorter range.");
    page = doc.addPage([595.28, 841.89]); y = 779;
    draw("DROPX / OPS PULSE", 36, 809, 10, accent);
    draw(section, 36, 790, 9, muted);
    page.drawLine({ start: { x: 36, y: 781 }, end: { x: 559, y: 781 }, thickness: .5, color: rgb(.84, .88, .92) });
    y = 760;
  };
  const wrap = (s: string, max: number, size = 9) => {
    const lines: string[] = [];
    for (const paragraph of s.split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        if (line && width(`${line} ${word}`, size) > max) { lines.push(line); line = ""; }
        if (width(word, size) > max) {
          for (const ch of word) { if (width(line + ch, size) > max) { lines.push(line); line = ""; } line += ch; }
        } else line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
    }
    return lines;
  };
  const paragraph = (s: string, size = 9, ink = color, x = 36, max = 523) => {
    for (const line of wrap(s, max, size)) { if (y < 55) newPage(); draw(line, x, y, size, ink); y -= size * 1.45; }
    y -= 5;
  };
  const heading = (s: string) => { if (y < 105) newPage(); y -= 7; paragraph(s, 12, accent); };
  const fields = (row: ReportRow, columns: string[]) => {
    for (const label of columns) {
      if (y < 64) newPage();
      const lines = wrap(String(row[label] ?? "Not recorded"), 340);
      draw(label, 36, y, 8, muted);
      for (const line of lines) { if (y < 55) { newPage(); draw(`${label} (continued)`, 36, y, 8, muted); } draw(line, 219, y); y -= 13; }
      y -= 3;
    }
    y -= 6;
  };
  newPage();
  paragraph("Review Summary", 25);
  paragraph(`${report.from} to ${report.to} · ${report.stationCount} locations`, 12);
  paragraph(`Generated ${reportIst(report.generatedAt)}`, 9, muted);
  const summaries = report.tables[0].rows;
  paragraph(`${summaries.length} station-days · ${summaries.filter(r => r["Review status"] === "Completed").length} completed · ${summaries.filter(r => r["Review status"] === "In progress").length} in progress · ${summaries.filter(r => r["Review status"] === "Not started").length} not started`, 11);
  heading("Reading this report");
  report.notes.forEach(note => paragraph(note));
  heading("Station-day index");
  summaries.forEach(row => paragraph(`${row.Date}  |  ${row.Station}  |  ${row["Review status"]}  |  ${row["Performance misses"] ?? "Unknown"} performance misses  |  ${row["Open actions"]} open actions`, 8));
  const indexed = report.tables.slice(1).map(table => {
    const rows = new Map<string, ReportRow[]>();
    table.rows.forEach(row => { const key = `${row.Date}|${row.Station}`; rows.set(key, [...(rows.get(key) ?? []), row]); });
    return { table, rows };
  });
  for (const summary of summaries) {
    section = `${summary.Station} · ${summary.Date}`; newPage();
    paragraph(`${summary.Station} · ${summary["Station name"]}`, 18);
    paragraph(`${summary.Date} · ${summary["Review status"]}`, 11, muted);
    fields(summary, report.tables[0].columns.filter(c => !["Date", "Station", "Station name"].includes(c)));
    for (const { table, rows } of indexed) {
      const selected = rows.get(`${summary.Date}|${summary.Station}`) ?? [];
      if (!selected.length) continue;
      heading(`${table.name} · ${selected.length}`);
      if (table.name === "Performance scorecard") {
        selected.forEach(row => paragraph(`${row.Metric}  |  ${row.Actual == null ? "Not recorded" : `${(Number(row.Actual) * 100).toFixed(1)}%`}  |  Target ${row.Target == null ? "Reference" : `${(Number(row.Target) * 100).toFixed(1)}%`}  |  ${row.Result}`, 8));
        paragraph(`Source uploaded: ${selected[0]["Source uploaded IST"]}`, 8, muted);
      } else if (table.name === "EDD checkpoints") {
        paragraph("Time | Day start | Pending | On road | Delivered | HFR | Attempted | Unchecked | Other", 8, muted);
        selected.forEach(row => {
          const keys = ["Checkpoint IST", "Day start EDD", "At station pending", "On road", "Delivered", "HFR", "Attempted", "Unverified", "Other"];
          paragraph(keys.map(k => row[k] ?? "—").join(" | ") + ` · ${row.Coverage} · ${row["Observed IST"] || "No observation"}`, 8);
        });
      } else selected.forEach(row => fields(row, table.columns.filter(c => c !== "Date" && c !== "Station")));
    }
  }
  const total = doc.getPageCount();
  doc.getPages().forEach((p, i) => {
    p.drawText(`${report.from} to ${report.to} / IST`, { x: 36, y: 28, font: baseFont, size: 8, color: muted });
    p.drawText(`${i + 1} / ${total}`, { x: 498, y: 28, font: baseFont, size: 8, color: muted });
  });
  return doc.save();
}
