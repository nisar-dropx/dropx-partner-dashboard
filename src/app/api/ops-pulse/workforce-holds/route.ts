import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadWorkforceHoldTargets, loadWorkforceHoldWorkspace, type WorkforceHoldAction } from "@/lib/ops-pulse/workforce-hold-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
const ACTIONS: WorkforceHoldAction[] = ["approve", "reject", "withdraw", "request_release", "approve_release", "reject_release"];

export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "ops_salary_hold", "access")) return reply({ error: "Access denied." }, 403);
  try {
    const station = new URL(request.url).searchParams.get("station");
    if (station) return reply({ people: await loadWorkforceHoldTargets(auth, station) });
    return reply(await loadWorkforceHoldWorkspace(auth));
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : "Workforce holds could not be loaded." }, 503);
  }
}

/** Raise a hold, or move one. Who may act is recomputed here from the workspace; the database enforces the rest. */
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return reply({ error: "Invalid request origin." }, 403);
    const auth = await getAuthorization();
    if (!auth || !supabaseAdmin || !hasPermission(auth, "ops_salary_hold", "access")) return reply({ error: "Access denied." }, 403);
    if (auth.readOnly) return reply({ error: "Read-only access cannot change holds." }, 403);
    const body = await request.json().catch(() => ({}));
    const companyId = requireCompanyId(auth);
    const name = auth.fullName || auth.email || "Ops user";
    const message = (e: { code?: string; message: string }, fallback: string) => (e.code === "P0001" ? e.message : fallback);
    if (body.kind === "raise") {
      if (!hasPermission(auth, "ops_salary_hold", "edit")) return reply({ error: "You do not have access to raise Workforce holds." }, 403);
      const workforceId = String(body.workforceId ?? ""), month = String(body.month ?? ""), reason = String(body.reason ?? "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(workforceId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return reply({ error: "Choose the associate and the payout month." }, 400);
      if (reason.length < 5 || reason.length > 1000) return reply({ error: "Explain the reason for this hold (5–1,000 characters)." }, 400);
      const person = await supabaseAdmin.from("workforce").select("location_id").eq("company_id", companyId).eq("id", workforceId).is("deleted_at", null).maybeSingle();
      if (person.error || !person.data) return reply({ error: "Associate not found." }, 404);
      if (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(String(person.data.location_id))) return reply({ error: "That associate is outside your stations." }, 403);
      const r = await supabaseAdmin.rpc("ops_workforce_hold_raise", { p_company: companyId, p_workforce: workforceId, p_month: `${month}-01`, p_reason: reason, p_actor: auth.userId, p_name: name });
      if (r.error) return reply({ error: message(r.error, "The hold could not be raised.") }, 409);
      return reply({ message: "Hold raised. It blocks payment once the cluster manager approves it." });
    }
    const id = String(body.requestId ?? ""), action = String(body.action ?? "") as WorkforceHoldAction, note = String(body.note ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(id) || !ACTIONS.includes(action) || !Number.isInteger(body.version)) return reply({ error: "This request is invalid. Refresh and try again." }, 400);
    const workspace = await loadWorkforceHoldWorkspace(auth);
    const current = workspace.requests.find((r) => r.id === id);
    if (!current) return reply({ error: "This hold is not in your stations." }, 403);
    if (!current.actions.includes(action))
      return reply({ error: ["approve", "reject", "approve_release", "reject_release"].includes(action) ? "Only the station's cluster manager can decide this, and never their own request." : "Only the person who raised this hold can do that, at this stage." }, 403);
    const r = await supabaseAdmin.rpc("ops_workforce_hold_transition", { p_company: companyId, p_request: id, p_action: action, p_version: body.version, p_actor: auth.userId, p_name: name, p_note: note || null });
    if (r.error) return reply({ error: message(r.error, "The hold could not be updated.") }, 409);
    const done: Record<WorkforceHoldAction, string> = {
      approve: "Approved. Payment is on hold for that month.", reject: "Hold rejected.", withdraw: "Hold withdrawn.",
      request_release: "Release requested. The cluster manager will decide it.", approve_release: "Released. Payment can be processed again.", reject_release: "Release declined; payment stays on hold.",
    };
    return reply({ message: done[action] });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : "The hold could not be saved." }, 500);
  }
}
