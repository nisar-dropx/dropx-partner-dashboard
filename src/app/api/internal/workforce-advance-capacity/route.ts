import { createHmac, timingSafeEqual } from "node:crypto";
import { isAdvanceEligible } from "@/lib/advance-eligibility";
import { loadPayAdvanceCapacity } from "@/lib/pay-advance-capacity";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Purpose-bound, company/account-scoped READ service. Never accepts requests,
// changes limits or approves advances. One authenticates the viewer first.
export async function POST(request: Request) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const timestamp = request.headers.get("x-dropx-time") ?? "";
  const signature = request.headers.get("x-dropx-signature") ?? "";
  const body = await request.text();
  if (!secret || body.length > 2000 || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
    || Math.abs(Date.now() - Number(timestamp)) > 60_000 || !/^[a-f0-9]{64}$/.test(signature)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  const expected = createHmac("sha256", secret).update(`dropx:workforce-advance-capacity:v1.${timestamp}.${body}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  let input: { companyId: string; workforceId: string };
  try {
    input = JSON.parse(body);
    if (!input || typeof input.companyId !== "string" || !uuid.test(input.companyId)
      || typeof input.workforceId !== "string" || !uuid.test(input.workforceId)) throw new Error("Invalid scope");
  } catch { return Response.json({ error: "Invalid account scope." }, { status: 400, headers }); }
  try {
    if (!supabaseAdmin) throw new Error("Database unavailable");
    const worker = await supabaseAdmin.from("workforce").select("id,is_active,onboarding_status")
      .eq("company_id", input.companyId).eq("id", input.workforceId).is("deleted_at", null).neq("migration_state", "reclassified").maybeSingle();
    if (worker.error) throw worker.error;
    if (!worker.data) return Response.json({ error: "Worker not found." }, { status: 404, headers });
    const eligibleForAdvance = isAdvanceEligible({ currentPeopleAssignment: worker.data.is_active === true,
      profileActive: worker.data.is_active === true, profileStatus: worker.data.onboarding_status });
    const capacity = await loadPayAdvanceCapacity({ companyId: input.companyId, profileType: "workforce", accountId: input.workforceId });
    return Response.json({ account: { eligibleForAdvance, ...capacity } }, { headers });
  } catch { return Response.json({ error: "Advance details are temporarily unavailable." }, { status: 503, headers }); }
}
