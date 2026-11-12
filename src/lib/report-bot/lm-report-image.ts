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

/** Stable report identities; red/amber/green still retain their status meaning. */
export function reportPalette(title:string) {
  if(/c-return|pickup status/i.test(title))return {header:'#115e59',soft:'#ccfbf1',stripe:'#f0fdfa'};
  if(/ageing|aging|shortfall|shortage/i.test(title))return {header:'#92400e',soft:'#fef3c7',stripe:'#fffbeb'};
  if(/scrub/i.test(title))return {header:'#6b21a8',soft:'#f3e8ff',stripe:'#faf5ff'};
  if(/cod|recon|deposit|remittance|cash|cms/i.test(title))return {header:'#7c2d12',soft:'#ffedd5',stripe:'#fff7ed'};
  if(/dot/i.test(title))return {header:'#3730a3',soft:'#e0e7ff',stripe:'#eef2ff'};
  return {header:'#193456',soft:'#dce8f6',stripe:'#f6f8fb'};
}

/** Count colours describe status; intensity reflects its share of the row total. */
export function reportMetricStyle(column: string, value: string | number, total: number): CellStyle {
  if (value === "—" || value === "") return null;
  if(column==='Status'){
    if(/held|at station/i.test(String(value)))return {background:'#fef3c7',color:'#92400e'};
    if(/attempted|check status/i.test(String(value)))return {background:'#fee2e2',color:'#991b1b'};
    if(/out on road/i.test(String(value)))return {background:'#ede9fe',color:'#5b21b6'};
  }
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return null;
  const share = total > 0 ? count / total : 0;
  if (/failed|rejected|cancelled|unpickupable/i.test(column)) return share >= .2
    ? {background:"#fecaca",color:"#7f1d1d"} : share >= .05
    ? {background:"#ffedd5",color:"#9a3412"} : {background:"#fff7ed",color:"#9a3412"};
  if (/^at station$|^EDD at station$|delayed|^other$/i.test(column)) return share >= .2
    ? {background:"#fde68a",color:"#78350f"} : {background:"#fef3c7",color:"#92400e"};
  if (/delivered|picked up|pickup done/i.test(column)) return share >= .8
    ? {background:"#bbf7d0",color:"#14532d"} : {background:"#ecfdf5",color:"#166534"};
  if (/on road/i.test(column)) return {background:"#ede9fe",color:"#5b21b6"};
  if (/assigned|scheduled|verified total|physical at station/i.test(column)) return {background:"#eff6ff",color:"#1e40af"};
  return null;
}

export async function summaryReportSvg(title: string, rows: [string, string | number][], rowStyle?: (label: string, value: string | number) => CellStyle) {
  const available = await fonts();
  const text = (value: string | number, options: TextOptions) => outlinedText(available, value, options);
  const visible = rows.slice(0, 70);
  if (visible.length < rows.length) visible.push(["Additional stations", rows.length - visible.length]);
  const palette=reportPalette(title), width=620, valueWidth=210, labelWidth=width-valueWidth;
  return svg(width, 36 + visible.length * 28,
    rect(0, 0, width, 36, palette.header) + text(title, { x: 10, y: 24, size: 15, maxWidth: width-20, color: 'white', bold: true }) +
    visible.map(([label, value], index) => {
      const y = 36 + index * 28;
      const style = rowStyle?.(label, value) ?? null;
      return rect(0,y,labelWidth,28,index%2?palette.stripe:'#fff')+
        rect(labelWidth,y,valueWidth,28,style?.background||palette.soft)+
        text(label,{x:10,y:y+19,size:13,maxWidth:labelWidth-20})+
        text(value,{x:labelWidth+valueWidth/2,y:y+19,size:13,maxWidth:valueWidth-16,anchor:'middle',color:style?.color,bold:true});
    }).join(''));

}

export async function tableReportSvg(title: string, columns: string[], rows: Array<Array<string | number>>, percentageColumn: string | readonly string[], percentageStyle: (value: string | number) => CellStyle, minimumWidth=0, compact=true) {
  if (!columns.length) throw new Error("Report image requires columns");
  const available = await fonts();
  const text = (value: string | number, options: TextOptions) => outlinedText(available, value, options);
  const columnWidth = Math.max(Math.floor(minimumWidth/columns.length),102, Math.min(158, Math.floor(1264 / columns.length)));
  const widths = columns.map((column,index)=>{
    if(!compact)return columnWidth;
    const values=rows.map(row=>String(row[index]??''));
    const content=Math.max(0,...values.map(value=>value.length));
    const label=Math.max(...column.split(/\s+/).map(word=>word.length));
    const isText=index===0||values.some(value=>/[a-z]/i.test(value)&&!/^[-+\d.,%₹ km~:–—/]+$/i.test(value));
    return Math.max(index===0?82:64,Math.min(isText?200:110,Math.max(label*6.3+16,content*(isText?6:7)+16)));
  });
  const naturalWidth=widths.reduce((n,w)=>n+w,0);
  if(compact&&minimumWidth>naturalWidth)widths.forEach((_,i)=>{widths[i]+=(minimumWidth-naturalWidth)/widths.length;});
  const left = widths.map((_,i)=>widths.slice(0,i).reduce((n,w)=>n+w,0));
  const width = widths.reduce((n,w)=>n+w,0);
  const palette=reportPalette(title);
  const rowHeight = 26, titleHeight = 34, headerHeight=compact?36:rowHeight;
  const headerLines=(label:string)=>{
    if(!compact)return [label];
    const special:Record<string,string[]>= {'EDD at station':['EDD at','station'],'Physical at station':['Physical at','station'],'Verified total':['Assigned'],'Delivery failed':['Delivery','failed'],'Pickup failed':['Pickup','failed'],'At station':/c[ -]?return/i.test(title)?['At station','unassigned']:['At station']};
    return special[label]|| (label.length>10&&label.includes(' ')?[label.slice(0,label.lastIndexOf(' ')),label.slice(label.lastIndexOf(' ')+1)]:[label]);
  };
  const percentageColumns: readonly string[] = typeof percentageColumn === "string" ? [percentageColumn] : percentageColumn;
  // Keep all configured stations and the actual total, never truncate a report.
  const header = columns.map((label,index)=>rect(left[index],titleHeight,widths[index],headerHeight,palette.soft)+
    headerLines(label).map((line,n,lines)=>text(line,{x:left[index]+(index?widths[index]/2:8),y:titleHeight+(lines.length===1?24:14+n*14),size:compact?12:13,maxWidth:widths[index]-12,anchor:index?"middle":"start",bold:true})).join('')).join('');
  const stockColumns = columns.map(column => /^(physical at station|EDD at station|at station)$/i.test(column));
  const stockMaxima = columns.map((_, index) => Math.max(0, ...rows.filter(row => !/^grand total$/i.test(String(row[0]))).map(row => Number(row[index]) || 0)));
  const body = rows.map((row, rowIndex) => {
    const total = /^grand total$/i.test(String(row[0]));
    return columns.map((column, columnIndex) => {
      const value = row[columnIndex] ?? "—";
      const y = titleHeight + headerHeight + rowHeight * rowIndex;
      const denominator = Number(row[columns.findIndex(c => ["Assigned", "Scheduled", "Verified total"].includes(c))]) || 0;
      const style = (!total || compact) && percentageColumns.includes(column) ? percentageStyle(value)
        : compact && !total ? reportMetricStyle(column, value, denominator) : null;
      return rect(left[columnIndex], y, widths[columnIndex], rowHeight, style?.background || (total ? palette.soft : rowIndex % 2 ? palette.stripe : "#fff")) +
        (compact && !total && stockColumns[columnIndex] && Number(value) > 0 && stockMaxima[columnIndex] > 0
          ? `<g data-stock-bar="true">${rect(left[columnIndex]+3, y+rowHeight-4, (widths[columnIndex]-6)*Number(value)/stockMaxima[columnIndex], 3, /physical/i.test(column) ? "#db2777" : "#d97706")}</g>` : "") +
        text(value, { x: left[columnIndex] + (columnIndex ? widths[columnIndex] / 2 : 10), y: y + 18, size: 13, maxWidth: widths[columnIndex] - 16, anchor: columnIndex ? "middle" : "start", color: style?.color, bold: total || !!style });
    }).join("");
  }).join("");
  const bottom = titleHeight + headerHeight + rowHeight * rows.length;
  const grid = compact ? `<g stroke="#d7e0ec" stroke-width="0.65">${[0,...left.slice(1),width-.5].map(x=>`<path d="M${x} ${titleHeight}V${bottom}"/>`).join('')}${Array.from({length:rows.length+1},(_,i)=>`<path d="M0 ${titleHeight+headerHeight+i*rowHeight}H${width}"/>`).join('')}</g>` : '';
  return svg(width, bottom, rect(0, 0, width, titleHeight, palette.header) +
    text(title, { x: 10, y: 23, size: 15, maxWidth: width - 24, color: "white", bold: true }) + header + body + grid);
}

export async function reportPngBase64(svgSource: string) {
  return (await sharp(Buffer.from(svgSource)).png().toBuffer()).toString("base64");
}

/** One data-only image; instructions and mentions belong to its WhatsApp caption. */
export async function codSectionsPng(title:string,sections:Array<{title:string;columns:string[];rows:Array<Array<string|number>>}>) {
  const drafts=await Promise.all(sections.map(section=>tableReportSvg(section.title,section.columns,section.rows,[],()=>null,0,true)));
  const width=Math.max(360,...drafts.map(draft=>Number(draft.match(/width="([\d.]+)"/)?.[1]||0)));
  const rendered=await Promise.all(sections.map(async (section,index)=>Buffer.from(await reportPngBase64(Number(drafts[index].match(/width="([\d.]+)"/)?.[1])===width?drafts[index]:await tableReportSvg(section.title,section.columns,section.rows,[],()=>null,width,true)),'base64')));
  const sizes=await Promise.all(rendered.map(input=>sharp(input).metadata()));
  const available=await fonts();
  const header=Buffer.from(await reportPngBase64(svg(width,34,rect(0,0,width,34,reportPalette(title).header)+outlinedText(available,title,{x:10,y:23,size:15,maxWidth:width-20,color:'white',bold:true}))),'base64');
  let top=34;
  const composites=[{input:header,left:0,top:0}];
  rendered.forEach((input,index)=>{composites.push({input,left:0,top});top+=sizes[index].height!+3;});
  return (await sharp({create:{width,height:top,channels:4,background:'#ffffff'}}).composite(composites).png().toBuffer()).toString('base64');
}
