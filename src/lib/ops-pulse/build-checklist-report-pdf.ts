/** Browser-only: build a checklist report PDF with embedded proof images. */
import {
  formatTaskAnswer,
  isImageProof,
  isPdfProof,
  isVideoProof,
  type ReportPack,
  type ReportPackProof,
} from "./checklist-report-pack";
import { renderPdfPages } from "./pdf-slip";

const MARGIN = 40;
const PAGE_W = 595;
const PAGE_H = 842;
const CONTENT_W = PAGE_W - MARGIN * 2;
const MAX_IMAGE_H = 220;

async function fetchBlob(url: string, signal?: AbortSignal) {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok) throw Error(`Could not load evidence (${res.status}).`);
  return res.blob();
}

async function blobToJpegBytes(
  blob: Blob,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const type = (blob.type || "").toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  // Attempt decode via ImageBitmap / canvas (HEIC may fail).
  try {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    const maxW = 1200;
    const scale = Math.min(1, maxW / Math.max(1, bmp.width));
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (!jpeg) return null;
    return new Uint8Array(await jpeg.arrayBuffer());
  } catch {
    return null;
  }
}

async function proofJpegs(
  proof: ReportPackProof,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; note?: string }[]> {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  const absolute = proof.url.startsWith("http")
    ? proof.url
    : `${origin}${proof.url}`;

  if (isVideoProof(proof.content_type, proof.file_name)) {
    return [];
  }

  const blob = await fetchBlob(absolute, signal);

  if (isPdfProof(proof.content_type, proof.file_name)) {
    const rendered = await renderPdfPages(await blob.arrayBuffer(), {
      maxPages: 4,
      width: 1100,
      quality: 0.78,
    });
    const out: { bytes: Uint8Array; note?: string }[] = [];
    for (const page of rendered.pages) {
      out.push({ bytes: new Uint8Array(await page.blob.arrayBuffer()) });
    }
    if (rendered.totalPages > rendered.pages.length) {
      out.push({
        bytes: new Uint8Array(),
        note: `PDF has ${rendered.totalPages} pages; first ${rendered.pages.length} shown.`,
      });
    }
    return out.filter((x) => x.bytes.length || x.note);
  }

  if (isImageProof(proof.content_type, proof.file_name)) {
    const bytes = await blobToJpegBytes(blob, signal);
    if (bytes) return [{ bytes }];
    return [
      {
        bytes: new Uint8Array(),
        note: `Could not embed ${proof.file_name} — open original in report.`,
      },
    ];
  }

  return [
    {
      bytes: new Uint8Array(),
      note: `Attachment: ${proof.file_name}`,
    },
  ];
}

export async function buildChecklistReportPdf(
  pack: ReportPack,
  options?: { signal?: AbortSignal },
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.4, 0.45, 0.5);
  const accent = rgb(0.06, 0.46, 0.43);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensure = (need: number) => {
    if (y - need < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const drawText = (
    text: string,
    opts: {
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      maxWidth?: number;
    } = {},
  ) => {
    const size = opts.size ?? 10;
    const f = opts.bold ? fontBold : font;
    const color = opts.color ?? ink;
    const maxWidth = opts.maxWidth ?? CONTENT_W;
    const words = String(text || "").split(/\s+/).filter(Boolean);
    let line = "";
    const lines: string[] = [];
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > maxWidth && line) {
        lines.push(line);
        line = w;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    if (!lines.length) lines.push("—");
    for (const ln of lines) {
      ensure(size + 4);
      page.drawText(ln, {
        x: MARGIN,
        y: y - size,
        size,
        font: f,
        color,
      });
      y -= size + 3;
    }
  };

  const c = pack.checklist;
  const title =
    pack.kind === "shift"
      ? `Shift checklist · ${c.store_code}`
      : `Store checklist · ${c.store_code}`;
  drawText(title, { size: 16, bold: true, color: accent });
  drawText(c.store_name, { size: 11, color: muted });
  const when =
    pack.kind === "shift"
      ? `${c.shift_date || ""} ${c.shift_slot || ""}`.trim()
      : c.work_date || "";
  drawText(
    `${when} · ${c.statusLabel} · ${c.pct}% (${c.answered}/${c.total})`,
    { size: 10 },
  );
  drawText(
    pack.kind === "shift"
      ? `SI: ${c.person_name}${c.incoming_name ? ` → ${c.incoming_name}` : ""}`
      : `Owner: ${c.person_name}`,
    { size: 10 },
  );
  y -= 8;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 0.6,
    color: rgb(0.85, 0.88, 0.92),
  });
  y -= 14;

  const proofsByTask = new Map<string, ReportPackProof[]>();
  for (const proof of pack.proofs) {
    const list = proofsByTask.get(proof.task_id) || [];
    list.push(proof);
    proofsByTask.set(proof.task_id, list);
  }

  if (!pack.sections?.length) {
    drawText("No checklist sections available for this report.", {
      size: 10,
      color: muted,
    });
  }

  for (const section of pack.sections || []) {
    ensure(28);
    drawText(section.name || "Section", { size: 12, bold: true, color: accent });
    y -= 2;

    if (!section.tasks?.length) {
      drawText("No tasks in this section.", { size: 9, color: muted });
      continue;
    }

    for (const task of section.tasks) {
      ensure(36);
      drawText(task.label, { size: 10, bold: true });
      drawText(formatTaskAnswer(task), { size: 9, color: muted });

      const taskProofs = proofsByTask.get(task.id) || [];
      for (const proof of taskProofs) {
        if (options?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        if (isVideoProof(proof.content_type, proof.file_name)) {
          const link =
            typeof window !== "undefined"
              ? `${window.location.origin}${proof.url}`
              : proof.url;
          drawText(`View video: ${link}`, { size: 8, color: accent });
          continue;
        }

        try {
          const embeds = await proofJpegs(proof, options?.signal);
          for (const emb of embeds) {
            if (emb.note && !emb.bytes.length) {
              drawText(emb.note, { size: 8, color: muted });
              continue;
            }
            if (!emb.bytes.length) continue;
            const image = await doc.embedJpg(emb.bytes);
            const scale = Math.min(
              CONTENT_W / image.width,
              MAX_IMAGE_H / image.height,
              1,
            );
            const w = image.width * scale;
            const h = image.height * scale;
            ensure(h + 12);
            page.drawImage(image, {
              x: MARGIN,
              y: y - h,
              width: w,
              height: h,
            });
            y -= h + 8;
            if (emb.note) drawText(emb.note, { size: 8, color: muted });
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          drawText(
            `Could not embed ${proof.file_name} — open original in report.`,
            { size: 8, color: muted },
          );
        }
      }
      y -= 6;
    }
    y -= 6;
  }

  drawText("Generated in browser · not stored on server", {
    size: 8,
    color: muted,
  });

  return doc.save();
}

export function downloadPdfBytes(bytes: Uint8Array, fileName: string) {
  const safe =
    String(fileName || "ops-checklist.pdf")
      .replace(/[^\w.\-]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 120) || "ops-checklist.pdf";
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safe.endsWith(".pdf") ? safe : `${safe}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
