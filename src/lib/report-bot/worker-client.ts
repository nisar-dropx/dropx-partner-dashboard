import "server-only";
import type { ReportBotSettings } from "@/lib/report-bot/settings";

/** retryable: try again later. blocked: nothing will work until settings change. */
export class WorkerError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean, readonly blocked = false) {
    super(message);
  }

  /** The worker itself is down or unreachable, as opposed to rejecting this request. */
  get unavailable() {
    return this.retryable && (this.status === 0 || this.status >= 502);
  }
}

export type WorkerSession = {
  state: "idle" | "connecting" | "qr" | "pairing" | "open" | "closed" | "logged_out";
  qr: string | null;
  pairing_code: string | null;
  me: { id: string; name: string | null } | null;
  last_error: string | null;
};

export type WorkerGroup = { id: string; subject: string; size: number; announce: boolean };

function workerBaseUrl(settings: ReportBotSettings) {
  const raw = settings.worker_url?.trim();
  if (!raw) throw new WorkerError("Worker URL is not set. Add it under Report Bot → Connection.", 0, false, true);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkerError("Worker URL is not a valid URL.", 0, false, true);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && process.env.NODE_ENV !== "production")) {
    throw new WorkerError("Worker URL must use https.", 0, false, true);
  }
  return url.toString().replace(/\/+$/, "");
}

export async function workerRequest<T>(settings: ReportBotSettings, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  if (!settings.worker_token) throw new WorkerError("Worker token is not generated yet.", 0, false, true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15000);
  try {
    const response = await fetch(`${workerBaseUrl(settings)}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${settings.worker_token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" })
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: controller.signal
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = (payload as { error?: string } | null)?.error || `Worker returned HTTP ${response.status}.`;
      throw new WorkerError(message, response.status, response.status >= 500 || response.status === 429 || response.status === 409, response.status === 401);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    const aborted = (error as { name?: string })?.name === "AbortError";
    throw new WorkerError(aborted ? "Worker did not respond in time." : "Worker is unreachable.", 0, true);
  } finally {
    clearTimeout(timer);
  }
}

export async function workerMedia(settings: ReportBotSettings, ref: string) {
  if (!settings.worker_token) throw new WorkerError("Worker token is not generated yet.", 0, false, true);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(ref)) throw new WorkerError("Invalid media reference.", 400, false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${workerBaseUrl(settings)}/media/${ref}`, {
      headers: { authorization: `Bearer ${settings.worker_token}` },
      cache: "no-store",
      signal: controller.signal
    });
    if (response.status === 404) throw new WorkerError("The worker no longer has this image (expired or deleted).", 404, false);
    if (!response.ok) throw new WorkerError(`Worker returned HTTP ${response.status} for media.`, response.status, response.status >= 500);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError("Worker is unreachable while downloading media.", 0, true);
  } finally {
    clearTimeout(timer);
  }
}
