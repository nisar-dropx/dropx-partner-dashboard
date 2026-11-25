import "server-only";
import { createWorker, type Worker } from "tesseract.js";
import sharp from "sharp";

/** Local error shape matching AiError so this module does not import ai.ts (cycle). */
export class OcrError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly blocked = false) {
    super(message);
  }
}

/** Typical local / remote OCR wall time — used by the submission queue budget. */
export const OCR_BUDGET_MS = 55_000;
const REMOTE_TIMEOUT_MS = 45_000;
/** Keep aligned with workers/report-image-ocr free-tier upload cap. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Match remote OCR max long-edge so we do not re-inflate screenshots on Render free. */
const OCR_MAX_LONG_EDGE = 1600;
const MAX_OCR_CHARS = 40_000;

let sharedWorker: Worker | null = null;
let sharedWorkerPromise: Promise<Worker> | null = null;
/** Serialize Tesseract.js — one worker cannot recognize concurrently. */
let ocrTail: Promise<unknown> = Promise.resolve();

function withOcrLock<T>(work: () => Promise<T>): Promise<T> {
  const run = ocrTail.then(work, work);
  ocrTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Extract readable text from a report screenshot for deterministic scrapers.
 * No Gemini / Groq — free-tier AI quotas are already exhausted for this project.
 *
 * Order:
 * 1. Optional Python OCR service (`REPORT_IMAGE_OCR_URL`) — best on Render / VM
 * 2. In-process Tesseract.js (local / serverless fallback)
 *
 * Concurrent callers are queued so bulk inbound screenshots do not race the worker.
 */
export async function extractReportImageText(
  _settings: unknown,
  image: Uint8Array,
  mime: "image/jpeg" | "image/png" | "image/webp"
): Promise<string> {
  if (!image?.length) throw new OcrError("No image bytes to OCR.", false);
  if (image.length > MAX_IMAGE_BYTES) {
    throw new OcrError("Image is larger than 8 MB.", false);
  }

  return withOcrLock(async () => {
    const prepared = await preprocessForOcr(image);

    const remoteUrl = process.env.REPORT_IMAGE_OCR_URL?.trim();
    if (remoteUrl) {
      try {
        return truncateOcr(await ocrWithRemoteService(remoteUrl, prepared));
      } catch (error) {
        // Fall through to local Tesseract unless the remote is a hard auth/config failure.
        if (error instanceof OcrError && error.blocked) throw error;
      }
    }

    return truncateOcr(await ocrWithTesseract(prepared, mime === "image/png" ? "image/png" : "image/jpeg"));
  });
}

function truncateOcr(text: string) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= MAX_OCR_CHARS) return trimmed;
  return trimmed.slice(0, MAX_OCR_CHARS);
}

async function preprocessForOcr(image: Uint8Array): Promise<Uint8Array> {
  try {
    // Device screenshots: grayscale + contrast + upscale small captures for Tesseract.
    return new Uint8Array(await sharp(Buffer.from(image), { failOn: "error" })
      .rotate()
      .grayscale()
      .normalize()
      .resize({
        width: OCR_MAX_LONG_EDGE,
        height: OCR_MAX_LONG_EDGE,
        fit: "inside",
        withoutEnlargement: false
      })
      .sharpen()
      .png()
      .toBuffer());
  } catch {
    return image;
  }
}

async function ocrWithRemoteService(baseUrl: string, image: Uint8Array): Promise<string> {
  const token = process.env.REPORT_IMAGE_OCR_TOKEN?.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const body = new FormData();
    body.append("file", new Blob([new Uint8Array(image)], { type: "image/png" }), "report.png");
    const response = await fetch(baseUrl.replace(/\/$/, "") + "/ocr", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
      body
    });
    const payload = await response.json().catch(() => ({})) as { text?: string; error?: string };
    if (response.status === 401 || response.status === 403) {
      throw new OcrError("REPORT_IMAGE_OCR_TOKEN was rejected by the OCR service.", false, true);
    }
    if (!response.ok) {
      throw new OcrError(payload.error || `OCR service error (${response.status}).`, true);
    }
    const text = String(payload.text ?? "").trim();
    if (!text) throw new OcrError("OCR service returned empty text.", true);
    return text;
  } catch (error) {
    if (error instanceof OcrError) throw error;
    throw new OcrError("OCR service is unreachable.", true);
  } finally {
    clearTimeout(timer);
  }
}

async function getTesseractWorker(): Promise<Worker> {
  if (sharedWorker) return sharedWorker;
  if (!sharedWorkerPromise) {
    sharedWorkerPromise = (async () => {
      const worker = await createWorker("eng", 1, {
        // Keep logs quiet in cron; failures still throw.
        logger: () => undefined
      });
      // PSM 6 = single uniform block of text (UI screens).
      await worker.setParameters({
        tessedit_pageseg_mode: "6",
        preserve_interword_spaces: "1"
      } as unknown as Parameters<Worker["setParameters"]>[0]);
      sharedWorker = worker;
      return worker;
    })().catch((error) => {
      sharedWorkerPromise = null;
      throw error;
    });
  }
  return sharedWorkerPromise;
}

async function ocrWithTesseract(image: Uint8Array, mime: "image/jpeg" | "image/png"): Promise<string> {
  try {
    const worker = await getTesseractWorker();
    const result = await worker.recognize(Buffer.from(image));
    const text = String(result.data.text ?? "").trim();
    if (!text) throw new OcrError("Tesseract could not read any text from this image.", false);
    return text;
  } catch (error) {
    if (error instanceof OcrError) throw error;
    throw new OcrError(
      `Local OCR failed: ${error instanceof Error ? error.message : "unknown error"}`,
      true
    );
  }
}

/** Test helper: preprocess + expose without network. */
export async function preprocessReportImageForOcr(image: Uint8Array) {
  return preprocessForOcr(image);
}
