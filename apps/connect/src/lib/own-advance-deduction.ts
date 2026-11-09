import "server-only";
import { createHmac } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";

const unavailable = "Your advance deductions could not be verified. Please retry.";

// Call only after requireConnectAccount and canonical Workforce resolution. A preview
// retains the actor's session, so forwarding that cookie to an own-mobile API is wrong.
// Sign the already-authorised scope instead; no session cookie or raw secret leaves One.
export async function loadOwnAdvanceDeduction(companyId: string, workforceId: string, month: string): Promise<number> {
  let stage = "configuration";
  let code: string | undefined;
  let status: number | undefined;
  try {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) throw new Error("Missing service configuration");
    if (!supabaseAdmin) throw new Error("Database unavailable");
    // The shared allocation engine can only add an ADVANCE_RECOVERY line for a
    // worker present in this due ledger. Avoid a second full payout calculation
    // when it proves there is nothing to allocate; errors must never mean zero.
    stage = "advance_ledger";
    const due = await supabaseAdmin.rpc("pay_advance_period_due", {
      p_company: companyId, p_period: `${month}-01`, p_target: "workforce"
    }, { get: true }).eq("worker_id", workforceId).limit(1);
    if (due.error || !Array.isArray(due.data)) { code=due.error?.code; throw new Error("Advance ledger unavailable"); }
    if (!due.data.length) return 0;
    const body = JSON.stringify({ companyId, workforceId, month });
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", secret)
      .update(`dropx:workforce-advance-deduction:v1.${timestamp}.${body}`).digest("hex");
    stage = "payout_calculation";
    const response = await fetch(new URL("/api/internal/workforce-advance-deduction",
      process.env.DASHBOARD_URL || "https://dashboard.dropxlogistics.com"), {
      method: "POST", body,
      headers: { "content-type": "application/json", "x-dropx-time": timestamp, "x-dropx-signature": signature },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000)
    });
    status = response.status;
    const result = await response.json();
    if (!response.ok || !Number.isFinite(result?.advanceRecoveryAmount) || result.advanceRecoveryAmount < 0) {
      throw new Error("Invalid deduction response");
    }
    return result.advanceRecoveryAmount;
  } catch {
    // Operational diagnostics only: never log identities, signatures or financial payloads.
    console.error("one.advance_deduction_unavailable", {stage,code,status});
    // Never display a misleading net amount by treating an unavailable deduction as zero.
    throw new Error(unavailable);
  }
}
