/**
 * Canvas PNG export for WhatsApp — dense spreadsheet-style boards matching
 * the Excel station-report pivots (EDD heatmap, C-Return, DA DSR).
 */

export type BoardShareCell = {
  text: string;
  bg?: string;
  bold?: boolean;
  align?: "left" | "right" | "center";
};

export type BoardShareTable = {
  title: string;
  subtitle: string;
  headers: string[];
  rows: BoardShareCell[][];
  footerNote?: string;
};

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > max && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function renderBoardShareImages(table: BoardShareTable): Promise<File[]> {
  await document.fonts.ready.catch(() => undefined);
  // Wider canvas when headers are full phrases (e.g. Delivery Failed / Out on Road).
  const longestHeader = Math.max(...table.headers.map((h) => String(h || "").length), 8);
  const width = Math.min(1800, Math.max(980, 140 + table.headers.length * Math.max(96, longestHeader * 7)));
  const margin = 28;
  const usable = width - margin * 2;
  const colCount = Math.max(1, table.headers.length);
  const firstCol = Math.min(200, Math.max(120, usable * 0.2));
  const other = (usable - firstCol) / Math.max(1, colCount - 1);
  const widths = table.headers.map((_, i) => (i === 0 ? firstCol : other));
  const maxPageHeight = 1800;
  const files: File[] = [];
  let pageIndex = 0;
  let rowIndex = 0;

  while (rowIndex <= table.rows.length) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = maxPageHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image export is unavailable in this browser.");
    let y = 0;
    const paintHeader = () => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, maxPageHeight);
      ctx.fillStyle = "#143447";
      ctx.fillRect(0, 0, width, 86);
      ctx.fillStyle = "#8de0d3";
      ctx.font = "700 15px Arial, sans-serif";
      ctx.fillText("Ops Pulse · Station board", margin, 32);
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 26px Arial, sans-serif";
      ctx.fillText(table.title, margin, 64);
      y = 104;
      ctx.fillStyle = "#486575";
      ctx.font = "400 14px Arial, sans-serif";
      for (const line of wrap(ctx, table.subtitle, usable)) {
        ctx.fillText(line, margin, y);
        y += 18;
      }
      y += 10;
      const headerLines = table.headers.map((h, i) => wrap(ctx, h, Math.max(24, widths[i]! - 12)));
      const headerH = Math.max(...headerLines.map((l) => l.length)) * 16 + 14;
      ctx.fillStyle = "#1f7a4d";
      ctx.fillRect(margin, y, usable, headerH);
      let x = margin;
      headerLines.forEach((lines, i) => {
        lines.forEach((line, j) => {
          ctx.fillStyle = "#ffffff";
          ctx.font = "700 13px Arial, sans-serif";
          const tw = ctx.measureText(line).width;
          const align = i === 0 ? "left" : "right";
          const tx = align === "left" ? x + 8 : x + widths[i]! - 8 - tw;
          ctx.fillText(line, tx, y + 20 + j * 16);
        });
        x += widths[i]!;
      });
      y += headerH;
    };

    paintHeader();
    let drewBody = false;
    while (rowIndex < table.rows.length) {
      const row = table.rows[rowIndex]!;
      const cellLines = row.map((cell, i) => wrap(ctx, cell.text, Math.max(20, widths[i]! - 12)));
      const h = Math.max(...cellLines.map((l) => l.length), 1) * 17 + 12;
      if (drewBody && y + h + 48 > maxPageHeight) break;
      const isTotal = /grand total|pickup done/i.test(row[0]?.text ?? "");
      ctx.fillStyle = isTotal ? "#fff4bf" : rowIndex % 2 ? "#f4f8fa" : "#ffffff";
      ctx.fillRect(margin, y, usable, h);
      ctx.fillStyle = "#d7e2e8";
      ctx.fillRect(margin, y + h - 1, usable, 1);
      let x = margin;
      cellLines.forEach((lines, i) => {
        const cell = row[i];
        if (cell?.bg && cell.bg !== "transparent") {
          ctx.fillStyle = cell.bg;
          ctx.fillRect(x + 1, y + 1, widths[i]! - 2, h - 2);
        }
        lines.forEach((line, j) => {
          ctx.fillStyle = "#223642";
          ctx.font = `${cell?.bold || isTotal || i === 0 ? 700 : 400} 13px Arial, sans-serif`;
          const align = cell?.align ?? (i === 0 ? "left" : "right");
          const tw = ctx.measureText(line).width;
          const tx = align === "left" ? x + 8 : align === "center" ? x + (widths[i]! - tw) / 2 : x + widths[i]! - 8 - tw;
          ctx.fillText(line, tx, y + 20 + j * 17);
        });
        x += widths[i]!;
      });
      y += h;
      rowIndex += 1;
      drewBody = true;
      if (y + 60 > maxPageHeight) break;
    }

    if (table.footerNote) {
      ctx.fillStyle = "#647583";
      ctx.font = "400 12px Arial, sans-serif";
      ctx.fillText(table.footerNote, margin, y + 22);
      y += 36;
    } else y += 24;

    const height = Math.min(maxPageHeight, Math.max(220, y + 16));
    const cropped = document.createElement("canvas");
    cropped.width = width;
    cropped.height = height;
    const c2 = cropped.getContext("2d");
    if (!c2) throw new Error("Image export is unavailable in this browser.");
    c2.drawImage(canvas, 0, 0, width, height, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => cropped.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not create the share image.");
    pageIndex += 1;
    files.push(new File([blob], `station-board-${pageIndex}.png`, { type: "image/png" }));
    canvas.width = 0;
    cropped.width = 0;
    if (rowIndex >= table.rows.length) break;
  }

  return files;
}

export async function downloadBoardShare(table: BoardShareTable, fileName: string) {
  const files = await renderBoardShareImages(table);
  if (files.length === 1) {
    downloadBlob(files[0]!, `${fileName}.png`);
    return files;
  }
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  files.forEach((file, i) => zip.file(`${fileName}-${i + 1}.png`, file));
  downloadBlob(await zip.generateAsync({ type: "blob" }), `${fileName}-images.zip`);
  return files;
}

export async function shareBoardImages(files: File[], title: string, text: string) {
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files }) && navigator.share) {
    await navigator.share({ files, title, text });
    return "shared" as const;
  }
  return "downloaded" as const;
}
