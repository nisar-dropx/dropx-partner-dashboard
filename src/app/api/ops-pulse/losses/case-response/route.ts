import { recoveryContext } from "@/lib/ops-pulse/nl-recovery-context";
import { mayActivateRedispute } from "@/lib/ops-pulse/loss-recovery-controls";
import { supabaseAdmin } from "@/lib/supabase-admin";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(request: Request) {
  try {
    const q = new URL(request.url).searchParams;
    const ctx = await recoveryContext(q.get("month") || "", q.get("case") || "", false, true);
    const query = (table: string) => supabaseAdmin!.from(table).select("*").eq("company_id", ctx.scope.company).eq("month", q.get("month")).eq("case_key", ctx.caseKey);
    const [window, events, row] = await Promise.all([
      query("nl_case_response_windows").maybeSingle(), query("nl_case_response_events").order("created_at", { ascending: false }), query("nl_loss_month_cases").maybeSingle(),
    ]);
    if (window.error || events.error || row.error) throw Error("Case response could not be loaded.");
    return reply({ window: window.data ?? { version: 0, enabled: false }, events: events.data, row: row.data, canActivate: mayActivateRedispute(ctx.auth), readOnly: ctx.auth.readOnly });
  } catch (e) { return reply({ error: e instanceof Error ? e.message : "Unable to load case response." }, 403); }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return reply({ error: "Invalid origin." }, 403);
    const b = await request.json();
    const ctx = await recoveryContext(String(b.month || ""), String(b.case_key || ""), true, true);
    if (!["activate", "revoke", "response", "vendor_response"].includes(b.action) || !Number.isInteger(b.version) || b.version < 0) return reply({ error: "Invalid action." }, 400);
    if (b.action !== "response" && !mayActivateRedispute(ctx.auth)) return reply({ error: "Only SLP or leadership above cluster manager can activate a case or record a vendor response." }, 403);
    const url = String(b.evidence_url || "").trim();
    if (url) { const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw Error("Use a valid HTTPS evidence link."); }
    const { data, error } = await supabaseAdmin!.rpc("nl_case_response_transition", {
      p_company: ctx.scope.company, p_month: b.month, p_case: ctx.caseKey, p_version: b.version, p_action: b.action,
      p_note: String(b.note || ""), p_url: url, p_public: b.public_confirmed === true,
      p_actor: ctx.auth.userId, p_name: ctx.auth.fullName || ctx.auth.email || "OpsPulse user",
    });
    if (error) return reply({ error: error.code === "P0001" ? error.message : "Response could not be saved." }, 409);
    return reply({ window: data });
  } catch (e) { return reply({ error: e instanceof Error ? e.message : "Unable to save response." }, 403); }
}
