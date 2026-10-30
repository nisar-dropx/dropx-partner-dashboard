import "server-only";
import { createHmac } from "node:crypto";

// Caller must first authorize this exact account through requireConnectAccount.
// Read-only previews retain the administrator's mobile, not the worker's mobile.
export async function loadOwnAdvanceCapacity(companyId: string, workforceId: string) {
  try {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) throw new Error("Missing service configuration");
    const body = JSON.stringify({ companyId, workforceId });
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", secret).update(`dropx:workforce-advance-capacity:v1.${timestamp}.${body}`).digest("hex");
    const response = await fetch(new URL("/api/internal/workforce-advance-capacity", process.env.DASHBOARD_URL || "https://dashboard.dropxlogistics.com"), {
      method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", "x-dropx-time": timestamp, "x-dropx-signature": signature }
    });
    const payload = await response.json();
    if (!response.ok || typeof payload.account?.eligibleForAdvance !== "boolean") throw new Error("Invalid response");
    for (const key of ["outstandingPay", "committedAdvance", "eligibilityPercent", "maxEligibleAmount"]) {
      if (!Number.isFinite(payload.account[key]) || payload.account[key] < 0) throw new Error("Invalid capacity");
    }
    return payload;
  } catch {
    throw new Error("Advance details are temporarily unavailable. Please retry.");
  }
}
