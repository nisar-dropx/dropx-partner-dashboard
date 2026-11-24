/**
 * DropX Dark Store — Site Summary Acceptance Time Monitor
 *
 * Polls Amazon Site Summary API directly for each store. When any order's
 * acceptance time exceeds the SLA threshold, sends a WhatsApp image+caption
 * to that station's war room via the Report Bot worker.
 *
 * No browser, no screenshot, no Gemini required.
 * Reads __Host-mons-* cookies from Firefox (same as fetch.mjs does for GC).
 *
 * Usage:
 *   node site-summary-monitor.mjs [--once] [--dry-run] [--store TTB3]
 *
 * Required env (set in .env or environment):
 *   WHATSAPP_WORKER_URL    https://dropx-report-bot.onrender.com
 *   WHATSAPP_WORKER_TOKEN  rbw_...
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY  (same as fetch.mjs — portal Live Performance)
 *
 * Optional env:
 *   ACCEPTANCE_THRESHOLD_SECONDS   default 15
 *   ALERT_COOLDOWN_MINUTES         default 5
 *   POLL_INTERVAL_SECONDS          default 60
 *   TESTING_GROUP_JID              override — send ALL alerts here instead of per-station groups
 *   AMAZON_STATION_GROUP_JIDS      TCC3:1203…@g.us,TCD4:…  (per-station war rooms)
 *   DARK_STORE_OPS_GROUP_JID       fallback if station JID missing
 *   COMPANY_ID                     defaults to DropX production company
 */

import { readFileSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { writeFile, mkdir, readFile } from "node:fs/promises";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── env ──────────────────────────────────────────────────────────────────────
const envPath = join(__dir, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.replace(/\r$/, "").match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const runOnce  = args.includes("--once");
const dryRun   = args.includes("--dry-run");
const argStore = args[args.indexOf("--store") + 1];

// ── Config ────────────────────────────────────────────────────────────────────
const THRESHOLD_S    = Math.max(1, Number(process.env.ACCEPTANCE_THRESHOLD_SECONDS ?? 15));
const COOLDOWN_MS    = Math.max(60, Number(process.env.ALERT_COOLDOWN_MINUTES ?? 5)) * 60_000;
const POLL_MS        = Math.max(10, Number(process.env.POLL_INTERVAL_SECONDS ?? 60)) * 1_000;
const WA_URL         = (process.env.WHATSAPP_WORKER_URL ?? "").replace(/\/$/, "");
const WA_TOKEN       = process.env.WHATSAPP_WORKER_TOKEN ?? "";
const TESTING_GROUP  = process.env.TESTING_GROUP_JID ?? "";   // set this to Dark Store Testing JID to test
const FALLBACK_GROUP = process.env.DARK_STORE_OPS_GROUP_JID ?? "";
const GC_BASE        = "https://eu.store-management.f3.amazon.dev";
const STATE_DIR      = join(__dir, ".site-summary-state");
const SUPABASE_URL   = (process.env.SUPABASE_URL || "https://uimajyffojydenqsegjv.supabase.co").replace(/\/$/, "");
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || "";
const COMPANY_ID     = process.env.COMPANY_ID || "43866344-b550-4e8a-9a2d-9d23f3d8a997";

// Per-station war room JIDs: TCC3:120363424408130632@g.us,TCD4:…
const stationGroupMap = Object.fromEntries(
  String(process.env.AMAZON_STATION_GROUP_JIDS ?? "")
    .split(",").map(p => p.trim()).filter(Boolean)
    .map(p => { const i = p.indexOf(":"); return i < 0 ? null : [p.slice(0, i).toUpperCase(), p.slice(i + 1)]; })
    .filter(Boolean)
);

// Store ID → station code (from HAR research)
const STORE_MAP = {
  "0ceba0d1-f003-43da-a231-8019e2aae710": "TTB3",
  "2a432cd6-032a-478e-9b63-bfc3965c5216": "TTG9",
  "2fa73ae0-c4c0-47cc-8609-dfe5c615e894": "TCC3",
  "16d2cf5c-1f72-4ce6-890b-18829eda7e98": "TCD4",
  "1435639d-7f28-478b-820b-619def7c267e": "TTA5",
  "46487da1-13b1-4c90-9c63-1f27572b966a": "TZC4",
  "f70fa43d-bcc3-4efd-8475-ef800adee1b1": "TFB7",
};
const CODE_TO_STORE = Object.fromEntries(Object.entries(STORE_MAP).map(([id, code]) => [code, id]));

const ALL_STATIONS = Object.values(STORE_MAP);
const STATIONS = argStore ? [argStore.toUpperCase()] : ALL_STATIONS;

// ── Firefox cookie reader (copied from fetch.mjs) ─────────────────────────────
async function readFirefoxCookie(host, name) {
  try {
    const appDataCandidates = [
      process.env.APPDATA,
      process.env.APPDATA?.replace(/^C:/, "D:"),
      `D:\\Users\\${process.env.USERNAME}\\AppData\\Roaming`,
      `C:\\Users\\${process.env.USERNAME}\\AppData\\Roaming`,
    ].filter(Boolean);
    let profilesDir = null;
    for (const base of appDataCandidates) {
      const c = join(base, "Mozilla", "Firefox", "Profiles");
      if (existsSync(c)) { profilesDir = c; break; }
    }
    if (!profilesDir) return null;
    const { readdirSync } = await import("node:fs");
    const profiles = readdirSync(profilesDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    const priority = ["default-esr", "default-release", "default"];
    const rank = p => { for (let i = 0; i < priority.length; i++) if (p.includes(priority[i])) return i + 1; return 99; };
    const sorted = [...profiles].sort((a, b) => rank(a) - rank(b));
    const { DatabaseSync } = await import("node:sqlite");
    for (const profileName of sorted) {
      const dbSrc = join(profilesDir, profileName, "cookies.sqlite");
      if (!existsSync(dbSrc)) continue;
      const dbTmp = join(tmpdir(), `ff-cookies-${Date.now()}.sqlite`);
      copyFileSync(dbSrc, dbTmp);
      for (const ext of ["-wal", "-shm"]) { if (existsSync(dbSrc + ext)) copyFileSync(dbSrc + ext, dbTmp + ext); }
      try {
        const db = new DatabaseSync(dbTmp);
        try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
        const row = db.prepare(
          "SELECT value FROM moz_cookies WHERE (host = ? OR host = ?) AND name = ? ORDER BY lastAccessed DESC LIMIT 1"
        ).get(host, `.${host}`, name);
        db.close();
        if (row?.value) return row.value;
      } catch { /* try next profile */ }
      finally {
        try { unlinkSync(dbTmp); } catch {}
        for (const ext of ["-wal", "-shm"]) { try { unlinkSync(dbTmp + ext); } catch {} }
      }
    }
    return null;
  } catch { return null; }
}

// ── Amazon auth cookies ───────────────────────────────────────────────────────
let _monsCookies = null;

async function getMonsCookies() {
  if (_monsCookies) return _monsCookies;
  const host = "eu.store-management.f3.amazon.dev";
  const names = ["__Host-mons-sid", "__Host-mons-ubid", "__Host-mons-st"];
  const vals = {};
  for (const name of names) {
    const v = await readFirefoxCookie(host, name);
    if (v) vals[name] = v;
  }
  if (!vals["__Host-mons-sid"]) throw new Error("__Host-mons-sid not found in Firefox cookies — open eu.store-management.f3.amazon.dev in Firefox first");
  _monsCookies = vals;
  return vals;
}

function buildCookieHeader(vals) {
  return Object.entries(vals).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ── API call ──────────────────────────────────────────────────────────────────
async function fetchSiteSummary(storeId, cookies) {
  const url = `${GC_BASE}/api/v1/searchactiveprocurementlistsummaries/${storeId}/search`;
  const r = await fetch(url, {
    headers: {
      "Cookie": buildCookieHeader(cookies),
      "Accept": "application/json",
      "Origin": GC_BASE,
      "Referer": `${GC_BASE}/siteSummary`,
    }
  });
  if (r.status === 401 || r.status === 403) {
    // st token may have rotated — clear cache so next call re-reads from Firefox
    _monsCookies = null;
    throw new Error(`Auth failed (${r.status}) for store ${storeId} — cookies may have expired, reopen eu.store-management.f3.amazon.dev in Firefox`);
  }
  if (!r.ok) throw new Error(`Site Summary API ${r.status} for ${storeId}: ${await r.text()}`);
  const data = await r.json();
  return data.procurementListSummaries ?? data.summaries ?? [];
}

// ── Acceptance time computation ───────────────────────────────────────────────
/** Amazon may return assignment epoch in seconds or milliseconds. */
function assignmentEpochSeconds(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // ms since epoch is ~1e12; seconds is ~1e9
  return n > 1e11 ? n / 1000 : n;
}

function orderOid(summary) {
  const raw = String(summary.fulfillmentId ?? summary.procurementListId ?? summary.orderId ?? "").trim();
  if (!raw) return null;
  const stripped = raw.replace(/^.+-/, "");
  // Prefer last 12 chars when available to cut collision risk vs last-6.
  return (stripped || raw).slice(-12);
}

function computeAcceptance(summaries) {
  const nowS = Date.now() / 1000;
  const pending = [];
  for (const s of summaries) {
    if (s.status !== "OFFERED" && s.status !== "UNASSIGNED") continue;
    const assignedAt = assignmentEpochSeconds(s.procurementListAssignmentTime ?? s.assignmentTime ?? 0);
    if (assignedAt == null) continue;
    const elapsedS = Math.max(0, nowS - assignedAt);
    const oid = orderOid(s);
    if (!oid) continue; // skip rows without a stable key — avoid collapsing onto "unknown"
    const picker = s.associateInfo?.associateId ?? s.associateInfo?.login ?? "Unassigned";
    const items = Number(s.totalItems ?? s.itemsToPick ?? 0);
    const pct = Number(s.percentComplete ?? s.pctComplete ?? s.completionPercentage ?? NaN);
    pending.push({
      oid,
      picker: String(picker),
      elapsedS,
      items,
      pctComplete: Number.isFinite(pct) ? pct : null,
      status: String(s.status ?? "")
    });
  }
  pending.sort((a, b) => b.elapsedS - a.elapsedS);
  return pending;
}

// ── Supabase ingest (portal Live Performance) ─────────────────────────────────
const SB_HEADERS = SUPABASE_KEY ? {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "resolution=merge-duplicates,return=minimal"
} : null;

async function sbUpsert(table, rows, onConflict) {
  if (!SB_HEADERS || !rows.length) return;
  if (dryRun) { console.log(`  [dry-run] upsert ${rows.length} → ${table}`); return; }
  const qs = onConflict ? `?on_conflict=${onConflict}` : "";
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${qs}`, {
    method: "POST",
    headers: SB_HEADERS,
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`Supabase upsert ${table}: ${r.status} ${await r.text()}`);
}

async function sbDelete(table, filter) {
  if (!SB_HEADERS) return;
  if (dryRun) { console.log(`  [dry-run] delete ${table}?${filter}`); return; }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: SB_HEADERS
  });
  if (!r.ok) throw new Error(`Supabase delete ${table}: ${r.status} ${await r.text()}`);
}

async function persistSiteSummary(stationCode, summaries, pending) {
  if (!SUPABASE_KEY) {
    console.warn(`[${stationCode}] SUPABASE_SERVICE_KEY missing — skip Live Performance upsert`);
    return;
  }
  const fetchedAt = new Date().toISOString();
  const breaching = pending.filter((o) => o.elapsedS >= THRESHOLD_S);
  const worst = pending[0]?.elapsedS ?? null;
  await sbUpsert("ds_site_summary_snapshots", [{
    company_id: COMPANY_ID,
    station_code: stationCode,
    fetched_at: fetchedAt,
    active_orders: summaries.length,
    pending_acceptance: pending.length,
    breaching_count: breaching.length,
    worst_elapsed_seconds: worst,
    sla_seconds: THRESHOLD_S,
    payload_json: {
      active: summaries.length,
      pending: pending.length,
      breaching: breaching.length,
      threshold_s: THRESHOLD_S
    }
  }], "company_id,station_code");

  const orderRows = pending.map((o) => ({
    company_id: COMPANY_ID,
    station_code: stationCode,
    oid: o.oid,
    picker: o.picker,
    items: o.items,
    elapsed_seconds: Math.round(o.elapsedS * 100) / 100,
    pct_complete: o.pctComplete,
    status: o.status,
    fetched_at: fetchedAt
  }));
  if (orderRows.length) {
    await sbUpsert("ds_site_summary_orders", orderRows, "company_id,station_code,oid");
  }
  // Drop OIDs that are no longer pending for this store.
  const keep = orderRows.map((r) => r.oid).filter(Boolean);
  if (keep.length) {
    const listed = keep.map((oid) => `"${String(oid).replace(/"/g, "")}"`).join(",");
    await sbDelete(
      "ds_site_summary_orders",
      `company_id=eq.${COMPANY_ID}&station_code=eq.${stationCode}&oid=not.in.(${listed})`
    );
  } else {
    await sbDelete(
      "ds_site_summary_orders",
      `company_id=eq.${COMPANY_ID}&station_code=eq.${stationCode}`
    );
  }
}

function fmtClock(s) {
  const sec = Math.round(s);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

// ── Image generation (satori + resvg) ─────────────────────────────────────────
async function buildAlertImage(stationCode, pendingOrders) {
  const { default: satori } = await import("satori");
  const { Resvg } = await import("@resvg/resvg-js");

  const worst = pendingOrders[0];
  const worstClock = fmtClock(worst.elapsedS);
  const slaClock   = fmtClock(THRESHOLD_S);
  const nowIST = new Date(Date.now() + 5.5 * 3600 * 1000);
  const timeLabel = `${String(nowIST.getUTCHours()).padStart(2,"0")}:${String(nowIST.getUTCMinutes()).padStart(2,"0")} IST`;

  // Load Inter font from the PPI cron dir (already on disk)
  const fontDir = join(__dir, "..", "..", "src", "app", "api", "cron", "dark-store-ppi");
  const regularFont = readFileSync(join(fontDir, "Inter-Regular.ttf")).buffer;
  const boldFont    = readFileSync(join(fontDir, "Inter-Bold.ttf")).buffer;

  const W = 600;
  const RED    = "#dc2626";
  const AMBER  = "#d97706";
  const BG     = "#fff";
  const HEADER = "#1e293b";

  const txt = (s, style = {}) => ({
    type: "span",
    props: { style: { fontFamily: "Inter", fontSize: 13, color: "#374151", ...style }, children: s }
  });

  const orderRows = pendingOrders.slice(0, 8).map((o, i) => ({
    type: "div",
    props: {
      style: {
        display: "flex", width: "100%",
        background: i % 2 === 0 ? "#f8fafc" : "#fff",
        borderBottom: "1px solid #e5e7eb", minHeight: 40, alignItems: "center"
      },
      children: [
        { type: "div", props: { style: { flex: 2, padding: "0 10px" }, children: txt(o.oid || "—") } },
        { type: "div", props: { style: { flex: 2, padding: "0 10px" }, children: txt(o.picker, { color: "#6b7280" }) } },
        { type: "div", props: { style: { flex: 1, padding: "0 10px", textAlign: "right" }, children:
          txt(String(o.items), { color: "#374151" }) } },
        { type: "div", props: { style: { flex: 2, padding: "0 10px", textAlign: "right" }, children:
          txt(`${fmtClock(o.elapsedS)} / ${slaClock}`, {
            color: o.elapsedS >= THRESHOLD_S ? RED : "#16a34a",
            fontWeight: 700,
          }) } },
      ]
    }
  }));

  const element = {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "column", width: W, background: BG, fontFamily: "Inter" },
      children: [
        // Header
        {
          type: "div",
          props: {
            style: { display: "flex", background: HEADER, padding: "14px 16px", alignItems: "center", justifyContent: "space-between" },
            children: [
              { type: "span", props: { style: { fontFamily: "Inter", fontSize: 20, fontWeight: 700, color: "#fff" }, children: stationCode } },
              { type: "span", props: { style: { fontFamily: "Inter", fontSize: 12, color: "#94a3b8" }, children: timeLabel } },
            ]
          }
        },
        // Alert banner
        {
          type: "div",
          props: {
            style: { display: "flex", background: "#fef2f2", borderLeft: `4px solid ${RED}`, padding: "10px 14px", alignItems: "center", gap: 8 },
            children: [
              { type: "span", props: { style: { fontFamily: "Inter", fontSize: 13, fontWeight: 700, color: RED }, children: `⚠ ${pendingOrders.length} order${pendingOrders.length > 1 ? "s" : ""} pending acceptance` } },
              { type: "span", props: { style: { fontFamily: "Inter", fontSize: 13, color: AMBER, fontWeight: 700 }, children: `Worst: ${worstClock}` } },
            ]
          }
        },
        // Table header
        {
          type: "div",
          props: {
            style: { display: "flex", background: RED, borderBottom: "1px solid #e5e7eb", minHeight: 36, alignItems: "center" },
            children: [
              { type: "div", props: { style: { flex: 2, padding: "0 10px" }, children: txt("OID", { color: "#fff", fontWeight: 700, fontSize: 12 }) } },
              { type: "div", props: { style: { flex: 2, padding: "0 10px" }, children: txt("Associate", { color: "#fff", fontWeight: 700, fontSize: 12 }) } },
              { type: "div", props: { style: { flex: 1, padding: "0 10px", textAlign: "right" }, children: txt("Items", { color: "#fff", fontWeight: 700, fontSize: 12 }) } },
              { type: "div", props: { style: { flex: 2, padding: "0 10px", textAlign: "right" }, children: txt("Acceptance / SLA", { color: "#fff", fontWeight: 700, fontSize: 12 }) } },
            ]
          }
        },
        // Order rows
        ...orderRows,
        // Footer
        {
          type: "div",
          props: {
            style: { display: "flex", padding: "10px 14px", background: "#f8fafc", borderTop: "1px solid #e5e7eb" },
            children: [
              { type: "span", props: { style: { fontFamily: "Inter", fontSize: 11, color: "#6b7280" }, children: "Site Summary Monitor · DropX OpsPulse" } }
            ]
          }
        }
      ]
    }
  };

  const svg = await satori(element, {
    width: W,
    fonts: [
      { name: "Inter", data: regularFont, weight: 400, style: "normal" },
      { name: "Inter", data: boldFont,    weight: 700, style: "normal" },
    ]
  });

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: W } });
  return resvg.render().asPng();
}

// ── WhatsApp send ─────────────────────────────────────────────────────────────
async function sendWhatsApp({ to, clientRef, imageBase64, caption }) {
  if (!WA_URL || !WA_TOKEN) throw new Error("WHATSAPP_WORKER_URL / WHATSAPP_WORKER_TOKEN not set");
  if (dryRun) {
    console.log(`  [dry-run] would send to ${to}: ${caption.split("\n")[0]}`);
    return { ok: true, dry_run: true };
  }
  const r = await fetch(`${WA_URL}/send`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_ref: clientRef, to, image_base64: imageBase64, mime: "image/png", caption })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`WhatsApp send failed (${r.status}): ${body}`);
  return JSON.parse(body || "{}");
}

// ── Cooldown state ────────────────────────────────────────────────────────────
// Key: stationCode — value: timestamp of last sent alert
const lastAlertAt = new Map();

function cooldownKey(station) { return station; }
function isOnCooldown(station) {
  const last = lastAlertAt.get(cooldownKey(station)) ?? 0;
  return Date.now() - last < COOLDOWN_MS;
}
function markSent(station) { lastAlertAt.set(cooldownKey(station), Date.now()); }

// ── Main poll ─────────────────────────────────────────────────────────────────
async function pollOnce() {
  let cookies;
  try {
    cookies = await getMonsCookies();
  } catch (e) {
    console.error(`[site-summary] Auth error: ${e.message}`);
    return;
  }

  for (const station of STATIONS) {
    const storeId = CODE_TO_STORE[station];
    if (!storeId) { console.warn(`[${station}] No storeId mapping — skipping`); continue; }

    try {
      const summaries = await fetchSiteSummary(storeId, cookies);
      const pending   = computeAcceptance(summaries);
      const breaching = pending.filter(o => o.elapsedS >= THRESHOLD_S);

      console.log(`[${station}] ${summaries.length} active orders, ${pending.length} pending acceptance, ${breaching.length} over ${THRESHOLD_S}s SLA`);

      try {
        await persistSiteSummary(station, summaries, pending);
      } catch (persistErr) {
        console.error(`[${station}] Live Performance upsert failed — ${persistErr.message}`);
      }

      if (breaching.length === 0) continue;
      if (isOnCooldown(station)) {
        console.log(`[${station}] On cooldown — skipping alert`);
        continue;
      }

      const worst = breaching[0];
      const worstClock = fmtClock(worst.elapsedS);
      const caption = [
        station,
        `* Acceptance time over ${THRESHOLD_S}s SLA (Worst ${worstClock})`,
        "",
        breaching.length > 1
          ? "Move more people to picking or ask people to accept fast"
          : "Ask the associate to accept the order fast"
      ].join("\n");

      const imagePng = await buildAlertImage(station, breaching);
      const imageBase64 = imagePng.toString("base64");

      const clientRef = `ssmon_${createHash("sha1").update(`${station}|${Math.floor(Date.now() / (COOLDOWN_MS))}`).digest("hex").slice(0, 20)}`;
      const to = TESTING_GROUP || stationGroupMap[station] || FALLBACK_GROUP;
      if (!to) { console.error(`[${station}] No WhatsApp group JID configured — skipping`); continue; }

      await sendWhatsApp({ to, clientRef, imageBase64, caption });
      markSent(station);
      console.log(`[${station}] Alert sent → ${to} (worst: ${worstClock})`);

    } catch (e) {
      console.error(`[${station}] Error: ${e.message}`);
      // If auth failed, re-read cookies next iteration
      if (/auth failed|expired/i.test(e.message)) _monsCookies = null;
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
await mkdir(STATE_DIR, { recursive: true }).catch(() => null);

console.log(`DropX Site Summary Monitor — stations: ${STATIONS.join(", ")} — threshold: ${THRESHOLD_S}s — interval: ${POLL_MS / 1000}s${dryRun ? " [DRY RUN]" : ""}`);
if (TESTING_GROUP) console.log(`  Testing mode: all alerts → ${TESTING_GROUP}`);

if (runOnce) {
  await pollOnce();
} else {
  while (true) {
    await pollOnce();
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
