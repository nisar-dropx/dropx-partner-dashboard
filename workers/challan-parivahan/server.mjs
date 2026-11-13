// DropX Fleet Challan worker.
// Standalone Node service (Docker) that pulls outstanding challans from the public
// Parivahan e-Challan "Check Status" portal for the fleet's OWN vehicles, using free
// local OCR for the captcha. Results are posted to the dashboard's authorized ingest
// webhook so all DB writes go through the proven, permission-scoped path. The worker
// never holds a DB connection open and runs independently of Vercel.
//
// Trigger: POST /pull  (Authorization: Bearer <CHALLAN_WORKER_SECRET>)
//   body (all optional): { companyId?, vehicleNos?: string[], limit?, dryRun?: boolean }
// Health: GET /health
import http from "node:http";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { ParivahanChallanClient, ParivahanError, parivahanIsOutstanding } from "./parivahan.mjs";
import { solveCaptcha, closeCaptcha } from "./captcha.mjs";

const PORT = Number(process.env.PORT || 8080);
const WORKER_SECRET = (process.env.CHALLAN_WORKER_SECRET || process.env.WORKER_SECRET || "").trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const DASHBOARD_INGEST_URL = (process.env.FLEET_CHALLAN_INGEST_URL || "").trim();
const INGEST_SECRET = (process.env.FLEET_CHALLAN_INGEST_SECRET || "").trim();
const DEFAULT_COMPANY_ID = (process.env.FLEET_DEFAULT_COMPANY_ID || "").trim();
// Be a courteous client of a government portal: pace vehicles apart.
const PER_VEHICLE_DELAY_MS = Math.max(1500, Number(process.env.CHALLAN_PER_VEHICLE_DELAY_MS || 4000));
const MAX_VEHICLES_PER_RUN = Math.max(1, Number(process.env.CHALLAN_MAX_VEHICLES_PER_RUN || 60));
const MAX_CAPTCHA_ATTEMPTS = Math.max(1, Number(process.env.CHALLAN_MAX_CAPTCHA_ATTEMPTS || 12));

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (v) => String(v ?? "").trim();

function authorized(req) {
  if (!WORKER_SECRET) return false;
  const header = req.headers["authorization"] || "";
  const expected = `Bearer ${WORKER_SECRET}`;
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** Read the OWN, active vehicles (with registration dates) that we can check. */
async function loadOwnedVehicles(companyId, vehicleNos, limit) {
  if (!supabase) throw new Error("Supabase is not configured on the worker.");
  let query = supabase
    .from("fleet_vehicles")
    .select("id,vehicle_no,station_code,ownership_type,status,registration_date,company_id")
    .or("status.is.null,status.neq.archived");
  if (companyId) query = query.eq("company_id", companyId);
  if (Array.isArray(vehicleNos) && vehicleNos.length) {
    query = query.in("vehicle_no", vehicleNos.map((v) => clean(v).toUpperCase()));
  }
  const { data, error } = await query.limit(1000);
  if (error) throw new Error(`Vehicle load failed: ${error.message}`);
  const owned = (data || []).filter(
    (row) => clean(row.ownership_type || "own").toLowerCase() === "own"
  );
  const capped = owned.slice(0, Math.min(limit || MAX_VEHICLES_PER_RUN, MAX_VEHICLES_PER_RUN));
  return capped;
}

// The data authority for every Parivahan e-Challan record is the National
// Informatics Centre (NIC), which runs the MoRTH Parivahan platform. The DB
// stores a coded enum ('parivahan'); the UI shows the NIC/Parivahan label.
// challanSource only hints at the enforcing unit, kept in rawPayload.
const AUTHORITY_CODE = "parivahan";
function enforcingUnit(challanSource) {
  if (challanSource === 1) return "MVD / Traffic enforcement";
  if (challanSource === 5) return "State Traffic Police";
  return "MVD / Parivahan";
}

/** Post a batch of challan rows to the dashboard ingest webhook (handles Drive + upsert there). */
async function postToIngest(companyId, rows) {
  if (!DASHBOARD_INGEST_URL || !INGEST_SECRET) {
    return { ok: false, skipped: true, reason: "ingest URL/secret not configured" };
  }
  const res = await fetch(DASHBOARD_INGEST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_SECRET}` },
    body: JSON.stringify({ companyId: companyId || undefined, challans: rows }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: json };
}

/** Pull challans for every owned vehicle and ingest the outstanding ones. */
async function runPull({ companyId, vehicleNos, limit, dryRun }) {
  const started = Date.now();
  const effectiveCompany = companyId || DEFAULT_COMPANY_ID;
  const vehicles = await loadOwnedVehicles(effectiveCompany, vehicleNos, limit);

  const summary = {
    requestedCompany: effectiveCompany || null,
    vehiclesConsidered: vehicles.length,
    checked: 0,
    withChallans: 0,
    challansFound: 0,
    challansIngested: 0,
    skippedNoRcDate: 0,
    errors: [],
  };
  const perVehicle = [];

  const client = new ParivahanChallanClient({
    captchaSolver: solveCaptcha,
    maxCaptchaAttempts: MAX_CAPTCHA_ATTEMPTS,
  });

  for (const v of vehicles) {
    const vehicleNo = clean(v.vehicle_no).toUpperCase();
    if (!clean(v.registration_date)) {
      summary.skippedNoRcDate += 1;
      perVehicle.push({ vehicleNo, skipped: "no_registration_date" });
      continue;
    }
    try {
      const result = await client.pullVehicle(vehicleNo, v.registration_date);
      summary.checked += 1;
      const outstanding = result.challans.filter((c) => parivahanIsOutstanding(c.paymentStatus));
      if (outstanding.length) summary.withChallans += 1;
      summary.challansFound += outstanding.length;

      const rows = [];
      for (const c of outstanding) {
        let evidenceUrl = null;
        let evidenceBase64 = null;
        let evidenceExt = null;
        try {
          const ev = await client.evidence(c.challanNo);
          if (ev?.sourceUrl) {
            evidenceUrl = ev.sourceUrl; // dashboard streams URL→Drive
            evidenceExt = ev.fileExt;
          } else if (ev?.inlineBase64) {
            evidenceBase64 = ev.inlineBase64; // dashboard uploads inline bytes→Drive
            evidenceExt = ev.fileExt;
          }
        } catch {
          /* evidence is best-effort */
        }
        rows.push({
          companyId: v.company_id || effectiveCompany || undefined,
          vehicleNo,
          challanNumber: c.challanNo,
          amount: c.amount,
          offenseDate: c.challanDate ? c.challanDate.slice(0, 10) : null,
          offenseAt: c.challanDate || null,
          offenseDescription: c.offenceSummary,
          issuingAuthority: AUTHORITY_CODE,
          source: "portal_sync",
          stateCode: c.stateCode,
          evidenceUrl,
          evidenceBase64,
          evidenceExt,
          portalStatus: c.paymentStatus,
          rawPayload: {
            ...c,
            source: "parivahan",
            enforcingUnit: enforcingUnit(c.challanSource),
            pulledAt: new Date().toISOString(),
          },
        });
      }

      let ingestResult = null;
      if (rows.length && !dryRun) {
        ingestResult = await postToIngest(v.company_id || effectiveCompany, rows);
        if (ingestResult.ok) summary.challansIngested += rows.length;
      }
      perVehicle.push({
        vehicleNo,
        statusCode: result.statusCode,
        outstanding: outstanding.length,
        ingested: ingestResult?.ok ? rows.length : 0,
        ingestError: ingestResult && !ingestResult.ok ? ingestResult : undefined,
      });
    } catch (err) {
      const code = err instanceof ParivahanError ? err.code : "ERROR";
      summary.errors.push({ vehicleNo, code, message: err.message });
      perVehicle.push({ vehicleNo, error: code, message: err.message });
    }
    await sleep(PER_VEHICLE_DELAY_MS);
  }

  summary.durationMs = Date.now() - started;
  return { summary, perVehicle, dryRun: Boolean(dryRun) };
}

let running = false;

const server = http.createServer(async (req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && req.url === "/health") {
    return send(200, {
      ok: true,
      service: "challan-parivahan",
      supabase: Boolean(supabase),
      ingestConfigured: Boolean(DASHBOARD_INGEST_URL && INGEST_SECRET),
      running,
    });
  }

  if (req.method === "POST" && (req.url === "/pull" || req.url?.startsWith("/pull?"))) {
    if (!authorized(req)) return send(401, { error: "Unauthorized" });
    if (!supabase) return send(500, { error: "Supabase not configured." });
    if (running) return send(409, { error: "A challan pull is already running." });
    running = true;
    try {
      const body = await readJson(req);
      const result = await runPull({
        companyId: clean(body.companyId) || undefined,
        vehicleNos: Array.isArray(body.vehicleNos) ? body.vehicleNos : undefined,
        limit: Number(body.limit) || undefined,
        dryRun: Boolean(body.dryRun),
      });
      return send(200, { ok: true, ...result });
    } catch (err) {
      return send(500, { ok: false, error: err instanceof Error ? err.message : "Pull failed." });
    } finally {
      running = false;
    }
  }

  return send(404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[challan-parivahan] listening on :${PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    await closeCaptcha();
    server.close(() => process.exit(0));
  });
}
