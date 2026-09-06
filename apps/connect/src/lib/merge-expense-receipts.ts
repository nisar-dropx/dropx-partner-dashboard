import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type ReceiptMergeInput = {
  bytes: Uint8Array;
  fileName: string;
  contentType: string;
};

function isPdf(input: ReceiptMergeInput) {
  const type = input.contentType.toLowerCase();
  return type.includes("pdf") || input.fileName.toLowerCase().endsWith(".pdf");
}

function isPng(input: ReceiptMergeInput) {
  const type = input.contentType.toLowerCase();
  return type.includes("png") || input.fileName.toLowerCase().endsWith(".png");
}

function isJpeg(input: ReceiptMergeInput) {
  const type = input.contentType.toLowerCase();
  return type.includes("jpeg") || type.includes("jpg") || /\.(jpe?g)$/i.test(input.fileName);
}

function addImagePage(
  pdf: PDFDocument,
  image: { width: number; height: number; scale: (factor: number) => { width: number; height: number } },
  filename: string,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>
) {
  const page = pdf.addPage([595, 842]);
  page.drawText(filename.slice(0, 90), { x: 36, y: 806, size: 11, font, color: rgb(0.2, 0.2, 0.2) });
  const maxWidth = 523;
  const maxHeight = 740;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  const size = image.scale(scale);
  page.drawImage(image as never, {
    x: (595 - size.width) / 2,
    y: 36 + (maxHeight - size.height) / 2,
    width: size.width,
    height: size.height
  });
}

/** Merge receipt images/PDFs into a single PDF for expense storage. */
export async function mergeExpenseReceiptsToPdf(files: ReceiptMergeInput[]) {
  if (!files.length) throw new Error("Attach at least one receipt image or PDF.");
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const boldFont = await output.embedFont(StandardFonts.HelveticaBold);
  const unsupported: string[] = [];

  for (const file of files) {
    try {
      if (isPdf(file)) {
        const source = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
        const pages = await output.copyPages(source, source.getPageIndices());
        pages.forEach((page) => output.addPage(page));
      } else if (isPng(file)) {
        const image = await output.embedPng(file.bytes);
        addImagePage(output, image, file.fileName, boldFont);
      } else if (isJpeg(file)) {
        const image = await output.embedJpg(file.bytes);
        addImagePage(output, image, file.fileName, boldFont);
      } else if (file.contentType.toLowerCase().includes("webp") || file.fileName.toLowerCase().endsWith(".webp")) {
        unsupported.push(file.fileName);
      } else {
        unsupported.push(file.fileName);
      }
    } catch {
      unsupported.push(file.fileName);
    }
  }

  if (!output.getPageCount()) {
    throw new Error(unsupported.length
      ? `Unable to merge receipts into a PDF (${unsupported.join(", ")}). Use PDF, JPG or PNG.`
      : "Unable to merge receipts into a PDF.");
  }

  if (unsupported.length) {
    const page = output.addPage([595, 842]);
    page.drawText("Receipts not merged", { x: 48, y: 790, size: 16, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
    unsupported.slice(0, 30).forEach((name, index) => {
      page.drawText(`- ${name}`.slice(0, 90), { x: 48, y: 760 - index * 18, size: 11, font, color: rgb(0.25, 0.25, 0.25) });
    });
  }

  return await output.save();
}
