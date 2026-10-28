"use server";

import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { workforceAmazonWorkerConfig } from "@/lib/workforce-amazon-worker";

export type MarshEcardSyncProgress = {
  pending: boolean;
  phase: "export" | "process" | "done";
  uploaded: number;
  skipped: number;
  remaining: number | null;
  cursor: number;
  jobId: number | null;
  detail: string;
  updatedAt: string | null;
};

export type MarshSessionView = {
  ok?: boolean;
  credentialsConfigured: boolean;
  status: string;
  challengeId: string | null;
  lastError: string | null;
  updatedAt: string | null;
  uploadedAt: string | null;
  cookiePresent: boolean;
  cookieAgeSeconds: number | null;
  driveConfigured?: boolean;
  /** Live ecard Drive sync progress from the worker (null when idle). */
  ecardSync?: MarshEcardSyncProgress | null;
  error?: string;
  /** True when this payload is only an action failure overlay and must not wipe live session fields. */
  softFailure?: boolean;
};

function actionError(error: unknown): MarshSessionView {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Marsh request failed";
  const friendly =
    /Server Components render|digest property/i.test(message)
      ? "Marsh action interrupted while refreshing the page. Check session status and try again."
      : message;
  return {
    softFailure: true,
    credentialsConfigured: true,
    status: "failed",
    challengeId: null,
    lastError: friendly,
    updatedAt: null,
    uploadedAt: null,
    cookiePresent: false,
    cookieAgeSeconds: null,
    driveConfigured: undefined,
    ok: false,
    error: friendly,
  };
}

async function callMarsh<T>(path: string, init?: RequestInit, timeoutMs = 60_000): Promise<T> {
  const { baseUrl, adminKey, configured } = workforceAmazonWorkerConfig();
  if (!configured) {
    throw new Error("Workforce worker is not connected. Set WORKFORCE_AMAZON_WORKER_URL and WORKFORCE_AMAZON_WORKER_KEY.");
  }
  const response = await fetch(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-key": adminKey,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  let payload: unknown = null;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch {
    payload = { error: body };
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Worker HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export async function getMarshSessionStatus(): Promise<MarshSessionView> {
  try {
    await requirePagePermissionOrThrow("app_settings", "access");
    return await callMarsh<MarshSessionView>("/api/admin/marsh/session/status", undefined, 20_000);
  } catch (error) {
    return actionError(error);
  }
}

export async function startMarshLogin() {
  try {
    await requirePagePermissionOrThrow("app_settings", "edit");
    return await callMarsh<MarshSessionView>(
      "/api/admin/marsh/session/start",
      {
        method: "POST",
        body: JSON.stringify({ uploadedBy: "dashboard-settings-marsh" }),
      },
      90_000,
    );
  } catch (error) {
    return actionError(error);
  }
}

export async function submitMarshOtp(challengeId: string, otp: string) {
  try {
    await requirePagePermissionOrThrow("app_settings", "edit");
    return await callMarsh<MarshSessionView>(
      "/api/admin/marsh/session/otp",
      {
        method: "POST",
        body: JSON.stringify({ challengeId, otp }),
      },
      90_000,
    );
  } catch (error) {
    try {
      const latest = await callMarsh<MarshSessionView>("/api/admin/marsh/session/status", undefined, 15_000);
      if (latest.status === "active") return { ...latest, ok: true };
      if (latest.status === "otp_required" || latest.status === "failed") {
        return {
          ...latest,
          ok: false,
          softFailure: latest.status === "otp_required",
          error: latest.lastError || actionError(error).error,
        };
      }
    } catch {
      /* fall through */
    }
    return actionError(error);
  }
}

export async function ensureMarshSessionAction() {
  try {
    await requirePagePermissionOrThrow("app_settings", "edit");
    return await callMarsh<MarshSessionView & { ok: boolean }>(
      "/api/admin/marsh/session/ensure",
      { method: "POST", body: "{}" },
      45_000,
    );
  } catch (error) {
    return { ...actionError(error), ok: false };
  }
}

export type MarshEcardSyncState = {
  ok: boolean;
  uploaded: number;
  skipped: number;
  pending?: boolean;
  phase?: "export" | "process" | "done";
  jobId?: number | null;
  downloadPath?: string | null;
  cursor?: number;
  remaining?: number;
  error?: string;
  detail?: string;
};

export async function syncMarshEcardsAction(state?: {
  jobId?: number | null;
  downloadPath?: string | null;
  cursor?: number;
  uploaded?: number;
  skipped?: number;
}): Promise<MarshEcardSyncState> {
  try {
    await requirePagePermissionOrThrow("app_settings", "edit");
    // One worker step per action. The Settings UI loops on pending; the worker
    // also waitUntil-drains and resumes from saved cursor on empty {}. Nested
    // server loops race waitUntil and can rewind the cursor.
    return await callMarsh<MarshEcardSyncState>(
      "/api/admin/marsh/ecards/sync",
      {
        method: "POST",
        body: JSON.stringify({
          jobId: state?.jobId ?? null,
          downloadPath: state?.downloadPath ?? null,
          cursor: state?.cursor ?? 0,
          uploaded: state?.uploaded ?? 0,
          skipped: state?.skipped ?? 0,
        }),
      },
      120_000,
    );
  } catch (error) {
    return {
      ok: false,
      uploaded: state?.uploaded ?? 0,
      skipped: state?.skipped ?? 0,
      jobId: state?.jobId ?? null,
      downloadPath: state?.downloadPath ?? null,
      cursor: state?.cursor ?? 0,
      error: actionError(error).error,
    };
  }
}
