import { readAllRows } from "@/lib/supabase-pagination";
import { hasPermission } from "@/lib/authorization";
import { recoveryContext } from "@/lib/ops-pulse/nl-recovery-context";
import { mayActivateRedispute, mayViewLossApprovals } from "@/lib/ops-pulse/loss-recovery-controls";
import { supabaseAdmin } from "@/lib/supabase-admin";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(request: Request) {
  try {
    const q = new URL(request.url).searchParams;
    const ctx = await recoveryContext(q.get("month") || "", q.get("case") || "", false, true);
    const query = (table: string) => supabaseAdmin!.from(table).select("*").eq("company_id", ctx.scope.company).eq("month", q.get("month")).eq("case_key", ctx.caseKey);
    const [window, events, row] = await Promise.all([
      query("nl_case_response_windows").maybeSingle(), readAllRows(query("nl_case_response_events").order("created_at", { ascending: false }).order("id")), query("nl_loss_month_cases").maybeSingle(),
    ]);
    if (window.error || events.error || row.error) throw Error("Case response could not be loaded.");
    if (!mayViewLossApprovals(ctx.auth) && !window.data?.enabled) return reply({ error: "This TID has no active response window." }, 403);
    return reply({ window: window.data ?? { version: 0, enabled: false }, events: events.data, row: row.data, canActivate: mayActivateRedispute(ctx.auth), readOnly: ctx.auth.readOnly || !hasPermission(ctx.auth, "ops_losses", "edit") });
  } catch (e) { return reply({ error: e instanceof Error ? e.message : "Unable to load case response." }, 403); }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return reply({ error: "Invalid origin." }, 403);
    const b = await request.json();
    const ctx = await recoveryContext(String(b.month || ""), String(b.case_key || ""), true, true);
    if (!["activate", "revoke", "response", "vendor_response", "tracking"].includes(b.action) || !Number.isInteger(b.version) || b.version < 0) return reply({ error: "Invalid action." }, 400);
    if (b.action !== "response" && !mayActivateRedispute(ctx.auth)) return reply({ error: "Only SLP Manager, National Head, Finance Manager or Managing Partner can manage redisputes." }, 403);
    const url = String(b.evidence_url || "").trim();
    if (url) { const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw Error("Use a valid HTTPS evidence link."); }
    if (b.action === "tracking") {
      const ttUrl=String(b.tt_url || "").trim();
      if(ttUrl) { const parsed=new URL(ttUrl); if(parsed.protocol!=="https:" || parsed.username || parsed.password) throw Error("Use a valid HTTPS LSC ticket link."); }
      if(b.followup_on && !/^\d{4}-\d{2}-\d{2}$/.test(b.followup_on)) throw Error("Choose a valid follow-up date.");
      const {data,error}=await supabaseAdmin!.rpc("nl_redispute_track",{p_company:ctx.scope.company,p_month:b.month,p_case:ctx.caseKey,p_version:b.version,p_reference:String(b.tt_reference||""),p_url:ttUrl,p_status:String(b.followup_status||""),p_due:b.followup_on||null,p_note:String(b.note||""),p_actor:ctx.auth.userId,p_name:ctx.auth.fullName||ctx.auth.email||"OpsPulse user"});
      if(error) return reply({error:error.code==="P0001"?error.message:"Ticket update could not be saved."},409);
      return reply({window:data});
    }
    const { data, error } = await supabaseAdmin!.rpc("nl_case_response_transition", {
      p_company: ctx.scope.company, p_month: b.month, p_case: ctx.caseKey, p_version: b.version, p_action: b.action,
      p_note: String(b.note || ""), p_url: url, p_public: b.public_confirmed === true,
      p_actor: ctx.auth.userId, p_name: ctx.auth.fullName || ctx.auth.email || "OpsPulse user",
    });
    if (error) return reply({ error: error.code === "P0001" ? error.message : "Response could not be saved." }, 409);
    return reply({ window: data });
  } catch (e) { return reply({ error: e instanceof Error ? e.message : "Unable to save response." }, 403); }
}
