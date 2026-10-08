import { disputeContext } from "@/lib/ops-pulse/nl-live";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const STATION_ACTIONS = ["save", "submit", "withdraw"];
const DESK_ACTIONS = ["return", "file"];

/** A case's dispute request and its full history. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url),
      month = url.searchParams.get("month") || "";
    const { company, caseKey, gate } = await disputeContext(
      month,
      url.searchParams.get("case") || "",
      "view",
    );
    const [current, history] = await Promise.all([
      supabaseAdmin!
        .from("nl_dispute_requests")
        .select("*")
        .eq("company_id", company)
        .eq("month", month)
        .eq("case_key", caseKey)
        .maybeSingle(),
      readAllRows(
        supabaseAdmin!
          .from("nl_dispute_request_events")
          .select("id,action,snapshot,actor_name,created_at")
          .eq("company_id", company)
          .eq("month", month)
          .eq("case_key", caseKey)
          .order("created_at", { ascending: false }),
      ),
    ]);
    if (current.error || history.error)
      throw Error("Dispute details could not be loaded.");
    return reply({ request: current.data, history: history.data ?? [], gate });
  } catch (e) {
    return reply(
      { error: e instanceof Error ? e.message : "Unable to load dispute." },
      403,
    );
  }
}

export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      return reply({ error: "Invalid request origin." }, 403);
    const body = await request.json();
    const action = String(body.action || "");
    const desk = DESK_ACTIONS.includes(action);
    if (!desk && !STATION_ACTIONS.includes(action))
      return reply({ error: "Unknown dispute action." }, 400);
    if (!Number.isInteger(body.version) || body.version < 0)
      return reply({ error: "Invalid dispute version." }, 400);
    const month = String(body.month || "");
    const { auth, company, caseKey, gate } = await disputeContext(
      month,
      String(body.case_key || ""),
      desk ? "desk" : "station",
    );
    const input = (body.values ?? {}) as Record<string, unknown>;
    // The window only limits what a station may still send; the desk can always return or file.
    if ((action === "save" || action === "submit") && !gate.open)
      return reply({ error: gate.reason || "The dispute window is closed." }, 409);
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const values = desk
      ? { desk_note: text(input.desk_note) }
      : {
          decision: text(input.decision),
          // An accepted loss carries no dispute content.
          ...(input.decision === "accept"
            ? { reason: "", remarks: text(input.remarks), cctv_url: "", attachments: [] }
            : {
                reason: text(input.reason),
                remarks: text(input.remarks),
                cctv_url: text(input.cctv_url),
                attachments: (Array.isArray(input.attachments) ? input.attachments : [])
                  .slice(0, 10)
                  .map((a) => ({ id: text(a?.id), file_name: text(a?.file_name).slice(0, 200) })),
              }),
        };
    const result = await supabaseAdmin!.rpc("save_nl_dispute_request", {
      p_company: company,
      p_month: month,
      p_case: caseKey,
      p_version: body.version,
      p_action: action,
      p_values: values,
      p_actor: auth.userId,
      p_name: auth.fullName || auth.email || "OpsPulse user",
    });
    if (result.error)
      return reply(
        {
          error:
            result.error.code === "P0001"
              ? result.error.message
              : "Dispute could not be saved. Refresh and try again.",
        },
        409,
      );
    return reply({ request: result.data });
  } catch (e) {
    return reply(
      { error: e instanceof Error ? e.message : "Dispute could not be saved." },
      403,
    );
  }
}
