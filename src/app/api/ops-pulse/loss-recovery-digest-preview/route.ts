import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { digestDatabase } from "@/lib/portal-digest-delivery";
import { buildLossRecoveryActionDigest } from "@/lib/loss-recovery-action-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Dry-run HTML for the signed-in editor. Does not enqueue or send mail. */
export async function GET(request: Request) {
  try {
    const auth = await getAuthorization();
    if (!auth || !hasPermission(auth, "ops_notification_settings", "edit")) {
      throw new Error("Access denied");
    }
    const company = requireCompanyId(auth);
    const db = digestDatabase();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const date = new URL(request.url).searchParams.get("date") || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
      throw new Error("Choose a valid report date on or before today.");
    }
    const control = await db
      .from("portal_notification_controls")
      .select("*")
      .eq("company_id", company)
      .eq("portal", "ops")
      .eq("event_key", "loss_recovery_action_digest")
      .single();
    if (control.error) throw new Error("Loss recovery digest control is not configured yet.");
    const result = await buildLossRecoveryActionDigest(db, control.data, date);
    const email = auth.email?.trim().toLowerCase() || "";
    const mine = result.messages.find((m) => m.email === email);
    const sample = mine || result.messages[0];
    if (!sample) {
      return new Response(
        `<!doctype html><html><body style="font:14px Arial;padding:24px"><h1>Loss recovery digest · dry run</h1><p>Report date <b>${date}</b>: no open actions. Empty days send nothing when the schedule is enabled.</p><p>Control state: <b>${control.data.state}</b> · delivery_ready: <b>${String(control.data.config?.delivery_ready)}</b></p></body></html>`,
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      );
    }
    const banner = `<div style="padding:12px 20px;background:#fff7ed;border-bottom:1px solid #fed7aa;font:13px Arial"><b>Dry-run preview · ${date}</b> · To ${sample.email}${mine ? " (your scope)" : " (first recipient — you had no rows)"} · Control remains <b>${control.data.state}</b> / delivery_ready=<b>${String(control.data.config?.delivery_ready)}</b>. This page never sends mail.</div>`;
    return new Response(sample.html.replace(/(<body[^>]*>)/i, `$1${banner}`), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'",
      },
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Preview unavailable" },
      { status: 400 },
    );
  }
}
