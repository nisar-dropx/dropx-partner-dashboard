import { readAllRows } from "@/lib/supabase-pagination";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { recoveryContext } from "@/lib/ops-pulse/nl-recovery-context";
import {
  mayActivateRedispute,
  mayViewLossApprovals,
} from "@/lib/ops-pulse/loss-recovery-controls";
import { supabaseAdmin } from "@/lib/supabase-admin";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
export async function GET(request: Request) {
  try {
    const q = new URL(request.url).searchParams;
    const ctx = await recoveryContext(
      q.get("month") || "",
      q.get("case") || "",
      false,
      true,
    );
    const query = (table: string) =>
      supabaseAdmin!
        .from(table)
        .select("*")
        .eq("company_id", ctx.scope.company)
        .eq("month", q.get("month"))
        .eq("case_key", ctx.caseKey);
    const [window, events, row] = await Promise.all([
      query("nl_case_response_windows").maybeSingle(),
      readAllRows(
        query("nl_case_response_events")
          .order("created_at", { ascending: false })
          .order("id"),
      ),
      query("nl_loss_month_cases").maybeSingle(),
    ]);
    if (window.error || events.error || row.error)
      throw Error("Case response could not be loaded.");
    if (!mayViewLossApprovals(ctx.auth) && !window.data?.enabled)
      return reply(
        { error: "This Shipment ID has no active response window." },
        403,
      );
    return reply({
      window: window.data ?? { version: 0, enabled: false },
      events: events.data,
      row: row.data,
      canActivate: mayActivateRedispute(ctx.auth),
      readOnly:
        ctx.auth.readOnly || !hasPermission(ctx.auth, "ops_losses", "edit"),
    });
  } catch (e) {
    return reply(
      {
        error: e instanceof Error ? e.message : "Unable to load case response.",
      },
      403,
    );
  }
}
async function transition(b: Record<string, any>) {
  const ctx = await recoveryContext(
    String(b.month || ""),
    String(b.case_key || ""),
    true,
    true,
  );
  if (
    ![
      "activate",
      "revoke",
      "response",
      "approve",
      "return",
      "tracking",
      "won",
      "lost",
    ].includes(b.action) ||
    !Number.isInteger(b.version) ||
    b.version < 0
  )
    throw Error("Invalid action.");
  if (b.action !== "response" && !mayActivateRedispute(ctx.auth))
    throw Error(
      "Only SLP Manager, National Head, Finance Manager or Managing Partner can manage redisputes.",
    );
  const details = {
    note: String(b.note || "").trim(),
    reason: String(b.reason || "").trim(),
    evidence_url: String(b.evidence_url || "").trim(),
    tt_reference: String(b.tt_reference || "").trim(),
    tt_url: String(b.tt_url || "").trim(),
    followup_on: b.followup_on || null,
    recovery_month: b.recovery_month || null,
  };
  for (const value of [details.evidence_url, details.tt_url])
    if (value) {
      const u = new URL(value);
      if (u.protocol !== "https:" || u.username || u.password)
        throw Error("Use a valid HTTPS evidence or ticket link.");
    }
  if (JSON.stringify(details).length > 12000)
    throw Error("Response is too long.");
  const { data, error } = await supabaseAdmin!.rpc("nl_redispute_transition", {
    p_company: ctx.scope.company,
    p_month: b.month,
    p_case: ctx.caseKey,
    p_version: b.version,
    p_action: b.action,
    p_details: details,
    p_actor: ctx.auth.userId,
    p_name: ctx.auth.fullName || ctx.auth.email || "OpsPulse user",
  });
  if (error)
    throw Error(
      error.code === "P0001"
        ? error.message
        : "Redispute could not be saved. Reload and retry.",
    );
  return data;
}
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      return reply({ error: "Invalid origin." }, 403);
    const b = await request.json();
    if (!b || typeof b !== "object" || Array.isArray(b))
      return reply({ error: "Invalid request." }, 400);
    if (b.action === "bulk_activate") {
      const auth = await getAuthorization();
      if (
        !auth ||
        !mayActivateRedispute(auth) ||
        !hasPermission(auth, "ops_losses", "edit")
      )
        return reply(
          {
            error:
              "Only SLP Manager, National Head, Finance Manager or Managing Partner can activate redisputes.",
          },
          403,
        );
      if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 100)
        return reply({ error: "Provide 1–100 shipments." }, 400);
      const seen = new Set<string>();
      for (const row of b.rows) {
        if (
          !row ||
          typeof row !== "object" ||
          !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) ||
          typeof row.case_key !== "string" ||
          !row.case_key.trim() ||
          row.case_key.length > 200 ||
          !Number.isInteger(row.version) ||
          row.version < 0
        )
          return reply(
            {
              error:
                "Each row needs a loss month, Shipment ID and current version.",
            },
            400,
          );
        const key = `${row.month}|${row.case_key}`;
        if (seen.has(key))
          return reply(
            { error: "Remove duplicate shipments before activation." },
            400,
          );
        seen.add(key);
      }
      const results = [];
      for (const row of b.rows) {
        try {
          const window = await transition({ ...row, action: "activate" });
          results.push({
            month: row.month,
            case_key: row.case_key,
            ok: true,
            window,
          });
        } catch (e) {
          results.push({
            month: row.month,
            case_key: row.case_key,
            ok: false,
            error: e instanceof Error ? e.message : "Unable to activate.",
          });
        }
      }
      return reply({ results });
    }
    return reply({ window: await transition(b) });
  } catch (e) {
    return reply(
      { error: e instanceof Error ? e.message : "Unable to save response." },
      403,
    );
  }
}
