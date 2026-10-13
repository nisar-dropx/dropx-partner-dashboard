import type * as PdfJs from "pdfjs-dist";

/**
 * Browser-only: turns a PDF deposit slip into one JPEG so it is stored,
 * reviewed and displayed exactly like a photographed slip.
 *
 * pdf.js is served from /public (copied from pdfjs-dist/legacy/build, same
 * version as package.json) and loaded with a native import instead of being
 * bundled, so the page and its worker run as shipped. The legacy build is
 * used because slips are uploaded from older phones.
 */
const PDFJS_BASE = "/vendor/pdfjs-4.10.38";
const MAX_PAGES = 4;
const TARGET_WIDTH = 1600;
// Stays under the canvas area limit of mobile Safari.
const MAX_PIXELS = 12_000_000;
// Server actions reject request bodies over 1 MB by default.
const MAX_BYTES = 900 * 1024;
const JPEG_QUALITIES = [0.85, 0.7, 0.55];

let pdfjsPromise: Promise<typeof PdfJs> | null = null;

function loadPdfJs() {
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

export function isPdfFile(file: File) {
  return (file.type || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(file.name);
}

function toJpeg(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not create an image from this PDF."))),
      "image/jpeg",
      quality
    );
  });
}

export type PdfSlipImage = {
  file: File;
  /** Pages drawn into the image. */
  pages: number;
  /** Pages in the PDF; more than `pages` when the PDF was longer than MAX_PAGES. */
  totalPages: number;
};

/** Pages are stacked top to bottom on a white background. */
export async function pdfSlipToImage(source: File): Promise<PdfSlipImage> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await source.arrayBuffer()) });
  try {
    let pdf: PdfJs.PDFDocumentProxy;
    try {
      pdf = await task.promise;
    } catch (error) {
      if (error instanceof Error && error.name === "PasswordException") {
        throw new Error("This PDF is password protected. Upload a photo of the slip instead.");
      }
      throw new Error("This PDF could not be read. Upload a photo of the slip instead.");
    }

    const pageCount = Math.min(pdf.numPages, MAX_PAGES);
    const pages: PdfJs.PDFPageProxy[] = [];
    for (let index = 1; index <= pageCount; index += 1) pages.push(await pdf.getPage(index));

    const sizes = pages.map((page) => page.getViewport({ scale: 1 }));
    const widest = Math.max(...sizes.map((size) => size.width));
    const tallest = sizes.reduce((sum, size) => sum + size.height, 0);
    if (!(widest > 0) || !(tallest > 0)) throw new Error("This PDF has no readable pages.");

    let scale = Math.min(3, TARGET_WIDTH / widest);
    const pixels = widest * tallest * scale * scale;
    if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);

    const viewports = pages.map((page) => page.getViewport({ scale }));
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(widest * scale);
    canvas.height = viewports.reduce((sum, viewport) => sum + Math.ceil(viewport.height), 0);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot convert PDFs. Upload a photo of the slip instead.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    let top = 0;
    for (const [index, page] of pages.entries()) {
      const viewport = viewports[index];
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = Math.ceil(viewport.width);
      pageCanvas.height = Math.ceil(viewport.height);
      const pageContext = pageCanvas.getContext("2d");
      if (!pageContext) throw new Error("This browser cannot convert PDFs. Upload a photo of the slip instead.");
      await page.render({ canvasContext: pageContext, viewport }).promise;
      context.drawImage(pageCanvas, Math.floor((canvas.width - pageCanvas.width) / 2), top);
      top += pageCanvas.height;
      // Hand the page bitmap back before rendering the next one.
      pageCanvas.width = 0;
      pageCanvas.height = 0;
    }

    let blob = await toJpeg(canvas, JPEG_QUALITIES[0]);
    for (const quality of JPEG_QUALITIES.slice(1)) {
      if (blob.size <= MAX_BYTES) break;
      blob = await toJpeg(canvas, quality);
    }

    const name = `${source.name.replace(/\.pdf$/i, "") || "deposit-slip"}.jpg`;
    return {
      file: new File([blob], name, { type: "image/jpeg", lastModified: Date.now() }),
      pages: pageCount,
      totalPages: pdf.numPages
    };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
