/**
 * For NL cases whose OpsPulse dispute is submitted/filed, pull live Cloak
 * case + dispute rows and overwrite nl_loss_month_cases.details from Cloak.
 *
 * Usage: node scripts/sync-cloak-dispute-truth.mjs [--month=2026-10] [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const CLOAK = "https://cloak.tech.amazon.dev";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const DRY = process.argv.includes("--dry");
const monthArg = process.argv.find((a) => a.startsWith("--month="));
const MONTH = monthArg ? monthArg.slice("--month=".length) : null;

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function istFromEpochMs(value) {
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

function pickLatestDispute(rows, tid) {
  const list = (Array.isArray(rows) ? rows : []).filter((d) => d?.tid === tid);
  if (!list.length) return null;
  return [...list].sort((a, b) => Number(b.revision || 0) - Number(a.revision || 0))[0];
}

function pickDisputeForRequest(rows, tid, sourceStage) {
  const list = (Array.isArray(rows) ? rows : []).filter((d) => d?.tid === tid);
  if (!list.length) return null;
  const want = sourceStage === "eDSP2" ? "2" : sourceStage === "eDSP1" ? "1" : null;
  if (want) {
    const match = list.find((d) => String(d.revision ?? "") === want);
    if (match) return match;
    if (sourceStage === "eDSP2") return null;
  }
  return pickLatestDispute(list, tid);
}

const root = path.resolve(import.meta.dirname, "..");
const env = {
  ...loadEnv(path.join(root, "../../Workforce-worker/.dev.vars")),
  ...loadEnv(path.join(root, "../../amazon-edd-worker/.dev.vars")),
};
const db = createClient(
  env.COMPANY_SUPABASE_URL || env.SUPABASE_URL,
  env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const { data: cookieRow, error: cookieErr } = await db
  .from("cloak_sessions")
  .select("cookie")
  .eq("status", "active")
  .eq("account_key", "default")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
if (cookieErr || !cookieRow?.cookie) {
  console.error("No active Cloak session.");
  process.exit(1);
}
const cookie = cookieRow.cookie;
const headers = {
  accept: "application/json, text/plain, */*",
  cookie,
  referer: `${CLOAK}/`,
  "user-agent": UA,
};

async function cloakGet(apiPath, params) {
  const res = await fetch(`${CLOAK}${apiPath}?${new URLSearchParams(params)}`, {
    headers,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${apiPath} → ${res.status}`);
  return res.json();
}

let reqQuery = db
  .from("nl_dispute_requests")
  .select(
    "company_id,month,case_key,status,decision,source_stage,version,updated_by,updated_by_name",
  )
  .in("status", ["submitted", "filed"])
  .order("submitted_at", { ascending: true })
  .limit(400);
if (MONTH) reqQuery = reqQuery.eq("month", MONTH);
const { data: requests, error: reqErr } = await reqQuery;
if (reqErr) {
  console.error(reqErr);
  process.exit(1);
}

const rows = requests ?? [];
console.log(
  `Syncing Cloak truth for ${rows.length} request(s)${MONTH ? ` in ${MONTH}` : ""}${DRY ? " (dry)" : ""}`,
);

const results = [];
for (const req of rows) {
  const label = `${req.month} ${req.case_key}`;
  try {
    const { data: caseRow, error: caseErr } = await db
      .from("nl_loss_month_cases")
      .select("details,source_status")
      .eq("company_id", req.company_id)
      .eq("report", "nl")
      .eq("month", req.month)
      .eq("case_key", req.case_key)
      .maybeSingle();
    if (caseErr || !caseRow) throw new Error("Case row missing.");
    const details = caseRow.details ?? {};
    const tid = String(details.tid || req.case_key);
    if (!/^[A-Za-z0-9]{6,40}$/.test(tid)) throw new Error("No usable TID.");

    const [tidJson, dispJson] = await Promise.all([
      cloakGet("/api/v1/getTIDData", { tid, country: "IN" }),
      cloakGet("/api/v1/getDisputeDetails", {
        tid,
        dataSource: "live",
        country: "IN",
      }),
    ]);
    const liveRows = (tidJson?.data ?? []).filter((r) => r?.tid === tid);
    const live = liveRows[0];
    if (liveRows.length !== 1 || !live)
      throw new Error("Cloak does not list this TID live.");
    const dispute = pickDisputeForRequest(dispJson, tid, req.source_stage);
    const extra = { ...(details.extra ?? {}) };
    for (const [k, v] of Object.entries(live)) {
      if (v == null || v === "") continue;
      if (typeof v === "object") continue;
      const key = String(k);
      if (["tid", "station", "value", "loss_bucket", "loss_sub_bucket", "impact_date", "da_name", "loss_remarks", "recovery_month", "case_status"].includes(key))
        continue;
      extra[key] = String(v).slice(0, 500);
    }
    extra.current_sla_stage = String(live.current_sla_stage ?? extra.current_sla_stage ?? "");
    if (live.nl_status) extra.nl_status = String(live.nl_status);

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
      ]) {
        if (dispute[key] != null && dispute[key] !== "")
          extra[key] = String(dispute[key]).slice(0, 2000);
      }
      if (dispute.nl_remarks_time) {
        const ist = istFromEpochMs(dispute.nl_remarks_time);
        if (ist) extra.nl_remarks_time_ist = ist;
      }
    } else if (req.status === "submitted") {
      // Stage/status only until this round's revision exists in Cloak.
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
      String(live.nl_status || dispute?.nl_status || caseRow.source_status || "").trim() ||
      caseRow.source_status;

    if (DRY) {
      results.push({
        label,
        ok: true,
        dry: true,
        stage: extra.current_sla_stage,
        revision: extra.revision,
        dispute_selected: extra.dispute_selected,
        reason: extra.dispute_reason,
      });
      console.log(
        `DRY ${label} stage=${extra.current_sla_stage} rev=${extra.revision} selected=${extra.dispute_selected}`,
      );
      continue;
    }

    const { error: upErr } = await db
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

    if (req.status === "submitted" && dispute?.dispute_selected) {
      const want = req.decision === "dispute" ? "YES" : "NO";
      const held = String(extra.dispute_selected || "").toUpperCase();
      const revision = String(extra.revision || "");
      const roundOk =
        req.source_stage === "eDSP2"
          ? revision === "2" && held === "YES"
          : held === want && (revision === "1" || revision === "2");
      if (roundOk) {
        await db.rpc("save_nl_dispute_request", {
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

    results.push({
      label,
      ok: true,
      stage: extra.current_sla_stage,
      revision: extra.revision,
      dispute_selected: extra.dispute_selected,
    });
    console.log(
      `OK ${label} stage=${extra.current_sla_stage} rev=${extra.revision} selected=${extra.dispute_selected}`,
    );
  } catch (e) {
    results.push({ label, ok: false, error: String(e?.message || e) });
    console.log(`FAIL ${label}: ${e?.message || e}`);
  }
}

const ok = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ ok, fail, results }, null, 2));
process.exit(fail ? 2 : 0);
