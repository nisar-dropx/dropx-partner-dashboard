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
import {
  DEFAULT_PICK_SLA,
  emptyAssociates,
  mapActiveOrders as mapActiveOrdersBase,
  parseLaborAssociates
} from "./site-summary-map.mjs";

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
const runOnce = args.includes("--once");
const dryRun = args.includes("--dry-run");
const debugAuth = args.includes("--debug-auth");
const storeFlagIdx = args.indexOf("--store");
const argStore = storeFlagIdx >= 0 ? String(args[storeFlagIdx + 1] ?? "").trim() : "";
if (storeFlagIdx >= 0 && (!argStore || argStore.startsWith("--"))) {
  console.error("Usage: node site-summary-monitor.mjs [--once] [--dry-run] [--debug-auth] [--store TTB3]");
  process.exit(1);
}

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

// ── Firefox cookie reader ─────────────────────────────────────────────────────
// WorkSpaces often has Firefox profiles on both C: and D:. Never stop at the first
// Profiles folder — pick the cookie with the newest lastAccessed across all of them.
function firefoxProfileRoots() {
  const bases = [
    process.env.APPDATA,
    process.env.APPDATA?.replace(/^C:/i, "D:"),
    process.env.APPDATA?.replace(/^D:/i, "C:"),
    `D:\\Users\\${process.env.USERNAME}\\AppData\\Roaming`,
    `C:\\Users\\${process.env.USERNAME}\\AppData\\Roaming`,
  ].filter(Boolean);
  const roots = [];
  const seen = new Set();
  for (const base of bases) {
    const root = join(base, "Mozilla", "Firefox", "Profiles");
    const key = root.toLowerCase();
    if (seen.has(key) || !existsSync(root)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

async function readFirefoxCookie(host, name) {
  const hit = await readFirefoxCookieMeta(host, name);
  return hit?.value ?? null;
}

async function readFirefoxCookieMeta(host, name) {
  try {
    const { readdirSync } = await import("node:fs");
    const { DatabaseSync } = await import("node:sqlite");
    let best = null;
    for (const profilesDir of firefoxProfileRoots()) {
      const profiles = readdirSync(profilesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const profileName of profiles) {
        const dbSrc = join(profilesDir, profileName, "cookies.sqlite");
        if (!existsSync(dbSrc)) continue;
        const dbTmp = join(tmpdir(), `ff-cookies-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
        copyFileSync(dbSrc, dbTmp);
        for (const ext of ["-wal", "-shm"]) {
          if (existsSync(dbSrc + ext)) copyFileSync(dbSrc + ext, dbTmp + ext);
        }
        try {
          const db = new DatabaseSync(dbTmp);
          try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
          const row = db.prepare(
            "SELECT value, lastAccessed, expiry FROM moz_cookies WHERE (host = ? OR host = ?) AND name = ? ORDER BY lastAccessed DESC LIMIT 1"
          ).get(host, `.${host}`, name);
          db.close();
          if (!row?.value) continue;
          const lastAccessed = Number(row.lastAccessed || 0);
          if (!best || lastAccessed > best.lastAccessed) {
            best = {
              value: String(row.value),
              lastAccessed,
              expiry: Number(row.expiry || 0),
              profile: join(profilesDir, profileName)
            };
          }
        } catch { /* try next profile */ }
        finally {
          try { unlinkSync(dbTmp); } catch { /* ignore */ }
          for (const ext of ["-wal", "-shm"]) {
            try { unlinkSync(dbTmp + ext); } catch { /* ignore */ }
          }
        }
      }
    }
    return best;
  } catch {
    return null;
  }
}

function ageLabelFromFirefoxMicros(lastAccessed) {
  if (!lastAccessed) return "unknown age";
  // Firefox stores lastAccessed in microseconds since epoch.
  const ms = lastAccessed > 1e15 ? Math.floor(lastAccessed / 1000) : lastAccessed;
  const ageMs = Date.now() - ms;
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown age";
  const mins = Math.floor(ageMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Amazon auth cookies ───────────────────────────────────────────────────────
let _monsCookies = null;

async function getMonsCookies() {
  if (_monsCookies) return _monsCookies;

  // Manual overrides (same names as fetch.mjs) — useful when Firefox copy is locked/stale.
  const envSid = process.env.GC_MONS_SID || process.env.SM_MONS_SID || "";
  const envUbid = process.env.GC_MONS_UBID || process.env.SM_MONS_UBID || "";
  const envSt = process.env.GC_MONS_ST || process.env.SM_MONS_ST || "";
  const envSidp = process.env.GC_MONS_SIDP || process.env.SM_MONS_SIDP || "";

  const host = "eu.store-management.f3.amazon.dev";
  const names = ["__Host-mons-sid", "__Host-mons-ubid", "__Host-mons-st", "__Host-mons-sidp"];
  const vals = {};
  let sidMeta = null;
  for (const name of names) {
    const meta = await readFirefoxCookieMeta(host, name);
    if (!meta?.value) continue;
    vals[name] = meta.value;
    if (name === "__Host-mons-sid") sidMeta = meta;
  }
  if (envSid) vals["__Host-mons-sid"] = envSid;
  if (envUbid) vals["__Host-mons-ubid"] = envUbid;
  if (envSt) vals["__Host-mons-st"] = envSt;
  if (envSidp) vals["__Host-mons-sidp"] = envSidp;

  if (!vals["__Host-mons-sid"]) {
    throw new Error(
      `__Host-mons-sid not found in Firefox — open ${GC_BASE}/siteSummary, complete Midway sign-in until store data loads, then retry`
    );
  }

  const roots = firefoxProfileRoots();
  console.log(
    `[site-summary] cookies: ${Object.keys(vals).join(", ")} | sid last used ${ageLabelFromFirefoxMicros(sidMeta?.lastAccessed)}` +
      (sidMeta?.profile ? ` | profile ${sidMeta.profile}` : "") +
      (roots.length ? ` | scanned ${roots.length} Firefox root(s)` : " | no Firefox profiles found")
  );
  _monsCookies = vals;
  return vals;
}

function buildCookieHeader(vals) {
  return Object.entries(vals).map(([k, v]) => `${k}=${v}`).join("; ");
}

function siteSummaryHeaders(cookies, { jsonBody = false } = {}) {
  // Match the original working request shape — Cookie + Accept + Origin + Referer.
  return {
    Cookie: buildCookieHeader(cookies),
    Accept: "application/json",
    Origin: GC_BASE,
    Referer: `${GC_BASE}/siteSummary`,
    ...(jsonBody ? { "Content-Type": "application/json" } : {})
  };
}

async function parseSiteSummaryResponse(storeId, r) {
  const text = await r.text();
  const looksHtml = /^\s*</.test(text) || /<!DOCTYPE|<html/i.test(text);
  const signIn = /"reason"\s*:\s*"sign_in"/i.test(text) || /sign[_ -]?in/i.test(text);
  if (r.status === 401 || r.status === 403 || looksHtml || signIn) {
    _monsCookies = null;
    throw new Error(
      `Auth failed (${r.status}${looksHtml ? ", HTML" : ""}${signIn ? ", reason=sign_in" : ""}) for store ${storeId}. ` +
        `Firefox still has old Mons cookies, but Amazon rejected the session. ` +
        `In Firefox: open ${GC_BASE}/siteSummary → Midway sign-in → wait until live store rows appear → then re-run. ` +
        `Body: ${text.slice(0, 160).replace(/\s+/g, " ")}`
    );
  }
  if (!r.ok) throw new Error(`Site Summary API ${r.status} for ${storeId}: ${text.slice(0, 400)}`);
  try {
    const data = JSON.parse(text || "{}");
    return data.procurementListSummaries ?? data.summaries ?? [];
  } catch (err) {
    throw new Error(
      `Site Summary API returned non-JSON for store ${storeId}: ${err instanceof Error ? err.message : String(err)} · ${text.slice(0, 160)}`
    );
  }
}

// ── API call ──────────────────────────────────────────────────────────────────
async function fetchSiteSummary(storeId, cookies) {
  const url = `${GC_BASE}/api/v1/searchactiveprocurementlistsummaries/${storeId}/search`;

  // Original working shape is GET. Only try POST if GET is rejected as a method.
  let r = await fetch(url, { method: "GET", headers: siteSummaryHeaders(cookies) });
  if (r.status === 405) {
    r = await fetch(url, {
      method: "POST",
      headers: siteSummaryHeaders(cookies, { jsonBody: true }),
      body: "{}"
    });
  }
  return parseSiteSummaryResponse(storeId, r);
}

// ── Acceptance / order clocks (see site-summary-map.mjs) ──────────────────────
function mapActiveOrders(summaries) {
  return mapActiveOrdersBase(summaries, {
    sla: { ...DEFAULT_PICK_SLA, acceptance: THRESHOLD_S }
  });
}

function computeAcceptance(summaries) {
  return mapActiveOrders(summaries).filter((o) => o.pendingAcceptance);
}

function normalizeAssociateLabel(label) {
  return String(label ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseAssociateBanner(payload) {
  const out = emptyAssociates();
  if (!payload || typeof payload !== "object") return out;
  const buckets = payload.associateStatusCounts
    ?? payload.associateStatuses
    ?? payload.statuses
    ?? payload.metrics
    ?? payload;
  const set = (key, value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out[key] = Math.round(n);
  };
  if (Array.isArray(buckets)) {
    for (const row of buckets) {
      const label = normalizeAssociateLabel(row.label ?? row.name ?? row.status ?? row.key);
      const count = row.count ?? row.value ?? row.total;
      if (label.includes("waiting")) set("waiting_for_orders", count);
      else if (label.includes("break")) set("on_break", count);
      else if (label === "offered" || label.includes("offered")) set("offered_associates", count);
      else if (label.includes("picking") && !label.includes("pack")) set("picking_associates", count);
      else if (label.includes("pack") || label.includes("rack")) set("packing_racking", count);
      else if (label.includes("other")) set("other_activities", count);
      else if (label.includes("total")) set("total_associates", count);
    }
  } else {
    set("waiting_for_orders", buckets.waitingForOrders ?? buckets.waiting_for_orders ?? buckets.WAITING_FOR_ORDERS);
    set("on_break", buckets.onBreak ?? buckets.on_break ?? buckets.ON_BREAK);
    set("offered_associates", buckets.offered ?? buckets.offeredAssociates ?? buckets.OFFERED);
    set("picking_associates", buckets.picking ?? buckets.pickingAssociates ?? buckets.PICKING);
    set("packing_racking", buckets.packingAndRacking ?? buckets.packing_racking ?? buckets.PACKING_AND_RACKING);
    set("other_activities", buckets.otherActivities ?? buckets.other_activities ?? buckets.OTHER);
    set("total_associates", buckets.totalAssociates ?? buckets.total_associates ?? buckets.TOTAL);
  }
  if (
    out.waiting_for_orders || out.on_break || out.offered_associates || out.picking_associates
    || out.packing_racking || out.other_activities || out.total_associates
  ) {
    out.source = "api";
  }
  return out;
}

function parseAssociateBannerFromHtml(html) {
  const out = emptyAssociates();
  if (!html) return out;
  const patterns = [
    ["waiting_for_orders", /Waiting\s+for\s+Orders[^0-9]{0,40}(\d+)/i],
    ["on_break", /On\s+Break[^0-9]{0,40}(\d+)/i],
    ["offered_associates", /Offered[^0-9]{0,40}(\d+)/i],
    ["picking_associates", /Picking[^0-9A-Za-z]{0,40}(\d+)/i],
    ["packing_racking", /Packing\s*(?:&|and)?\s*Racking[^0-9]{0,40}(\d+)/i],
    ["other_activities", /Other\s+Activities[^0-9]{0,40}(\d+)/i],
    ["total_associates", /Total\s+Associates[^0-9]{0,40}(\d+)/i]
  ];
  for (const [key, re] of patterns) {
    const m = html.match(re);
    if (m) out[key] = Number(m[1]);
  }
  if (
    out.waiting_for_orders || out.on_break || out.offered_associates || out.picking_associates
    || out.packing_racking || out.other_activities || out.total_associates
  ) {
    out.source = "html";
  }
  return out;
}

function deriveAssociatesFromOrders(orders) {
  const out = emptyAssociates();
  const pickers = new Set();
  let offered = 0;
  let picking = 0;
  let packing = 0;
  for (const o of orders) {
    if (o.picker && o.picker !== "Unassigned") pickers.add(o.picker);
    if (o.status === "OFFERED" || o.status === "UNASSIGNED") offered += 1;
    else if (o.status.includes("PICK")) picking += 1;
    else if (o.status.includes("PACK") || o.status.includes("RACK")) packing += 1;
  }
  out.offered_associates = offered;
  out.picking_associates = picking;
  out.packing_racking = packing;
  out.total_associates = pickers.size || offered + picking + packing;
  out.source = "orders";
  return out;
}

async function fetchAssociateBanner(storeId, cookies) {
  // Labor Tracking people list powers the Site Summary associate tiles in-store.
  try {
    const laborUrl = `${GC_BASE}/api/v1/labortracking/findpeople/${storeId}`;
    let r = await fetch(laborUrl, { method: "GET", headers: siteSummaryHeaders(cookies) });
    if (r.status === 405) {
      r = await fetch(laborUrl, {
        method: "POST",
        headers: siteSummaryHeaders(cookies, { jsonBody: true }),
        body: "{}"
      });
    }
    if (r.ok) {
      const text = await r.text();
      if (text && !text.trim().startsWith("<")) {
        const parsed = parseLaborAssociates(JSON.parse(text));
        if (parsed.source === "labor") return parsed;
      }
    }
  } catch {
    // fall through to older candidates
  }

  const candidates = [
    `${GC_BASE}/api/v1/associatestatus/${storeId}`,
    `${GC_BASE}/api/v1/associatesummary/${storeId}`,
    `${GC_BASE}/api/v1/siteSummaryAssociateStatus/${storeId}`,
    `${GC_BASE}/api/v1/searchactiveassociatesummaries/${storeId}/search`
  ];
  for (const url of candidates) {
    try {
      let r = await fetch(url, { method: "GET", headers: siteSummaryHeaders(cookies) });
      if (r.status === 405) {
        r = await fetch(url, {
          method: "POST",
          headers: siteSummaryHeaders(cookies, { jsonBody: true }),
          body: "{}"
        });
      }
      if (!r.ok) continue;
      const text = await r.text();
      if (!text || text.trim().startsWith("<")) continue;
      const data = JSON.parse(text);
      const parsed = parseAssociateBanner(data);
      if (parsed.source === "api") return parsed;
    } catch {
      // try next candidate
    }
  }
  try {
    const pageUrl = `${GC_BASE}/siteSummary?storeId=${encodeURIComponent(storeId)}`;
    const r = await fetch(pageUrl, { method: "GET", headers: siteSummaryHeaders(cookies) });
    if (r.ok) {
      const html = await r.text();
      const parsed = parseAssociateBannerFromHtml(html);
      if (parsed.source === "html") return parsed;
    }
  } catch {
    // fall through
  }
  return emptyAssociates();
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

async function persistSiteSummary(stationCode, summaries, pending, activeOrders, associates) {
  if (!SUPABASE_KEY) {
    console.warn(`[${stationCode}] SUPABASE_SERVICE_KEY missing — skip Live Performance upsert`);
    return;
  }
  const fetchedAt = new Date().toISOString();
  const breaching = pending.filter((o) => o.elapsedS >= THRESHOLD_S);
  const worst = pending[0]?.elapsedS ?? null;
  const assoc = associates?.source && associates.source !== "none"
    ? associates
    : deriveAssociatesFromOrders(activeOrders);
  await sbUpsert("ds_site_summary_snapshots", [{
    company_id: COMPANY_ID,
    station_code: stationCode,
    fetched_at: fetchedAt,
    active_orders: summaries.length,
    pending_acceptance: pending.length,
    breaching_count: breaching.length,
    worst_elapsed_seconds: worst,
    sla_seconds: THRESHOLD_S,
    waiting_for_orders: assoc.waiting_for_orders,
    on_break: assoc.on_break,
    offered_associates: assoc.offered_associates,
    picking_associates: assoc.picking_associates,
    packing_racking: assoc.packing_racking,
    other_activities: assoc.other_activities,
    total_associates: assoc.total_associates,
    payload_json: {
      active: summaries.length,
      pending: pending.length,
      breaching: breaching.length,
      threshold_s: THRESHOLD_S,
      associates_source: assoc.source,
      associates: {
        waiting_for_orders: assoc.waiting_for_orders,
        on_break: assoc.on_break,
        offered: assoc.offered_associates,
        picking: assoc.picking_associates,
        packing_racking: assoc.packing_racking,
        other: assoc.other_activities,
        total: assoc.total_associates
      }
    }
  }], "company_id,station_code");

  const orderRows = activeOrders.map((o) => ({
    company_id: COMPANY_ID,
    station_code: stationCode,
    oid: o.oid,
    picker: o.picker,
    items: o.items,
    elapsed_seconds: Math.round((o.acceptanceS ?? o.elapsedS ?? 0) * 100) / 100,
    pct_complete: o.pctComplete,
    status: o.status,
    acceptance_seconds: o.acceptanceS == null ? null : Math.round(o.acceptanceS * 100) / 100,
    picking_seconds: o.pickingS == null ? null : Math.round(o.pickingS * 100) / 100,
    pack_rack_seconds: o.packS == null ? null : Math.round(o.packS * 100) / 100,
    total_seconds: o.totalS == null ? null : Math.round(o.totalS * 100) / 100,
    acceptance_target_seconds: o.acceptanceTarget ?? THRESHOLD_S,
    picking_target_seconds: o.pickingTarget,
    pack_rack_target_seconds: o.packTarget,
    total_target_seconds: o.totalTarget,
    fetched_at: fetchedAt
  }));
  if (orderRows.length) {
    await sbUpsert("ds_site_summary_orders", orderRows, "company_id,station_code,oid");
  }
  // Drop OIDs that are no longer active for this store.
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
      const activeOrders = mapActiveOrders(summaries);
      const pending = activeOrders.filter((o) => o.pendingAcceptance);
      const breaching = pending.filter((o) => o.elapsedS >= THRESHOLD_S);
      let associates = emptyAssociates();
      try {
        associates = await fetchAssociateBanner(storeId, cookies);
      } catch (assocErr) {
        console.warn(`[${station}] Associate banner unavailable — ${assocErr.message}`);
      }

      console.log(`[${station}] ${summaries.length} active orders, ${pending.length} pending acceptance, ${breaching.length} over ${THRESHOLD_S}s SLA, associates=${associates.source}`);

      try {
        await persistSiteSummary(station, summaries, pending, activeOrders, associates);
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

if (debugAuth) {
  console.log("DropX Site Summary Monitor - debug-auth");
  console.log(`Firefox roots: ${firefoxProfileRoots().join(" | ") || "(none)"}`);
  try {
    await getMonsCookies();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  process.exit(0);
}

console.log(`DropX Site Summary Monitor - stations: ${STATIONS.join(", ")} - threshold: ${THRESHOLD_S}s - interval: ${POLL_MS / 1000}s${dryRun ? " [DRY RUN]" : ""}`);
if (TESTING_GROUP) {
  console.log(`  Testing mode: all alerts → ${TESTING_GROUP}`);
  if (/120363429732355530@g\.us/i.test(TESTING_GROUP)) {
    console.warn("  WARNING: Dark Store Testing is muted in Report Bot (is_enabled=false). Sends will 422 until that group is re-enabled or TESTING_GROUP_JID is cleared.");
  }
} else {
  const mapped = Object.keys(stationGroupMap);
  console.log(`  Live war rooms: ${mapped.length ? mapped.join(", ") : "(none — set AMAZON_STATION_GROUP_JIDS)"}`);
}

if (runOnce) {
  await pollOnce();
} else {
  while (true) {
    await pollOnce();
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
