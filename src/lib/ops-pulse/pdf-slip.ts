import type * as PdfJs from "pdfjs-dist";

/**
 * Browser-only helpers for PDF deposit slips: page previews, and compression
 * of a large PDF before upload. A PDF slip is stored as a PDF.
 *
 * pdf.js is served from /public (copied from pdfjs-dist/legacy/build, same
 * version as package.json) and loaded with a native import instead of being
 * bundled, so the page and its worker run as shipped. The legacy build is
 * used because slips are uploaded from older phones.
 */
const PDFJS_BASE = "/vendor/pdfjs-4.10.38";
// Stays under the canvas area limit of mobile Safari.
const MAX_PAGE_PIXELS = 12_000_000;

/** A PDF this small is uploaded untouched. */
export const PDF_SLIP_KEEP_BYTES = 1024 * 1024;
/** The host rejects request bodies over 4.5 MB; leave room for the other fields. */
export const PDF_SLIP_MAX_BYTES = 4 * 1024 * 1024;
/** Longer PDFs are not re-rendered: dropping pages would lose part of the document. */
const COMPRESS_MAX_PAGES = 10;
const COMPRESS_PASSES = [
  { width: 1500, quality: 0.72 },
  { width: 1100, quality: 0.55 }
];

let pdfjsPromise: Promise<typeof PdfJs> | null = null;

export function loadPdfJs() {
  if (!pdfjsPromise) {
    const url = `${PDFJS_BASE}/pdf.min.mjs`;
    pdfjsPromise = (import(/* webpackIgnore: true */ url) as Promise<typeof PdfJs>)
      .then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
        return pdfjs;
      })
      .catch((error) => {
        // Let the next attempt retry instead of caching a failed load.
        pdfjsPromise = null;
        throw error;
      });
  }
  return pdfjsPromise;
}

/** Thrown with a message that is safe to show to the person uploading. */
export class PdfSlipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfSlipError";
  }
}

export function isPdfFile(file: { type?: string | null; name?: string | null }) {
  return (file.type || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(file.name || "");
}

function toJpeg(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new PdfSlipError("This browser could not render the PDF."))),
      "image/jpeg",
      quality
    );
  });
}

export type PdfPageImage = {
  blob: Blob;
  /** Page size in PDF points. */
  pointWidth: number;
  pointHeight: number;
};

export type PdfPageImages = {
  pages: PdfPageImage[];
  /** Pages in the PDF; more than `pages.length` when `maxPages` cut it short. */
  totalPages: number;
};

/** Renders the first `maxPages` pages as JPEGs, each `width` pixels wide. */
export async function renderPdfPages(
  data: ArrayBuffer,
  options: { maxPages: number; width: number; quality?: number }
): Promise<PdfPageImages> {
  const pdfjs = await loadPdfJs();
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  try {
    let pdf: PdfJs.PDFDocumentProxy;
    try {
      pdf = await task.promise;
    } catch (error) {
      throw new PdfSlipError(
        error instanceof Error && error.name === "PasswordException"
          ? "This PDF is password protected. Upload a photo of the slip instead."
          : "This PDF could not be read. Upload a photo of the slip instead."
      );
    }

    const pages: PdfPageImage[] = [];
    for (let index = 1; index <= Math.min(pdf.numPages, options.maxPages); index += 1) {
      const page = await pdf.getPage(index);
      const size = page.getViewport({ scale: 1 });
      if (!(size.width > 0) || !(size.height > 0)) throw new PdfSlipError("This PDF has a page that cannot be shown.");
      let scale = Math.min(3, options.width / size.width);
      const pixels = size.width * size.height * scale * scale;
      if (pixels > MAX_PAGE_PIXELS) scale *= Math.sqrt(MAX_PAGE_PIXELS / pixels);

      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new PdfSlipError("This browser could not render the PDF.");
      await page.render({ canvasContext: context, viewport }).promise;
      pages.push({ blob: await toJpeg(canvas, options.quality ?? 0.85), pointWidth: size.width, pointHeight: size.height });
      // Hand the page bitmap back before rendering the next one.
      canvas.width = 0;
      canvas.height = 0;
    }
    return { pages, totalPages: pdf.numPages };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/**
 * Returns the PDF to upload. A small PDF is returned as it is. A large one is
 * rebuilt from JPEG renders of its pages, and the rebuilt copy is used only
 * when it is actually smaller. Throws PdfSlipError when the result would
 * still be too large to upload.
 */
export async function compressPdfSlip(source: File): Promise<File> {
  if (source.size <= PDF_SLIP_KEEP_BYTES) return source;

  const data = await source.arrayBuffer();
  let best = source;
  for (const pass of COMPRESS_PASSES) {
    const rendered = await renderPdfPages(data, { maxPages: COMPRESS_MAX_PAGES, width: pass.width, quality: pass.quality });
    if (rendered.totalPages > rendered.pages.length) break;

    const { PDFDocument } = await import("pdf-lib");
    const rebuilt = await PDFDocument.create();
    for (const page of rendered.pages) {
      const image = await rebuilt.embedJpg(await page.blob.arrayBuffer());
      rebuilt.addPage([page.pointWidth, page.pointHeight]).drawImage(image, {
        x: 0,
        y: 0,
        width: page.pointWidth,
        height: page.pointHeight
      });
    }
    const bytes = await rebuilt.save();
    if (bytes.byteLength < best.size) {
      best = new File([bytes as BlobPart], source.name, { type: "application/pdf", lastModified: source.lastModified });
    }
    if (best.size <= PDF_SLIP_MAX_BYTES) break;
  }

  if (best.size > PDF_SLIP_MAX_BYTES) {
    throw new PdfSlipError(
      `This PDF is too large to upload (${(best.size / 1024 / 1024).toFixed(1)} MB after compression, limit ${PDF_SLIP_MAX_BYTES / 1024 / 1024} MB). Upload a photo of the slip instead.`
    );
  }
  return best;
}
