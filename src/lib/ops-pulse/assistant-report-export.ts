import "regenerator-runtime/runtime";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import sharp from "sharp";
import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit, { type Font } from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantReport } from "./assistant-report-token";
export const assistantReportFormats = ["pdf", "docx", "xlsx", "png"] as const;
const xml = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]!));
function paragraphs(report: AssistantReport) { return ["OpsPulse insight report", report.question, `Source check: ${report.checkedAt}`, ...report.answer.split("\n"), "Sources", ...report.reads.map(read=>`${read.name.replaceAll("_"," ")}${read.error ? ": " + read.error : ""}`)]; }
function flatten(value: unknown, prefix = "", rows: { Field: string; Value: string | number | boolean }[] = []) {
  if (Array.isArray(value)) value.forEach((child,index)=>flatten(child,`${prefix}[${index+1}]`,rows));
  else if (value !== null && typeof value === "object") Object.entries(value).forEach(([key,child])=>flatten(child,prefix?`${prefix}.${key}`:key,rows));
  else rows.push({Field:prefix, Value:value==null?"Not recorded":typeof value==="number"||typeof value==="boolean"?value:String(value)});
  return rows;
}
const scriptFont = (s: string) => /[\u0D00-\u0D7F]/.test(s)?"NotoSansMalayalam":/[\u0C00-\u0C7F]/.test(s)?"NotoSansTelugu":/[\u0900-\u097F]/.test(s)?"NotoSansDevanagari":/[\u0B80-\u0BFF]/.test(s)?"NotoSansTamil":/[\u0C80-\u0CFF]/.test(s)?"NotoSansKannada":"NotoSans";
/** Outline bundled fonts: serverless images must not depend on installed system fonts. */
export async function assistantReportImageSvg(lines: string[]) {
 const fonts=new Map<string,Font>();
 for(const name of new Set(["NotoSans",...Array.from(lines.join(" ")).map(scriptFont)]))fonts.set(name,fontkit.create(await readFile(path.join(process.cwd(),"assets/report-fonts",`${name}-Regular.ttf`))));
 const wrapped=lines.flatMap(line=>{const words=line.split(/\s+/).flatMap(word=>Array.from(word.matchAll(/.{1,70}/gu),m=>m[0])),out:string[]=[];let current="";for(const word of words){if(current.length+word.length>78){out.push(current);current="";}current+=(current?" ":"")+word;}out.push(current);return out;});
 if(wrapped.length>180)throw Error("This answer is too long for one image. Download PDF, Word or Excel.");
 const height=Math.max(400,150+wrapped.length*28);
 const outlines=wrapped.map((line,index)=>{
  const runs:{text:string;font:Font}[]=[];
  for(const char of line){const font=fonts.get(scriptFont(char))!;if(!font.hasGlyphForCodePoint(char.codePointAt(0)!))throw Error("A character is unsupported by the image fonts. Download Word or Excel to preserve it.");const last=runs.at(-1);if(last?.font===font)last.text+=char;else runs.push({text:char,font});}
  const shaped=runs.map(r=>({font:r.font,run:r.font.layout(r.text)}));
  const size=index===0?28:20,total=shaped.reduce((sum,r)=>sum+r.run.positions.reduce((n,p)=>n+p.xAdvance,0)/r.font.unitsPerEm*size,0),fit=total>1070?1070/total:1;
  let x=65;const paths:string[]=[];
  for(const {font,run} of shaped){const scale=size*fit/font.unitsPerEm;for(let n=0;n<run.glyphs.length;n++){const glyph=run.glyphs[n],position=run.positions[n],d=glyph.path.toSVG();if(d)paths.push(`<path d="${xml(d)}" transform="translate(${x+position.xOffset*scale} ${90+index*28-position.yOffset*scale}) scale(${scale} ${-scale})"/>`);x+=position.xAdvance*scale;}}
  return `<g fill="${index===0?'#e65124':'#1a293a'}">${paths.join('')}</g>`;
 }).join('');
 return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}"><rect width="1200" height="${height}" fill="#f3f6fa"/><rect x="24" y="24" width="1152" height="${height-48}" rx="24" fill="white"/><rect x="24" y="24" width="1152" height="10" fill="#e65124"/>${outlines}</svg>`;
}
export async function exportAssistantReport(report: AssistantReport, format: typeof assistantReportFormats[number]) {
  const lines=paragraphs(report);
  if (format==="xlsx") {
    const book=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(lines.map(line=>[line])),"Insight");
    for (const [index,read] of report.reads.entries()) { const sheet=XLSX.utils.json_to_sheet(flatten(read.data ?? {error:read.error})); sheet['!cols']=[{wch:48},{wch:90}]; XLSX.utils.book_append_sheet(book,sheet,`Source ${index+1}`); }
    return {bytes:XLSX.write(book,{bookType:"xlsx",type:"buffer"}) as Buffer,mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"};
  }
  if (format==="docx") {
    const zip=new JSZip();
    zip.file("[Content_Types].xml",'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels",'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file("word/document.xml",`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map((line,index)=>`<w:p><w:pPr><w:spacing w:after="140"/></w:pPr><w:r><w:rPr>${index===0?'<w:b/><w:color w:val="E65124"/><w:sz w:val="36"/>':'<w:sz w:val="22"/>'}</w:rPr><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`).join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr></w:body></w:document>`);
    return {bytes:await zip.generateAsync({type:"nodebuffer"}),mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"};
  }
  if(format==="png") {
    const svg=await assistantReportImageSvg(lines);
    return {bytes:await sharp(Buffer.from(svg)).png().toBuffer(),mime:"image/png"};
  }
  const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit);pdf.setTitle(report.question);pdf.setAuthor("OpsPulse");
  const names=new Set(["NotoSans",...Array.from(lines.join(" ")).map(scriptFont)]),fonts=new Map<string,PDFFont>();
  for(const name of names) fonts.set(name,await pdf.embedFont(await readFile(path.join(process.cwd(),"assets/report-fonts",`${name}-Regular.ttf`)),{subset:true}));
  const characterSets=new Map([...fonts.values()].map(font=>[font,new Set(font.getCharacterSet())]));
  let page=pdf.addPage([595,842]),y=790;
  const runs=(text:string)=>{const result:{text:string;font:PDFFont}[]=[];for(const char of text){const font=fonts.get(scriptFont(char))!;if(!characterSets.get(font)!.has(char.codePointAt(0)!))throw Error("A character is unsupported by the PDF fonts. Download Word or Excel to preserve it.");const last=result.at(-1);if(last?.font===font)last.text+=char;else result.push({text:char,font});}return result;};
  const width=(text:string)=>runs(text).reduce((n,r)=>n+r.font.widthOfTextAtSize(r.text,11),0);
  const draw=(line:string)=>{if(y<55){page=pdf.addPage([595,842]);y=790;}let x=40;for(const run of runs(line)){page.drawText(run.text,{x,y,size:11,font:run.font,color:rgb(.1,.16,.23)});x+=run.font.widthOfTextAtSize(run.text,11);}y-=17;};
  for(const paragraph of lines){let line="";for(const char of paragraph.replace(/[\r\u0000-\u001F]/g," ")){if(width(line+char)>515){draw(line);line="";}line+=char;}draw(line);y-=7;}
  return {bytes:Buffer.from(await pdf.save()),mime:"application/pdf"};
}
