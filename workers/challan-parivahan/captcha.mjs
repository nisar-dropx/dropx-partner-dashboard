// Free, local captcha OCR using tesseract.js. No paid or demo APIs.
// A single worker is created and reused across the process to avoid re-init cost.
import { createWorker } from "tesseract.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // langPath points at the bundled eng.traineddata so the container never
      // fetches language data from the network at runtime.
      const w = await createWorker("eng", 1, {
        langPath: process.env.TESSDATA_PATH || __dirname,
        gzip: false,
        cacheMethod: "none",
      });
      await w.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        tessedit_pageseg_mode: "7", // single text line
      });
      return w;
    })();
  }
  return workerPromise;
}

/** Solve a Parivahan captcha PNG. Returns an alphanumeric string (usually 6 chars). */
export async function solveCaptcha(pngBytes) {
  const worker = await getWorker();
  const { data } = await worker.recognize(pngBytes);
  return String(data.text || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 6);
}

export async function closeCaptcha() {
  if (workerPromise) {
    try {
      const w = await workerPromise;
      await w.terminate();
    } catch {
      /* ignore */
    }
    workerPromise = null;
  }
}
