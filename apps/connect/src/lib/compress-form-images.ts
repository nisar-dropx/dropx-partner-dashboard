// Profile onboarding uploads every document (Aadhaar front/back, PAN, photo, ...) in one request,
// and Vercel rejects request bodies over 4.5 MB with a plain-text 413 — two or three phone-camera
// photos are enough to hit it. Resizing images on the phone first keeps each one to a few hundred
// KB, well within the limit, while staying legible for document checks.

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;
const COMPRESS_ABOVE_BYTES = 500 * 1024;
// Vercel's limit is 4.5 MB; leave headroom for the text fields and multipart overhead.
export const MAX_UPLOAD_REQUEST_BYTES = 4 * 1024 * 1024;

async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.size <= COMPRESS_ABOVE_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    // Formats the browser can't decode (e.g. HEIC on Android) are sent as they are.
    return file;
  }
}

/** Replaces every large image in the form data with a resized JPEG, in place. */
export async function compressFormImages(data: FormData) {
  const entries: Array<[string, File]> = [];
  data.forEach((value, key) => {
    if (value instanceof File && value.size > 0) entries.push([key, value]);
  });
  for (const [key, file] of entries) {
    const compressed = await compressImage(file);
    if (compressed !== file) data.set(key, compressed);
  }
}

/** Total bytes of all files in the form data. */
export function formFileBytes(data: FormData) {
  let total = 0;
  data.forEach((value) => {
    if (value instanceof File) total += value.size;
  });
  return total;
}

export const UPLOAD_TOO_LARGE_MESSAGE =
  "Your documents are too large to upload together. Use photos instead of large PDFs, or upload a few now with Save draft and the rest after.";
