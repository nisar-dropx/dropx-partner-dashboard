import type { ReportPack } from "./checklist-report-pack";
import { checklistSummary } from "./checklist-summary";

/** Render paginated, readable images; never shrink a long checklist to one tiny image. */
export async function buildChecklistSummary(pack: ReportPack) {
  const data = checklistSummary(pack);
  await document.fonts.ready;
  const width = 1200, height = 1696, margin = 52, bottom = height - 70;
  const canvases: HTMLCanvasElement[] = [];
  let canvas!: HTMLCanvasElement, ctx!: CanvasRenderingContext2D;
  let y = 0;
  const font = (bold = false, size = 22) => { ctx.font = `${bold ? 700 : 400} ${size}px Arial, sans-serif`; };
  const wrap = (text: string, max: number) => {
    const lines: string[] = []; let line = "";
    for (const word of String(text).split(/\s+/)) {
      // Split unbroken URLs/identifiers too, without discarding any text.
      for (const piece of word.match(/.{1,50}/gu) || [""]) {
        const next = line ? `${line} ${piece}` : piece;
        if (ctx.measureText(next).width > max && line) { lines.push(line); line = piece; } else line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  };
  const page = () => {
    canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d"); if (!context) throw Error("Image export is unavailable in this browser."); ctx = context;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#172033"; ctx.fillRect(0, 0, width, 100);
    ctx.fillStyle = "#ff7845"; font(true, 21); ctx.fillText("OpsPulse · AMAZON NOW", margin, 42);
    ctx.fillStyle = "#fff"; font(true, 28); ctx.fillText(data.title, margin, 80);
    y = 134; canvases.push(canvas);
  };
  const text = (value: string, bold = false, color = "#263449", size = 22) => {
    font(bold, size);
    const lines = wrap(value, width - margin * 2);
    for (const line of lines) {
      if (y + size + 9 > bottom) { page(); font(bold, size); }
      ctx.fillStyle = color; ctx.fillText(line, margin, y); y += size + 9;
    }
  };
  page();
  text(data.subtitle, true); text(data.owner); text(data.status, true, "#bb4718");
  text(data.submitted, false, "#586579", 19);
  if (data.handover) text(data.handover, false, "#586579", 19);
  y += 12;
  for (const section of data.sections) {
    if (y + 100 > bottom) page();
    ctx.fillStyle = "#f2f4f8"; ctx.fillRect(margin - 10, y - 24, width - margin * 2 + 20, 40);
    text(section.name, true, "#172033", 23); y += 5;
    for (const row of section.rows) {
      if (y + 85 > bottom) page();
      text(`${row.label} · ${row.status}`, true, row.status === "Not recorded" || row.status === "Needs attention" ? "#b42332" : "#263449", 21);
      text(row.detail, false, "#586579", 20);
      if (row.proofs) text(`${row.proofs} evidence file${row.proofs === 1 ? "" : "s"} in OpsPulse`, false, "#586579", 18);
      y += 12;
    }
  }
  if (data.notes) { text("Handover notes", true); text(data.notes); }
  const images: File[] = [];
  for (let i = 0; i < canvases.length; i++) {
    const c = canvases[i], context = c.getContext("2d")!;
    context.fillStyle = "#64748b"; context.font = "18px Arial, sans-serif";
    context.fillText(`Saved system snapshot · ${i + 1}/${canvases.length} · Evidence remains in OpsPulse`, margin, height - 30);
    const blob = await new Promise<Blob | null>(resolve => c.toBlob(resolve, "image/png"));
    if (!blob) throw Error("Could not create summary image.");
    images.push(new File([blob], `${data.filename}-${i + 1}.png`, {type:"image/png"}));
    c.width = 0; c.height = 0;
  }
  return { images, data };
}

export async function summaryPdf(images: File[], filename: string) {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  for (const file of images) {
    const image = await pdf.embedPng(await file.arrayBuffer());
    pdf.addPage([595.28, 841.89]).drawImage(image, {x:0,y:0,width:595.28,height:841.89});
  }
  return new File([await pdf.save() as Uint8Array<ArrayBuffer>], filename + ".pdf", {type:"application/pdf"});
}
export function downloadSummary(file: File) {
  const url = URL.createObjectURL(file), a = document.createElement("a");
  a.href = url; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
