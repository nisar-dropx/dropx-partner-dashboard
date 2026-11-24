import "server-only";
import { cloakGet } from "./cloak-client";
import { supabaseAdmin } from "@/lib/supabase-admin";

type CloakDispute = {
  tid?: string;
  revision?: string | null;
  dispute_selected?: string | null;
  dispute_reason?: string | null;
  partner_remarks?: string | null;
  dispute_proof?: string | null;
  disputed_by?: string | null;
  disputed_time?: string | null;
  nl_remarks?: string | null;
  nl_res?: string | null;
  nl_remarks_by?: string | null;
  nl_remarks_time?: string | null;
  nl_status?: string | null;
  lm_remarks?: string | null;
  lm_status?: string | null;
};

type CloakCase = {
  tid?: string;
  case_status?: string | null;
  current_sla_stage?: string | null;
  nl_status?: string | null;
  [key: string]: unknown;
};

const SKIP_LIVE_KEYS = new Set([
  "tid",
  "station",
  "value",
  "loss_bucket",
  "loss_sub_bucket",
  "impact_date",
  "da_name",
  "loss_remarks",
  "recovery_month",
  "case_status",
]);

function istFromEpochMs(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function pickLatestDispute(rows: CloakDispute[] | null | undefined, tid: string) {
  const list = (Array.isArray(rows) ? rows : []).filter((d) => d?.tid === tid);
  if (!list.length) return null;
  return [...list].sort(
    (a, b) => Number(b.revision || 0) - Number(a.revision || 0),
  )[0]!;
}

/** Prefer the revision that matches this OpsPulse round (eDSP2 → rev 2). */
function pickDisputeForRequest(
  rows: CloakDispute[] | null | undefined,
  tid: string,
  sourceStage: string | null | undefined,
) {
  const list = (Array.isArray(rows) ? rows : []).filter((d) => d?.tid === tid);
  if (!list.length) return null;
  const want = sourceStage === "eDSP2" ? "2" : sourceStage === "eDSP1" ? "1" : null;
  if (want) {
    const match = list.find((d) => String(d.revision ?? "") === want);
    if (match) return match;
    // eDSP2 still open: do not fall back to rev 1 or we mark the response filed too early.
    if (sourceStage === "eDSP2") return null;
  }
  return pickLatestDispute(list, tid);
}

/**
 * Overwrite OpsPulse case details from live Cloak case + dispute APIs.
 * Used when a station request is already with/filed in Cloak so OpsPulse
 * does not keep showing stale bulk-CSV revision/stage fields.
 */
export async function syncCloakDisputeTruth(opts?: {
  month?: string;
  limit?: number;
}) {
  if (!supabaseAdmin) throw new Error("Database unavailable.");
  let query = supabaseAdmin
    .from("nl_dispute_requests")
    .select(
      "company_id,month,case_key,status,decision,source_stage,version,updated_by,updated_by_name",
    )
    .in("status", ["submitted", "filed"])
    .order("submitted_at", { ascending: true })
    .limit(opts?.limit ?? 200);
  if (opts?.month) query = query.eq("month", opts.month);
  const { data: requests, error } = await query;
  if (error) throw new Error(error.message);
  const rows = requests ?? [];
  let okCount = 0;
  let fail = 0;
  const errors: { case_key: string; error: string }[] = [];

  for (const req of rows) {
    try {
      const { data: caseRow, error: caseErr } = await supabaseAdmin
        .from("nl_loss_month_cases")
        .select("details,source_status")
        .eq("company_id", req.company_id)
        .eq("report", "nl")
        .eq("month", req.month)
        .eq("case_key", req.case_key)
        .maybeSingle();
      if (caseErr || !caseRow) throw new Error("Case row missing.");
      const details = (caseRow.details ?? {}) as Record<string, unknown> & {
        tid?: string;
        case_status?: string;
        extra?: Record<string, string>;
      };
      const tid = String(details.tid || req.case_key);
      if (!/^[A-Za-z0-9]{6,40}$/.test(tid)) throw new Error("No usable TID.");

      const [list, disputes] = await Promise.all([
        cloakGet<{ data?: CloakCase[] }>("/api/v1/getTIDData", {
          tid,
          country: "IN",
        }),
        cloakGet<CloakDispute[]>("/api/v1/getDisputeDetails", {
          tid,
          dataSource: "live",
          country: "IN",
        }),
      ]);
      const liveRows = (list.data ?? []).filter((r) => r?.tid === tid);
      const live = liveRows[0];
      if (liveRows.length !== 1 || !live)
        throw new Error("Cloak does not list this TID live.");
      const dispute = pickDisputeForRequest(disputes, tid, req.source_stage);

      const extra: Record<string, string> = { ...(details.extra ?? {}) };
      for (const [k, v] of Object.entries(live)) {
        if (v == null || v === "" || typeof v === "object") continue;
        if (SKIP_LIVE_KEYS.has(k)) continue;
        extra[k] = String(v).slice(0, 500);
      }
      if (live.current_sla_stage)
        extra.current_sla_stage = String(live.current_sla_stage);
      if (live.nl_status) extra.nl_status = String(live.nl_status);

      // Apply dispute fields only when Cloak has the revision for this OpsPulse round.
      if (dispute?.dispute_selected) {
        extra.dispute_selected = String(dispute.dispute_selected).toUpperCase();
        if (dispute.dispute_reason != null)
          extra.dispute_reason = String(dispute.dispute_reason).slice(0, 500);
        if (dispute.partner_remarks != null)
          extra.partner_remarks = String(dispute.partner_remarks).slice(0, 2000);
        if (dispute.dispute_proof != null)
          extra.dispute_proof = String(dispute.dispute_proof).slice(0, 500);
        if (dispute.revision != null) extra.revision = String(dispute.revision);
        if (dispute.disputed_by != null)
          extra.disputed_by = String(dispute.disputed_by).slice(0, 200);
        if (dispute.disputed_time != null) {
          extra.disputed_time = String(dispute.disputed_time);
          const ist = istFromEpochMs(dispute.disputed_time);
          if (ist) extra.disputed_time_ist = ist;
        }
        for (const key of [
          "nl_remarks",
          "nl_res",
          "nl_remarks_by",
          "nl_remarks_time",
          "nl_status",
          "lm_remarks",
          "lm_status",
        ] as const) {
          if (dispute[key] != null && dispute[key] !== "")
            extra[key] = String(dispute[key]).slice(0, 2000);
        }
        if (dispute.nl_remarks_time) {
          const ist = istFromEpochMs(dispute.nl_remarks_time);
          if (ist) extra.nl_remarks_time_ist = ist;
        }
      } else if (req.status === "submitted") {
        // Live case stage/status still sync; leave dispute fields alone until this round exists.
        const nextDetails = {
          ...details,
          case_status: live.case_status ?? details.case_status,
          tid,
          extra,
        };
        const sourceStatus =
          String(live.nl_status || caseRow.source_status || "").trim() ||
          caseRow.source_status;
        const { error: upErr } = await supabaseAdmin
          .from("nl_loss_month_cases")
          .update({
            details: nextDetails,
            source_status: sourceStatus,
            last_seen_at: new Date().toISOString(),
            source_updated_at: new Date().toISOString(),
          })
          .eq("company_id", req.company_id)
          .eq("report", "nl")
          .eq("month", req.month)
          .eq("case_key", req.case_key);
        if (upErr) throw new Error(upErr.message);
        okCount += 1;
        continue;
      } else {
        throw new Error("Cloak has no dispute decision for this TID.");
      }

      const nextDetails = {
        ...details,
        case_status: live.case_status ?? details.case_status,
        tid,
        extra,
      };
      const sourceStatus =
        String(
          live.nl_status || dispute.nl_status || caseRow.source_status || "",
        ).trim() || caseRow.source_status;

      const { error: upErr } = await supabaseAdmin
        .from("nl_loss_month_cases")
        .update({
          details: nextDetails,
          source_status: sourceStatus,
          last_seen_at: new Date().toISOString(),
          source_updated_at: new Date().toISOString(),
        })
        .eq("company_id", req.company_id)
        .eq("report", "nl")
        .eq("month", req.month)
        .eq("case_key", req.case_key);
      if (upErr) throw new Error(upErr.message);

      if (req.status === "submitted") {
        const want = req.decision === "dispute" ? "YES" : "NO";
        const held = String(extra.dispute_selected || "").toUpperCase();
        const revision = String(extra.revision || "");
        const roundOk =
          req.source_stage === "eDSP2"
            ? revision === "2" && held === "YES"
            : held === want && (revision === "1" || revision === "2");
        if (roundOk) {
          await supabaseAdmin.rpc("save_nl_dispute_request", {
            p_company: req.company_id,
            p_month: req.month,
            p_case: req.case_key,
            p_version: req.version,
            p_action: "file",
            p_values: {
              desk_note: `Synced from Cloak (revision ${extra.revision || "?"} · ${extra.dispute_selected}).`,
            },
            p_actor: req.updated_by,
            p_name: req.updated_by_name || "Cloak sync",
          });
        }
      }
      okCount += 1;
    } catch (e) {
      fail += 1;
      errors.push({
        case_key: req.case_key,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { okCount, fail, checked: rows.length, errors: errors.slice(0, 20) };
}
