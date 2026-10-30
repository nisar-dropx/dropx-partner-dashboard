import "server-only";
import { createHmac } from "node:crypto";

const unavailable = "Your advance deductions could not be verified. Please retry.";

// Call only after requireConnectAccount and canonical Workforce resolution. A preview
// retains the actor's session, so forwarding that cookie to an own-mobile API is wrong.
// Sign the already-authorised scope instead; no session cookie or raw secret leaves One.
export async function loadOwnAdvanceDeduction(companyId: string, workforceId: string, month: string): Promise<number> {
  try {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) throw new Error("Missing service configuration");
    const body = JSON.stringify({ companyId, workforceId, month });
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", secret)
      .update(`dropx:workforce-advance-deduction:v1.${timestamp}.${body}`).digest("hex");
    const response = await fetch(new URL("/api/internal/workforce-advance-deduction",
      process.env.DASHBOARD_URL || "https://dashboard.dropxlogistics.com"), {
      method: "POST", body,
      headers: { "content-type": "application/json", "x-dropx-time": timestamp, "x-dropx-signature": signature },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000)
    });
    const result = await response.json();
    if (!response.ok || !Number.isFinite(result?.advanceRecoveryAmount) || result.advanceRecoveryAmount < 0) {
      throw new Error("Invalid deduction response");
    }
    return result.advanceRecoveryAmount;
  } catch {
    // Never display a misleading net amount by treating an unavailable deduction as zero.
    throw new Error(unavailable);
  }
}
