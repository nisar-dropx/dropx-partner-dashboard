"use server";

import { revalidatePath } from "next/cache";
import { requirePagePermission } from "@/lib/authorization";
import { callWorkforceAmazonWorker } from "@/lib/workforce-amazon-worker";

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
};

const PAGE_PATH = "/settings/marsh-insurance";

export async function getMarshSessionStatus(): Promise<MarshSessionView> {
  await requirePagePermission("app_settings", "access");
  return callWorkforceAmazonWorker<MarshSessionView>("/api/admin/marsh/session/status");
}

export async function startMarshLogin() {
  await requirePagePermission("app_settings", "edit");
  const result = await callWorkforceAmazonWorker<MarshSessionView>("/api/admin/marsh/session/start", {
    method: "POST",
    body: JSON.stringify({ uploadedBy: "dashboard-settings-marsh" }),
  });
  revalidatePath(PAGE_PATH);
  return result;
}

export async function submitMarshOtp(challengeId: string, otp: string) {
  await requirePagePermission("app_settings", "edit");
  const result = await callWorkforceAmazonWorker<MarshSessionView>("/api/admin/marsh/session/otp", {
    method: "POST",
    body: JSON.stringify({ challengeId, otp }),
  });
  revalidatePath(PAGE_PATH);
  return result;
}

export async function ensureMarshSessionAction() {
  await requirePagePermission("app_settings", "edit");
  const result = await callWorkforceAmazonWorker<MarshSessionView & { ok: boolean }>("/api/admin/marsh/session/ensure", {
    method: "POST",
    body: "{}",
  });
  revalidatePath(PAGE_PATH);
  return result;
}

export async function syncMarshEcardsAction() {
  await requirePagePermission("app_settings", "edit");
  return callWorkforceAmazonWorker<{ ok: boolean; uploaded: number; skipped: number; error?: string }>(
    "/api/admin/marsh/ecards/sync",
    { method: "POST", body: "{}" },
  );
}
