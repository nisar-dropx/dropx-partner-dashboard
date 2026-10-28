"use server";

import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { callWorkforceAmazonWorker, workforceAmazonWorkerConfig } from "@/lib/workforce-amazon-worker";

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
  error?: string;
};

function actionError(error: unknown): MarshSessionView {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Marsh request failed";
  // Next.js digests production Server Component failures into this opaque string.
  const friendly =
    /Server Components render|digest property/i.test(message)
      ? "Marsh action interrupted while refreshing the page. Check session status and try again."
      : message;
  return {
    credentialsConfigured: false,
    status: "failed",
    challengeId: null,
    lastError: friendly,
    updatedAt: null,
    uploadedAt: null,
    cookiePresent: false,
    cookieAgeSeconds: null,
    driveConfigured: false,
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
    // OTP may have succeeded on the worker even if the UI refresh failed — return status when possible.
    try {
      const latest = await callMarsh<MarshSessionView>("/api/admin/marsh/session/status", undefined, 15_000);
      if (latest.status === "active") return { ...latest, ok: true };
      if (latest.status === "otp_required" || latest.status === "failed") {
        return {
          ...latest,
          ok: false,
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

export async function syncMarshEcardsAction() {
  try {
    await requirePagePermissionOrThrow("app_settings", "edit");
    return await callMarsh<{ ok: boolean; uploaded: number; skipped: number; error?: string }>(
      "/api/admin/marsh/ecards/sync",
      { method: "POST", body: "{}" },
      120_000,
    );
  } catch (error) {
    return {
      ok: false,
      uploaded: 0,
      skipped: 0,
      error: actionError(error).error,
    };
  }
}
