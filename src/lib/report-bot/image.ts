import "server-only";
import sharp from "sharp";
import { AiError } from "@/lib/report-bot/ai";
import type { ReportBotSettings } from "@/lib/report-bot/settings";
import { workerMedia } from "@/lib/report-bot/worker-client";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Report images are never stored by the portal. Each time one is needed (AI check,
 * a reviewer opening it) it is fetched from the worker, which keeps a short cache and
 * otherwise downloads it from WhatsApp again. Returned as a resized JPEG in memory.
 */
export async function fetchReportImage(settings: ReportBotSettings, mediaRef: string | null) {
  if (!mediaRef) throw new AiError("This message has no image attached.", false);
  const original = await workerMedia(settings, mediaRef);
  if (original.byteLength > MAX_IMAGE_BYTES) throw new AiError("The image is larger than 12 MB.", false);
  try {
    // Fixes phone rotation, caps size (AI limits, Vercel's response limit) and converts HEIC/PNG/WEBP.
    return new Uint8Array(await sharp(Buffer.from(original), { failOn: "error" })
      .rotate()
      .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer());
  } catch {
    throw new AiError("The file is not a readable image (JPG, PNG or WEBP).", false);
  }
}
