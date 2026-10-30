import { getAuthorization, isCompanyOwner, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { digestDatabase } from "@/lib/portal-digest-delivery";
import { loadRosterPendency } from "@/lib/roster-pendency-data";
import { buildRosterPendencyMessages } from "@/lib/roster-pendency-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export async function GET(request: Request) {
  try {
    const auth = await getAuthorization();
    if (!auth || !isCompanyOwner(auth) || !hasPermission(auth, "ops_notification_settings", "edit")) {
      return Response.json({ error: "Owner notification-settings access required." }, { status: 403 });
    }
    const db = digestDatabase();
    const company = requireCompanyId(auth);
    const url = new URL(request.url);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const control = await db.from("portal_notification_controls").select("config,subject_template")
      .eq("company_id", company).eq("portal", "ops").eq("event_key", "roster_pendency_morning").single();
    if (control.error) throw new Error("Roster reminder schedule unavailable.");
    const domain = String(control.data.config?.email_domain || "dropxlogistics.com");
    const snapshot = await loadRosterPendency(db, company, date, domain);
    const messages = buildRosterPendencyMessages(
      snapshot,
      control.data.subject_template || "DropX | Roster pending at your stations | Morning | {{date}}"
    );
    const selected = messages.find((message) => message.email === url.searchParams.get("recipient"));
    if (url.searchParams.get("format") === "json") {
      return Response.json({
        date,
        checkedAt: snapshot.checkedAt,
        counts: {
          plans: snapshot.rows.length,
          recipients: messages.length,
          unroutedStations: snapshot.unroutedStationIds.length
        },
        recipients: messages.map((message) => ({ email: message.email, name: message.name, ...message.scope })),
        unroutedStationIds: snapshot.unroutedStationIds
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const toolbar = `<div style="padding:18px;font:14px Arial;background:#fff"><b>READ-ONLY PREVIEW — no email sent</b><p>${snapshot.rows.length} open roster plans · ${messages.length} manager emails · ${snapshot.unroutedStationIds.length} stations without a routable SM/CM email</p><form><label>Recipient <select name="recipient">${messages.map((message) => `<option value="${esc(message.email)}" ${message.email === selected?.email ? "selected" : ""}>${esc(message.name)} · ${esc(message.email)} · ${message.scope.pending} plans</option>`).join("")}</select></label><button>Preview email</button></form></div>`;
    const html = selected
      ? selected.html.replace(/(<body[^>]*>)/, "$1" + toolbar)
      : `<!doctype html><html><body>${toolbar}</body></html>`;
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'"
      }
    });
  } catch (error) {
    console.error("Roster preview failed", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Roster preview unavailable. No email has been sent." }, { status: 503 });
  }
}
