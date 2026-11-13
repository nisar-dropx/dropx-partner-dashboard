import { refreshLossPayroll } from "@/lib/ops-pulse/loss-payroll-refresh";
import { readAllRows } from "@/lib/supabase-pagination";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { recoveryContext } from "@/lib/ops-pulse/nl-recovery-context";
import {
  mayActivateRedispute,
  mayViewLossApprovals,
} from "@/lib/ops-pulse/loss-recovery-controls";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { stationEvidenceError } from "@/lib/ops-pulse/loss-station-evidence";
import { lscTicketError } from "@/lib/ops-pulse/loss-lsc-ticket";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
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
      true, // Preserve scoped history even when a later source import removes the case.
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
    if (!mayViewLossApprovals(ctx.auth) && !window.data)
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
        ctx.periodClosed || ctx.auth.readOnly || !hasPermission(ctx.auth, "ops_losses", "edit"),
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
    b.action !== "activate",
    b.action === "revoke",
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
    ...(b.action === "response" ? {
      cctv_url: b.cctv_not_required === true ? "" : String(b.cctv_url || "").trim(),
      cctv_not_required: b.cctv_not_required === true,
    } : {}),
    tt_reference: String(b.tt_reference || "").trim(),
    tt_url: String(b.tt_url || "").trim(),
    followup_on: b.followup_on || null,
    recovery_month: b.recovery_month || null,
  };
  if (b.action === "response") {
    const validationError = stationEvidenceError(details);
    if (validationError) throw Error(validationError);
  }
  if (b.action === "tracking") {
    const validationError = lscTicketError({...details, followup_on: String(details.followup_on || '')});
    if (validationError) throw Error(validationError);
  }
  if (b.action === "return" && (details.note.length < 10 || details.note.length > 4000))
    throw Error("Add a correction note for the station (10–4000 characters).");
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
  return {window: data, company: ctx.scope.company};
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
    if (b.action === "bulk_activate" || b.action === "bulk_update" || b.action === "bulk_tracking") {
      const auth = await getAuthorization();
      if (
        !auth || auth.readOnly ||
        !mayActivateRedispute(auth) ||
        !hasPermission(auth, "ops_losses", "access") ||
        !hasPermission(auth, "ops_losses", "edit")
      )
        return reply(
          {
            error:
              "Only SLP Manager, National Head, Finance Manager or Managing Partner can manage redisputes.",
          },
          403,
        );
      if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 100)
        return reply({ error: "Provide 1–100 shipments." }, 400);
      const ticketDetails = {
        tt_reference: String(b.tt_reference || '').trim(),
        tt_url: String(b.tt_url || '').trim(),
        followup_on: String(b.followup_on || ''),
        note: String(b.note || '').trim(),
      };
      if (b.action === 'bulk_tracking') {
        const error = lscTicketError(ticketDetails);
        if (error) return reply({error}, 400);
      }
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
        const action = b.action === 'bulk_tracking' ? 'tracking' : b.action === "bulk_activate" ? "activate" : row.action;
        if (!(b.action === 'bulk_tracking' ? ['tracking'] : ["activate","revoke"]).includes(action)) return reply({error:"Choose Enable or Disable for each shipment."},400);
        if (action === "revoke" && (typeof row.note !== "string" || row.note.trim().length < 10 || row.note.length > 4000)) return reply({error:"Disabling requires a reason (10–4000 characters)."},400);
        const key = `${row.month}|${row.case_key}`;
        if (seen.has(key))
          return reply(
            { error: "Remove duplicate shipments before saving." },
            400,
          );
        seen.add(key);
      }
      const companies = new Set<string>();
      const saveRow = async (row: Record<string, any>) => {
        try {
          const saved = await transition(b.action === 'bulk_tracking'
            ? {month: row.month, case_key: row.case_key, version: row.version, ...ticketDetails, action: 'tracking'}
            : { ...row, action: b.action === "bulk_activate" ? "activate" : row.action });
          companies.add(saved.company);
          return {
            month: row.month,
            case_key: row.case_key,
            ok: true,
            window: saved.window,
          };
        } catch (e) {
          return {
            month: row.month,
            case_key: row.case_key,
            ok: false,
            error: e instanceof Error ? e.message : "Unable to save.",
          };
        }
      };
      const results = [];
      // Bound independent per-case validation; the RPC serializes state changes under its company lock.
      const concurrency = b.action === 'bulk_tracking' ? 4 : 1;
      for (let i = 0; i < b.rows.length; i += concurrency) {
        results.push(...await Promise.all(b.rows.slice(i, i + concurrency).map(saveRow)));
      }
      const payroll_sync = b.action !== 'bulk_tracking' && companies.size ? await refreshLossPayroll([...companies][0]) : undefined;
      return reply({ results, payroll_sync });
    }
    const saved = await transition(b);
    const payroll_sync = ["activate", "revoke", "won", "lost"].includes(b.action)
      ? await refreshLossPayroll(saved.company) : undefined;
    return reply({ window: saved.window, payroll_sync });
  } catch (e) {
    return reply(
      { error: e instanceof Error ? e.message : "Unable to save response." },
      403,
    );
  }
}
