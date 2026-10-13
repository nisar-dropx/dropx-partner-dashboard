import { CloakError } from "@/lib/ops-pulse/cloak-client";
import { buildCloakProof, fileDisputeInCloak } from "@/lib/ops-pulse/cloak-dispute";
import {
  cloakFilingBlock,
  cloakRemarks,
  type DisputeRequest,
} from "@/lib/ops-pulse/nl-dispute-policy";
import { disputeContext } from "@/lib/ops-pulse/nl-live";
import type { NlCase } from "@/lib/ops-pulse/nl-loss-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
export const dynamic = "force-dynamic";
// Filing in Cloak is several portal calls plus the proof upload.
export const maxDuration = 60;
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const STATION_ACTIONS = ["save", "submit", "withdraw"];
// file = the desk filed it in Cloak by hand; file_cloak = OpsPulse files it in Cloak now.
const DESK_ACTIONS = ["return", "file", "file_cloak"];

/** Sends a station's dispute to Cloak. Returns the desk note that records how it was filed. */
async function fileInCloak(company: string, month: string, caseKey: string, version: number, details: NlCase["details"]) {
  const current = await supabaseAdmin!
    .from("nl_dispute_requests")
    .select("*")
    .eq("company_id", company)
    .eq("month", month)
    .eq("case_key", caseKey)
    .maybeSingle();
  const request = current.data as DisputeRequest | null;
  if (current.error || (request?.version ?? 0) !== version)
    throw Error("Another person updated this dispute. Refresh before filing.");
  const block = cloakFilingBlock(request, details.extra?.current_sla_stage);
  if (block) throw Error(block);
  const ids = request!.attachments.map((a) => a.id);
  const stored = ids.length
    ? await supabaseAdmin!
        .from("nl_recovery_attachments")
        .select("id,storage_bucket,storage_path,content_type")
        .eq("company_id", company)
        .eq("month", month)
        .eq("case_key", caseKey)
        .in("id", ids)
    : { data: [], error: null };
  if (stored.error || (stored.data ?? []).length !== ids.length)
    throw Error("The proof files could not be read. Please retry.");
  const files = [];
  // Keep the station's order: it is the page order Amazon reads.
  for (const id of ids) {
    const row = stored.data!.find((r) => r.id === id)!;
    const file = await supabaseAdmin!.storage.from(row.storage_bucket).download(row.storage_path);
    if (file.error || !file.data) throw Error("The proof files could not be read. Please retry.");
    files.push({
      bytes: new Uint8Array(await file.data.arrayBuffer()),
      contentType: String(row.content_type || file.data.type),
    });
  }
  const proof = await buildCloakProof(files).catch(() => {
    throw Error("The proof files could not be combined into one PDF. File this dispute in Cloak by hand.");
  });
  const filed = await fileDisputeInCloak({
    tid: String(details.tid ?? ""),
    reason: request!.reason,
    remarks: cloakRemarks(request!.remarks, request!.cctv_url),
    proof,
  });
  return filed.alreadyFiled
    ? "Already filed in Cloak — nothing was sent again."
    : `Filed in Cloak from OpsPulse${filed.proofKey ? ` with proof ${filed.proofKey}` : " without a proof file"}.`;
}

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
    const { auth, company, caseKey, gate, details } = await disputeContext(
      month,
      String(body.case_key || ""),
      desk ? "desk" : "station",
    );
    const input = (body.values ?? {}) as Record<string, unknown>;
    // The window only limits what a station may still send; the desk can always return or file.
    if ((action === "save" || action === "submit") && !gate.open)
      return reply({ error: gate.reason || "The dispute window is closed." }, 409);
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    let cloakNote = "";
    if (action === "file_cloak") {
      try {
        cloakNote = await fileInCloak(company, month, caseKey, body.version, details);
      } catch (e) {
        return reply(
          { error: e instanceof Error ? e.message : "The dispute could not be filed in Cloak." },
          e instanceof CloakError && e.code !== "STATE" ? 502 : 409,
        );
      }
    }
    const values = desk
      ? { desk_note: cloakNote || text(input.desk_note) }
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
      p_action: cloakNote ? "file" : action,
      p_values: values,
      p_actor: auth.userId,
      p_name: auth.fullName || auth.email || "OpsPulse user",
    });
    if (result.error)
      return reply(
        {
          error: cloakNote
            ? // Cloak has it; the hourly pull marks the request filed on its own.
              "The dispute is filed in Cloak, but OpsPulse could not record it. It will show as filed after the next hourly check."
            : result.error.code === "P0001"
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
