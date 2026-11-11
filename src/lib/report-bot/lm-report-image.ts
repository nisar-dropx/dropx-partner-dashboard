import "regenerator-runtime/runtime.js";
import fontkit, { type Font } from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const fontNames = ["NotoSans", "NotoSansMalayalam", "NotoSansTelugu", "NotoSansDevanagari", "NotoSansTamil", "NotoSansKannada"];
let fontsPromise: Promise<Font[]> | undefined;
function fonts() {
  return fontsPromise ??= Promise.all(fontNames.map(async name => fontkit.create(
    await readFile(path.join(process.cwd(), "assets/report-fonts", `${name}-Regular.ttf`)),
  )));
}
const escapeXml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!));
type TextOptions = { x: number; y: number; size: number; maxWidth: number; anchor?: "start" | "middle" | "end"; color?: string; bold?: boolean };

// Outline bundled glyphs before rasterization. SVG <text> depends on system
// fonts, which are absent in the cron's serverless runtime (producing tofu).
function outlinedText(available: Font[], value: string | number, options: TextOptions) {
  const runs: Array<{ font: Font; text: string }> = [];
  for (const char of String(value).replace(/[\r\n\t]/g, " ")) {
    const cp = char.codePointAt(0)!;
    const font = available.find(candidate => candidate.hasGlyphForCodePoint(cp));
    if (!font) throw new Error(`Report image font does not support U+${cp.toString(16).toUpperCase()}`);
    const previous = runs.at(-1);
    if (previous?.font === font) previous.text += char;
    else runs.push({ font, text: char });
  }
  const shaped = runs.map(run => ({ font: run.font, layout: run.font.layout(run.text) }));
  const measured = shaped.reduce((sum, run) => sum + run.layout.positions.reduce((n, p) => n + p.xAdvance, 0) / run.font.unitsPerEm * options.size, 0);
  const fit = measured > options.maxWidth ? options.maxWidth / measured : 1;
  let x = options.x - (options.anchor === "end" ? measured * fit : options.anchor === "middle" ? measured * fit / 2 : 0);
  const paths: string[] = [];
  for (const run of shaped) {
    const scale = options.size * fit / run.font.unitsPerEm;
    run.layout.glyphs.forEach((glyph, index) => {
      const position = run.layout.positions[index];
      const d = glyph.path.toSVG();
      if (d) paths.push(`<path d="${escapeXml(d)}" transform="translate(${x + position.xOffset * scale} ${options.y - position.yOffset * scale}) scale(${scale} ${-scale})"/>`);
      x += position.xAdvance * scale;
    });
  }
  const color = escapeXml(options.color ?? "#172033");
  return `<g fill="${color}"${options.bold ? ` stroke="${color}" stroke-width="0.3" stroke-linejoin="round"` : ""}>${paths.join("")}</g>`;
}
const rect = (x: number, y: number, width: number, height: number, fill: string) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escapeXml(fill)}"/>`;
const svg = (width: number, height: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`;
export type CellStyle = { background: string; color: string } | null;

export async function summaryReportSvg(title: string, rows: [string, string | number][], rowStyle?: (label: string, value: string | number) => CellStyle) {
  const available = await fonts();
  const text = (value: string | number, options: TextOptions) => outlinedText(available, value, options);
  const visible = rows.slice(0, 70);
  if (visible.length < rows.length) visible.push(["Additional stations", rows.length - visible.length]);
  return svg(900, 50 + visible.length * 34,
    rect(0, 0, 900, 50, "#193456") + text(title, { x: 18, y: 32, size: 18, maxWidth: 864, color: "white", bold: true }) +
    visible.map(([label, value], index) => {
      const y = 50 + index * 34;
      const style = rowStyle?.(label, value) ?? null;
      return rect(0, y, 690, 34, index % 2 ? "#f2f5f9" : "#fff") +
        rect(690, y, 210, 34, style?.background || (index % 2 ? "#e7edf5" : "#eef3f8")) +
        text(label, { x: 18, y: y + 23, size: 18, maxWidth: 650 }) +
        text(value, { x: 875, y: y + 23, size: 18, maxWidth: 170, anchor: "end", color: style?.color, bold: true });
    }).join(""));
}

export async function tableReportSvg(title: string, columns: string[], rows: Array<Array<string | number>>, percentageColumn: string | readonly string[], percentageStyle: (value: string | number) => CellStyle, minimumWidth=0) {
  if (!columns.length) throw new Error("Report image requires columns");
  const available = await fonts();
  const text = (value: string | number, options: TextOptions) => outlinedText(available, value, options);
  const columnWidth = Math.max(Math.floor(minimumWidth/columns.length),102, Math.min(158, Math.floor(1264 / columns.length)));
  const width = columns.length * columnWidth;
  const rowHeight = 29, titleHeight = 45;
  const percentageColumns: readonly string[] = typeof percentageColumn === "string" ? [percentageColumn] : percentageColumn;
  // Keep all configured stations and the actual total, never truncate a report.
  const header = columns.map((label, index) => rect(index * columnWidth, titleHeight, columnWidth, rowHeight, "#dce8f6") +
    text(label, { x: index * columnWidth + (index ? columnWidth / 2 : 8), y: titleHeight + 20, size: 13, maxWidth: columnWidth - 16, anchor: index ? "middle" : "start", bold: true })).join("");
  const body = rows.map((row, rowIndex) => {
    const total = /^grand total$/i.test(String(row[0]));
    return columns.map((column, columnIndex) => {
      const value = row[columnIndex] ?? "—";
      const y = titleHeight + rowHeight * (rowIndex + 1);
      const style = !total && percentageColumns.includes(column) ? percentageStyle(value) : null;
      return rect(columnIndex * columnWidth, y, columnWidth, rowHeight, style?.background || (total ? "#e8eef6" : rowIndex % 2 ? "#f6f8fb" : "#fff")) +
        text(value, { x: columnIndex * columnWidth + (columnIndex ? columnWidth / 2 : 10), y: y + 20, size: 13, maxWidth: columnWidth - 20, anchor: columnIndex ? "middle" : "start", color: style?.color, bold: total || !!style });
    }).join("");
  }).join("");
  return svg(width, titleHeight + rowHeight * (rows.length + 1), rect(0, 0, width, titleHeight, "#193456") +
    text(title, { x: 12, y: 29, size: 17, maxWidth: width - 24, color: "white", bold: true }) + header + body);
}

export async function reportPngBase64(svgSource: string) {
  return (await sharp(Buffer.from(svgSource)).png().toBuffer()).toString("base64");
}

/** One data-only image; instructions and mentions belong to its WhatsApp caption. */
export async function codSectionsPng(title:string,sections:Array<{title:string;columns:string[];rows:Array<Array<string|number>>}>) {
  const parts=await Promise.all(sections.map(async section=>Buffer.from(await reportPngBase64(await tableReportSvg(section.title,section.columns,section.rows,[],()=>null,1100)),'base64')));
  const width=1100;
  const header=Buffer.from(await reportPngBase64(await summaryReportSvg(title,[])),'base64');
  const inputs=[header,...parts];let top=0;
  const composites=[];
  for(const input of inputs){const resized=await sharp(input).resize({width}).png().toBuffer();const meta=await sharp(resized).metadata();composites.push({input:resized,left:0,top});top+=meta.height!+8;}
  return (await sharp({create:{width,height:top,channels:4,background:'#eef2f7'}}).composite(composites).png().toBuffer()).toString('base64');
}
