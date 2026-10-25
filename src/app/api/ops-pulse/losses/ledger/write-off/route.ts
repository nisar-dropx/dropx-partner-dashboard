import { mayActivateRedispute } from "@/lib/ops-pulse/loss-recovery-controls";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nlStationScope } from "@/lib/ops-pulse/nl-loss";

export const dynamic = "force-dynamic";

const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/** Writes off what an exited person's final settlement could not recover. Master-level decision with a reason. */
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)
      return reply({ error: "Invalid request origin." }, 403);
    const auth = await getAuthorization();
    if (!auth || !mayActivateRedispute(auth) || !hasPermission(auth, "ops_loss_master", "edit") || !supabaseAdmin)
      return reply({ error: "Only people with Loss Recovery Master edit access can write off a balance." }, 403);
    const body = await request.json().catch(() => ({}));
    const month = String(body.month ?? ""), caseKey = String(body.case_key ?? ""), ref = String(body.employee_ref ?? "");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !caseKey || caseKey.length > 300 || !/^(employee|workforce):[0-9a-f-]{36}$/i.test(ref))
      return reply({ error: "Invalid recovery line." }, 400);
    if (reason.length < 10 || reason.length > 2000)
      return reply({ error: "Give a clear write-off reason (10–2,000 characters)." }, 400);
    // The case must belong to a station this person can see.
    const { company, stations } = await nlStationScope(auth);
    const row = await supabaseAdmin
      .from("nl_loss_month_cases")
      .select("station_code")
      .eq("company_id", company)
      .eq("month", month)
      .eq("case_key", caseKey)
      .maybeSingle();
    const code = String(row.data?.station_code ?? "").trim().toUpperCase();
    if (row.error || !stations.some((s) => s.source_code === code))
      return reply({ error: "This recovery line is not in your stations." }, 403);
    const result = await supabaseAdmin.rpc("waive_nl_recovery_balance", {
      p_company: company,
      p_month: month,
      p_case: caseKey,
      p_ref: ref,
      p_reason: reason,
      p_actor: auth.userId,
      p_name: auth.fullName || auth.email || "OpsPulse user",
    });
    if (result.error)
      return reply({ error: result.error.code === "P0001" ? result.error.message : "The balance could not be written off." }, 409);
    return reply({ waiver: result.data });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : "The balance could not be written off." }, 500);
  }
}
