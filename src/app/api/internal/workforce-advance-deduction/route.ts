import { createHmac, timingSafeEqual } from "node:crypto";
import { loadOwnWorkforceAdvanceDeduction } from "@/lib/pay-advance-capacity";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const headers = { "Cache-Control": "private, no-store" };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// One authenticates the account (including authorised read-only previews) first.
// This purpose-bound service request can only read one worker's monthly deduction;
// it never grants access to the advance-request or payment mutation endpoints.
export async function POST(request: Request) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const timestamp = request.headers.get("x-dropx-time") ?? "";
  const signature = request.headers.get("x-dropx-signature") ?? "";
  const body = await request.text();
  if (!secret || body.length > 2000 || !/^\d+$/.test(timestamp)
    || !Number.isSafeInteger(Number(timestamp)) || Math.abs(Date.now() - Number(timestamp)) > 60_000
    || !/^[a-f0-9]{64}$/.test(signature)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  const expected = createHmac("sha256", secret)
    .update(`dropx:workforce-advance-deduction:v1.${timestamp}.${body}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  let input: { companyId: string; workforceId: string; month: string };
  try {
    input = JSON.parse(body);
    if (!input || typeof input.companyId !== "string" || !uuid.test(input.companyId)
      || typeof input.workforceId !== "string" || !uuid.test(input.workforceId)
      || typeof input.month !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(input.month)) {
      throw new Error("Invalid scope");
    }
  } catch {
    return Response.json({ error: "Invalid deduction scope." }, { status: 400, headers });
  }

  try {
    if (!supabaseAdmin) throw new Error("Database unavailable");
    const worker = await supabaseAdmin.from("workforce").select("id")
      .eq("company_id", input.companyId).eq("id", input.workforceId)
      .is("deleted_at", null).neq("migration_state", "reclassified").maybeSingle();
    if (worker.error) throw new Error("Worker lookup unavailable");
    if (!worker.data) return Response.json({ error: "Worker not found." }, { status: 404, headers });

    // Use the same allocation, paid-history and available-pay safeguards as payouts.
    const advanceRecoveryAmount = await loadOwnWorkforceAdvanceDeduction(input.companyId, input.workforceId, input.month);
    if (!Number.isFinite(advanceRecoveryAmount) || advanceRecoveryAmount < 0) throw new Error("Invalid deduction");
    return Response.json({ advanceRecoveryAmount }, { headers });
  } catch {
    return Response.json({ error: "Advance deductions could not be verified." }, { status: 503, headers });
  }
}
