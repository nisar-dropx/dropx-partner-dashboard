export const REPORT_AUTO_SOURCE_CODES = [
  "amazon_shipments",
  "daily_edsp_metrics",
  "da_inapp_onboarding",
  "edsp_outstanding_cash",
  "delivered_shipment_detail",
  "iocl_fuel",
  "bpcl_fuel",
  "cashbook"
] as const;

export type ReportAutoSourceCode = (typeof REPORT_AUTO_SOURCE_CODES)[number];

export function isReportAutoSource(value: string): value is ReportAutoSourceCode {
  return (REPORT_AUTO_SOURCE_CODES as readonly string[]).includes(value);
}

export const WORKFORCE_AUTO_SOURCE_CODES = [
  "amazon_shipments",
  "daily_edsp_metrics",
  "da_inapp_onboarding",
  "edsp_outstanding_cash"
] as const;

export function isWorkforceAutoSource(value: string) {
  return (WORKFORCE_AUTO_SOURCE_CODES as readonly string[]).includes(value);
}

function workerConfig() {
  const baseUrl = (process.env.REPORT_AUTO_WORKER_URL || "").trim().replace(/\/$/, "");
  const adminKey = (process.env.REPORT_AUTO_ADMIN_KEY || process.env.ADMIN_API_KEY || "").trim().replace(/^["']|["']$/g, "");
  const uiEnabled = (process.env.REPORT_AUTO_UI_ENABLED ?? "true").trim().toLowerCase() !== "false";
  return { baseUrl, adminKey, uiEnabled };
}

export function isReportAutoWorkerConfigured() {
  const { baseUrl, adminKey, uiEnabled } = workerConfig();
  return Boolean(uiEnabled && baseUrl && adminKey);
}

export function isReportAutoUiEnabled() {
  return isReportAutoWorkerConfigured();
}

async function parseWorkerResponse(response: Response, text: string) {
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: unknown }).error)
      : payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : (text && !/^\s*</.test(text) ? text.slice(0, 400) : null)
          || `Report auto worker returned ${response.status}`;
    const error = new Error(message) as Error & { status?: number; payload?: unknown };
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function reportAutoGet<T>(path: string, query?: Record<string, string>): Promise<T> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new Error("Report auto worker is not configured. Set REPORT_AUTO_WORKER_URL and REPORT_AUTO_ADMIN_KEY.");
  }
  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-admin-key": adminKey },
    cache: "no-store"
  });
  const text = await response.text();
  return (await parseWorkerResponse(response, text)) as T;
}

export async function reportAutoPost<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new Error("Report auto worker is not configured. Set REPORT_AUTO_WORKER_URL and REPORT_AUTO_ADMIN_KEY.");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": adminKey
    },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const text = await response.text();
  return (await parseWorkerResponse(response, text)) as T;
}

/** Download a generated report artifact from the worker (binary, admin key auth). */
export async function reportAutoFetchFile(path: string): Promise<{ bytes: ArrayBuffer; fileName: string; mime: string }> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new Error("Report auto worker is not configured. Set REPORT_AUTO_WORKER_URL and REPORT_AUTO_ADMIN_KEY.");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { "x-admin-key": adminKey },
    cache: "no-store"
  });
  if (!response.ok) {
    await parseWorkerResponse(response, await response.text());
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = /filename\*?="?([^";]+)"?/i.exec(disposition)?.[1]?.trim();
  return {
    bytes: await response.arrayBuffer(),
    fileName: fileName || "report-auto-file",
    mime: response.headers.get("content-type") || "application/octet-stream"
  };
}

/** ISO week of an IST calendar YYYY-MM-DD. */
export function isoWeekFromYmd(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) throw new Error("report_date must be YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type WorkforceReadyResponse = {
  ok: boolean;
  isoWeek: string;
  ready: boolean;
  alreadyUploaded: boolean;
  reason: string | null;
  todayIst: string;
  files?: Array<{
    reportId: string;
    formattedCreationDate: string | null;
    fresh: boolean;
    reason: string | null;
  }>;
};

export type AutoRunResult = {
  ok: boolean;
  sourceType: string;
  runId?: string;
  statusUrl?: string;
  message: string;
  ready?: boolean;
  done?: boolean;
  isoWeek?: string;
  reportDate?: string;
  imported?: number;
  skipped?: number;
  totalRows?: number;
  /** Worker WAF blocked — retry via operator browser (IOCL/BPCL). */
  clientPortal?: boolean;
};
