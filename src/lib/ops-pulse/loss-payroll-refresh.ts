import "server-only";
import { createHmac } from "node:crypto";

/** Wake People after a successful loss write. The shared secret itself never leaves this server. */
export async function refreshLossPayroll(companyId: string) {
  const pending = { status: "pending" as const, message: "Recovery changes saved. People payroll refresh is pending and will retry when payroll is opened or during its automatic refresh." };
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return pending;
  const body = JSON.stringify({ companyId }), timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(`dropx:loss-payroll-refresh:v1.${timestamp}.${body}`).digest("hex");
  try {
    const response = await fetch("https://people.dropxlogistics.com/api/internal/loss-payroll-refresh", {
      method: "POST", headers: { "Content-Type": "application/json", "x-dropx-time": timestamp, "x-dropx-signature": signature },
      body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return pending;
    const result = await response.json();
    if (!Number.isInteger(result.refreshed) || !Number.isInteger(result.unchanged) || result.pending) return pending;
    if (result.refreshed + result.unchanged === 0) return { status: "scheduled" as const, message: "Recovery changes saved. There is no open People payroll yet; the deduction will apply when an eligible payroll is calculated. Workforce payouts read saved recoveries live." };
    return { status: "synced" as const, message: "Recovery changes saved. Open People payroll is up to date; Workforce payouts use the saved recovery on calculation." };
  } catch { return pending; }
}
