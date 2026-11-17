/**
 * DropX Dark Store PPI + Inbound Shipment worker
 *
 * Runs silently on the workspace machine (Firefox profile-1 cookies stay separate).
 * Fetches InventoryAudit + AssociateAudit from whitetree.ihm.a2z.com for all
 * configured stores, computes PPI (PPT per order, hourly, per picker), then
 * pushes everything to Supabase.
 *
 * Usage:
 *   node fetch.mjs [--date YYYY-MM-DD] [--store TZC4] [--inbound] [--dry-run]
 *
 * Required env (set in .env or environment):
 *   SUPABASE_URL          https://uimajyffojydenqsegjv.supabase.co
 *   SUPABASE_SERVICE_KEY  <service role key>
 *   COMPANY_ID            43866344-b550-4e8a-9a2d-9d23f3d8a997
 *
 * Auth cookies from Firefox profile-1 (workspace machine) — set in .env:
 *   WH_COGNITO_COOKIE     full value of CognitoIdentityServiceProvider.*.idToken cookie
 *   GC_MONS_SID           __Host-mons-sid cookie value  (for GroceryCentral inbound)
 *   GC_MONS_UBID          __Host-mons-ubid cookie value
 *   GC_MONS_ST            __Host-mons-st cookie value
 */

import { readFileSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── env ──────────────────────────────────────────────────────────────────────
const envPath = join(__dir, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.replace(/\r$/, "").match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ── Auto-read cookies from Firefox profile (Windows) ─────────────────────────
// Reads cookies.sqlite directly so WH_COGNITO_COOKIE never needs manual updates.
// Falls back to .env value if Firefox is not found or cookie is missing.
async function readFirefoxCookie(host, name, profileHint) {
  try {
    // APPDATA may point to wrong drive — search common locations
    const appDataCandidates = [
      process.env.APPDATA,
      process.env.APPDATA?.replace(/^C:/, "D:"),
      `D:\\Users\\${process.env.USERNAME}\\AppData\\Roaming`,
      `C:\\Users\\${process.env.USERNAME}\\AppData\\Roaming`,
    ].filter(Boolean);

    let profilesDir = null;
    for (const base of appDataCandidates) {
      const candidate = join(base, "Mozilla", "Firefox", "Profiles");
      if (existsSync(candidate)) { profilesDir = candidate; break; }
    }
    if (!profilesDir) {
      console.warn(`  [cookie-reader] Firefox profiles dir not found (tried: ${appDataCandidates.join(", ")})`);
      return null;
    }

    const { readdirSync } = await import("node:fs");
    const profiles = readdirSync(profilesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    // Search ALL profiles for the cookie — the active session may be in any profile
    const { DatabaseSync } = await import("node:sqlite");
    const priority = ["default-esr", "default-release", "default"];
    const rank = (p) => {
      if (profileHint && p.includes(profileHint)) return 0;
      for (let i = 0; i < priority.length; i++) if (p.includes(priority[i])) return i + 1;
      return 99;
    };
    const sorted = [...profiles].sort((a, b) => rank(a) - rank(b));

    for (const profileName of sorted) {
      const dbSrc = join(profilesDir, profileName, "cookies.sqlite");
      if (!existsSync(dbSrc)) continue;
      console.log(`  [cookie-reader] Trying profile: ${profileName}`);
      const dbTmp = join(tmpdir(), `ff-cookies-${Date.now()}.sqlite`);
      copyFileSync(dbSrc, dbTmp);
      for (const ext of ["-wal", "-shm"]) {
        const s = dbSrc + ext;
        if (existsSync(s)) copyFileSync(s, dbTmp + ext);
      }
      try {
        const db = new DatabaseSync(dbTmp);
        try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
        const row = db.prepare(
          "SELECT value FROM moz_cookies WHERE (host = ? OR host = ?) AND name = ? ORDER BY lastAccessed DESC LIMIT 1"
        ).get(host, `.${host}`, name);
        db.close();
        if (row?.value) return row.value;
      } catch (e) {
        console.warn(`  [cookie-reader] profile ${profileName}: ${e.message}`);
      } finally {
        try { unlinkSync(dbTmp); } catch {}
        for (const ext of ["-wal", "-shm"]) { try { unlinkSync(dbTmp + ext); } catch {} }
      }
    }
    return null;
  } catch (e) {
    console.warn(`  [cookie-reader] ${e.message}`);
    return null;
  }
}

// Read Cognito idToken from Firefox localStorage (webappsstore.sqlite)
// The token is stored as a JSON array [header, payload, signature] — we join with '.'
async function readCognitoIdTokenFromLocalStorage() {
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
    if (!profilesDir) { console.warn("  [ls-reader] Firefox profiles dir not found"); return null; }

    const { readdirSync } = await import("node:fs");
    const profiles = readdirSync(profilesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

    // Priority: default-esr > default-release > default
    const priority = ["default-esr", "default-release", "default"];
    const rank = (p) => { for (let i = 0; i < priority.length; i++) if (p.includes(priority[i])) return i; return 99; };
    const sorted = [...profiles].sort((a, b) => rank(a) - rank(b));

    let dbSrc = null;
    let chosenProfile = null;
    for (const p of sorted) {
      const candidate = join(profilesDir, p, "webappsstore.sqlite");
      if (existsSync(candidate)) { dbSrc = candidate; chosenProfile = p; break; }
    }
    if (!dbSrc) { console.warn("  [ls-reader] webappsstore.sqlite not found in any profile"); return null; }
    console.log(`  [ls-reader] Reading localStorage from profile: ${chosenProfile}`);

    const dbTmp = join(tmpdir(), `ff-ls-${Date.now()}.sqlite`);
    copyFileSync(dbSrc, dbTmp);
    for (const ext of ["-wal", "-shm"]) { try { copyFileSync(dbSrc + ext, dbTmp + ext); } catch {} }
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbTmp, { readonly: true });
      // webappsstore.sqlite schema: key, value, scope, secure, owner
      // scope is like "moc.nozama.3f.tnemegam-erots.ue.:https:443" (reversed hostname)
      const rows = db.prepare(
        "SELECT key, value FROM webappsstore2 WHERE key LIKE '%idToken%' ORDER BY rowid DESC"
      ).all();
      db.close();
      if (rows.length === 0) {
        console.warn("  [ls-reader] No idToken key found in localStorage");
        // Show what keys exist for amazon domains
        const db2 = new DatabaseSync(dbTmp, { readonly: true });
        const scopes = db2.prepare("SELECT DISTINCT scope FROM webappsstore2 WHERE scope LIKE '%amazon%' LIMIT 20").all();
        db2.close();
        console.warn(`  [ls-reader] Amazon scopes: ${scopes.map(r => r.scope).join(", ")}`);
        return null;
      }
      for (const r of rows) {
        console.log(`  [ls-reader] Found key: ${r.key}`);
        try {
          const parts = JSON.parse(r.value);
          if (Array.isArray(parts) && parts.length === 3) {
            const jwt = parts.join(".");
            console.log(`  [ls-reader] JWT assembled (${jwt.length} chars)`);
            return jwt;
          }
          // If value is already a plain JWT string
          if (typeof r.value === "string" && r.value.startsWith("eyJ")) return r.value;
        } catch {
          if (typeof r.value === "string" && r.value.startsWith("eyJ")) return r.value;
        }
      }
      return null;
    } finally {
      try { unlinkSync(dbTmp); } catch {}
      for (const ext of ["-wal", "-shm"]) { try { unlinkSync(dbTmp + ext); } catch {} }
    }
  } catch (e) {
    console.warn(`  [ls-reader] ${e.message}`);
    return null;
  }
}

async function dumpCookiesForHost(exactHost) {
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
    if (!profilesDir) return;
    const { readdirSync } = await import("node:fs");
    const profiles = readdirSync(profilesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    const priority = ["default-esr", "default-release", "default"];
    const rank = (p) => { for (let i = 0; i < priority.length; i++) if (p.includes(priority[i])) return i; return 99; };
    const sorted = [...profiles].sort((a, b) => rank(a) - rank(b));
    let dbSrc = null, chosenProfile = null;
    for (const p of sorted) {
      const c = join(profilesDir, p, "cookies.sqlite");
      if (existsSync(c)) { dbSrc = c; chosenProfile = p; break; }
    }
    if (!dbSrc) return;
    const dbTmp = join(tmpdir(), `ff-dump-${Date.now()}.sqlite`);
    copyFileSync(dbSrc, dbTmp);
    for (const ext of ["-wal", "-shm"]) { try { copyFileSync(dbSrc + ext, dbTmp + ext); } catch {} }
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbTmp, { readonly: true });
      const rows = db.prepare(
        "SELECT name, value FROM moz_cookies WHERE host = ? ORDER BY lastAccessed DESC"
      ).all(exactHost);
      db.close();
      console.log(`  [cookie-dump] Profile: ${chosenProfile}, host: ${exactHost} — ${rows.length} cookies:`);
      for (const r of rows) console.log(`    name=${r.name}  value=${String(r.value).substring(0, 60)}...`);
    } finally {
      try { unlinkSync(dbTmp); } catch {}
      for (const ext of ["-wal", "-shm"]) { try { unlinkSync(dbTmp + ext); } catch {} }
    }
  } catch (e) { console.warn(`  [cookie-dump] ${e.message}`); }
}

async function readMonsCookies() {
  // Read all __Host-mons-* cookies for eu.store-management.f3.amazon.dev
  const names = ["__Host-mons-st", "__Host-mons-sid", "__Host-mons-ubid", "__Host-mons-sidp"];
  const result = {};
  for (const name of names) {
    const val = await readFirefoxCookie("eu.store-management.f3.amazon.dev", name);
    if (val) result[name] = val;
  }
  return result;
}

/** Read JWT from log.txt written by the browser console snippet.
 *  Format (each part on its own line, prefixed with 0: 1: 2:):
 *    CognitoIdentityServiceProvider.*.idToken:Array
 *    0:"<header>"
 *    1:"<payload>"
 *    2:"<signature>"
 */
function readJwtFromLogFile(logPath) {
  try {
    if (!existsSync(logPath)) return null;
    const text = readFileSync(logPath, "utf8");
    // Find the last occurrence of the idToken array block
    const blocks = [...text.matchAll(/CognitoIdentityServiceProvider\.[^:]+:Array\s+((?:[0-2]:"[^"\n]+"\n?)+)/g)];
    if (!blocks.length) return null;
    const lastBlock = blocks[blocks.length - 1][1];
    const parts = [];
    for (const m of lastBlock.matchAll(/[0-2]:"([^"]+)"/g)) parts.push(m[1]);
    if (parts.length === 3) {
      console.log(`  [log-reader] WH_COGNITO_COOKIE loaded from ${logPath}`);
      return parts.join(".");
    }
    return null;
  } catch (e) {
    console.warn(`  [log-reader] ${e.message}`);
    return null;
  }
}

async function autoFillCookies() {
  // Whitetree — read idToken and accessToken directly from Firefox cookies.
  // The inventory audit APIs use custom headers, NOT Authorization: Bearer.
  if (!process.env.WH_ID_TOKEN || !process.env.WH_ACCESS_TOKEN) {
    const prefix = "CognitoIdentityServiceProvider.1dr6i35r3kv86h3lpvvte7de4l";
    const idToken     = process.env.WH_ID_TOKEN     || await readFirefoxCookie("dashboard.prod.whitetree.ihm.a2z.com", `${prefix}.idToken`);
    const accessToken = process.env.WH_ACCESS_TOKEN || await readFirefoxCookie("dashboard.prod.whitetree.ihm.a2z.com", `${prefix}.accessToken`);
    if (idToken)     { process.env.WH_ID_TOKEN     = idToken;     }
    if (accessToken) { process.env.WH_ACCESS_TOKEN = accessToken; }
    if (idToken && accessToken) {
      console.log("  [cookie-reader] Loaded Whitetree idToken + accessToken from Firefox");
    } else if (idToken || accessToken) {
      console.log("  [cookie-reader] Loaded partial Whitetree cookies from Firefox");
    }
  }
  // Legacy fallback — WH_COGNITO_COOKIE in .env sets idToken
  if (!process.env.WH_ID_TOKEN && process.env.WH_COGNITO_COOKIE) {
    process.env.WH_ID_TOKEN = process.env.WH_COGNITO_COOKIE;
  }
  // GroceryCentral cookies
  if (!process.env.GC_MONS_SID) {
    const sid  = await readFirefoxCookie("grocerycentral.amazon.dev", "__Host-mons-sid");
    const ubid = await readFirefoxCookie("grocerycentral.amazon.dev", "__Host-mons-ubid");
    const st   = await readFirefoxCookie("grocerycentral.amazon.dev", "__Host-mons-st");
    if (sid)  { process.env.GC_MONS_SID  = sid;  console.log("  [cookie-reader] Loaded GC_MONS_SID from Firefox"); }
    if (ubid) { process.env.GC_MONS_UBID = ubid; }
    if (st)   { process.env.GC_MONS_ST   = st;   }
  }
}
await autoFillCookies();

const SUPABASE_URL  = (process.env.SUPABASE_URL  || "https://uimajyffojydenqsegjv.supabase.co").replace(/\/$/, "");
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || "";
const COMPANY_ID    = process.env.COMPANY_ID || "43866344-b550-4e8a-9a2d-9d23f3d8a997";

if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_KEY not set"); process.exit(1); }

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const _dateIdx  = args.indexOf("--date");
const _storeIdx = args.indexOf("--store");
const argDate   = _dateIdx  >= 0 ? args[_dateIdx  + 1] : undefined;
const argStore  = _storeIdx >= 0 ? args[_storeIdx + 1] : undefined;
const doInbound = args.includes("--inbound");
const dryRun    = args.includes("--dry-run");

// Business date defaults to today (IST = UTC+5:30)
function todayIST() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
const businessDate = argDate || todayIST();

// ── Supabase helpers ──────────────────────────────────────────────────────────
const SB_HEADERS = {
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=minimal"
};

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`Supabase GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbUpsert(table, rows, onConflict) {
  if (dryRun) { console.log(`  [dry-run] upsert ${rows.length} rows → ${table}`); return; }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...SB_HEADERS, "Prefer": `resolution=merge-duplicates,return=minimal` },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`Supabase upsert ${table}: ${r.status} ${await r.text()}`);
}

async function logRun(stationCode, runType, date, status, msg, rows) {
  await sbUpsert("ds_fetch_runs", [{
    company_id: COMPANY_ID, station_code: stationCode, run_type: runType,
    business_date: date, status, error_message: msg ?? null,
    rows_fetched: rows ?? null, finished_at: new Date().toISOString()
  }], null);
}

// ── Load store configs ────────────────────────────────────────────────────────
async function loadStores() {
  let rows = await sbGet(`/ds_store_config?company_id=eq.${COMPANY_ID}&is_active=eq.true`);
  if (argStore) rows = rows.filter(r => r.station_code === argStore);
  return rows;
}

// ── Whitetree auth ────────────────────────────────────────────────────────────
function whitetreeHeaders() {
  const idToken     = process.env.WH_ID_TOKEN;
  const accessToken = process.env.WH_ACCESS_TOKEN;
  if (!idToken) throw new Error("WH_ID_TOKEN not set — open dashboard.prod.whitetree.ihm.a2z.com in Firefox then retry");
  return {
    "x-ihmwhitetree-id-token":       idToken,
    "x-ihmwhitetree-cognito-auth":   accessToken || idToken,
    "Content-Type": "application/json",
    "Origin": "https://dashboard.prod.whitetree.ihm.a2z.com",
  };
}

// ── Inventory Audit download ─────────────────────────────────────────────────
async function fetchInventoryAudit(store, fromMs, toMs) {
  const body = {
    format: "STRUCTURED",
    fromTimeMs: fromMs,
    toTimeMs: toMs,
    sort: {},
    warehouseIds: [store.warehouse_id],
    storeIds: [store.amazon_store_id],
    businessTags: [store.store_family],
    pageSize: 10001,
    filter: { processes: ["Outbound Pick"] },
    retrieve: {
      user: true, asin: true, fcsku: true, fnsku: true, productTitle: true,
      locationId: true, deltaQuantity: true, newTotalQuantity: true,
      process: true, unit: true, referenceId: true, timestamp: true
    }
  };
  const r = await fetch("https://wt.prod-zaz.ihminvaudit.ihm.a2z.com/get_inventory_audit_data", {
    method: "POST",
    headers: whitetreeHeaders(),
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`InventoryAudit ${store.station_code}: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return data.inventoryAuditResults ?? [];
}

// ── Associate Audit download ─────────────────────────────────────────────────
async function fetchAssociateAudit(store, fromMs, toMs) {
  // Subdomain: {store-id-lowercase-dash}.{region}.ihmlabortrackingnative.jihmcdo.com
  const subdomain = `${store.amazon_store_id.toLowerCase()}.${store.region_code}`;
  const body = {
    fromTimestamp: fromMs,
    toTimestamp: toMs,
    processes: ["COMPLETE_PACKAGE", "OFFERED"],
    storeId: store.amazon_store_id,
    location: "",
    asin: "",
    action: "",
    user: "",
    storeFamily: store.store_family
  };
  const r = await fetch(`https://${subdomain}.ihmlabortrackingnative.jihmcdo.com/`, {
    method: "POST",
    headers: {
      ...whitetreeHeaders(),
      "x-midway-passthrough": "true",
      "Content-Encoding": "amz-1.0",
      "X-Amz-Target": "com.amazon.ihmlabortrackingservice.IhmLaborTrackingService.GetAssociateAuditData",
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`AssociateAudit ${store.station_code}: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return (data.AssociateAuditData ?? []).map(row => {
    // notes field is JSON-encoded: parse it to get StartTimestamp, EndTimestamp etc.
    let notes = {};
    try { notes = typeof row.notes === "string" ? JSON.parse(row.notes) : (row.notes ?? {}); } catch {}
    return {
      timestamp: row.timestamp,
      username: row.username ?? row.user,
      process: row.process,
      procurementListId: row.procurementListId ?? row.ProcurementListId ?? notes.ProcurementListId,
      startTimestamp: Number(notes.StartTimestamp ?? row.startTimestamp ?? 0),
      endTimestamp: Number(notes.EndTimestamp ?? row.endTimestamp ?? 0),
      temperatureZone: notes.TemperatureZone ?? "NA"
    };
  });
}

// ── PPI computation ───────────────────────────────────────────────────────────
function computePPI(auditRows, invRows) {
  // Build a map: procurementListId → { offered: {username, startMs}, complete: {username, endMs} }
  const orders = new Map();
  for (const row of auditRows) {
    const id = row.procurementListId;
    if (!id) continue;
    if (!orders.has(id)) orders.set(id, { offered: null, complete: null });
    const o = orders.get(id);
    if (row.process === "OFFERED" && (!o.offered || row.startTimestamp < o.offered.startMs)) {
      o.offered = { username: row.username, startMs: row.startTimestamp };
    }
    if (row.process === "COMPLETE_PACKAGE") {
      o.complete = { username: row.username, endMs: row.endTimestamp };
    }
  }

  // Build unit count per procurement list from inventory audit
  // ReferenceIdValue in inventory = ProcurementListId in associate audit
  // But inventory uses Amazon order IDs; ProcurementListId is the batch UUID.
  // Units per order = abs(sum of deltaQuantity) for Outbound Pick rows with same ReferenceIdValue
  // We need to match via the order list; for now count units from inventory by user+time proximity.
  // Best available: count units from COMPLETE_PACKAGE rows' own iog/quantity field (not in audit).
  // Fall back: 1 unit per order (can be enriched later via inventory audit join on timestamp).
  const unitsByOrder = new Map();
  for (const row of invRows) {
    const ref = row.ReferenceIdValue;
    if (!ref) continue;
    const delta = Math.abs(Number(row.Quantity ?? 0));
    unitsByOrder.set(ref, (unitsByOrder.get(ref) ?? 0) + delta);
  }

  const orderResults = [];
  for (const [id, o] of orders) {
    if (!o.offered || !o.complete) continue;
    // Skip rows where timestamps were not populated (zero = missing data)
    if (!o.offered.startMs || !o.complete.endMs) continue;
    const pptMs = o.complete.endMs - o.offered.startMs;
    if (pptMs < 0 || pptMs > 7200000) continue; // skip bogus (negative or >2h)
    const completedAt = new Date(o.complete.endMs).toISOString();
    const unitCount = unitsByOrder.get(id) ?? 1;
    orderResults.push({
      procurement_list_id: id,
      username: o.complete.username,
      completed_at: completedAt,
      unit_count: unitCount,
      ppt_ms: pptMs,
      ppt_seconds: pptMs / 1000
    });
  }

  // Per-picker summary
  const byUser = new Map();
  for (const o of orderResults) {
    if (!byUser.has(o.username)) byUser.set(o.username, { orders: 0, units: 0, totalPptMs: 0 });
    const u = byUser.get(o.username);
    u.orders++;
    u.units += o.unit_count;
    u.totalPptMs += o.ppt_ms;
  }

  // Hourly breakdown — use IST hour (UTC+5:30) so it matches the cron window labels
  const byHour = new Map();
  for (const o of orderResults) {
    const h = Math.floor((new Date(o.completed_at).getTime() / 1000 + 5.5 * 3600) / 3600) % 24;
    if (!byHour.has(h)) byHour.set(h, { orders: 0, units: 0, totalPptMs: 0 });
    const hd = byHour.get(h);
    hd.orders++;
    hd.units += o.unit_count;
    hd.totalPptMs += o.ppt_ms;
  }

  return { orderResults, byUser, byHour };
}

// ── Push PPI to DB ────────────────────────────────────────────────────────────
async function pushPPI(store, date, ppi) {
  const { orderResults, byUser, byHour } = ppi;
  const base = { company_id: COMPANY_ID, station_id: store.station_id, station_code: store.station_code, business_date: date };

  // Orders
  if (orderResults.length) {
    await sbUpsert("ds_ppi_orders", orderResults.map(o => ({
      ...base, procurement_list_id: o.procurement_list_id,
      username: o.username, completed_at: o.completed_at,
      unit_count: o.unit_count, ppt_seconds: o.ppt_seconds
    })), "company_id,station_code,procurement_list_id");
  }

  // Daily per picker
  const dailyRows = [...byUser.entries()].map(([username, s]) => ({
    ...base, username,
    order_count: s.orders, unit_count: s.units,
    total_ppt_ms: s.totalPptMs,
    avg_ppt_seconds: s.orders > 0 ? parseFloat((s.totalPptMs / s.orders / 1000).toFixed(2)) : null
  }));
  if (dailyRows.length) await sbUpsert("ds_ppi_daily", dailyRows, "company_id,station_code,business_date,username");

  // Hourly
  const hourlyRows = [...byHour.entries()].map(([hour, s]) => ({
    ...base, hour,
    order_count: s.orders, unit_count: s.units,
    total_ppt_ms: s.totalPptMs,
    avg_ppt_seconds: s.orders > 0 ? parseFloat((s.totalPptMs / s.orders / 1000).toFixed(2)) : null
  }));
  if (hourlyRows.length) await sbUpsert("ds_ppi_hourly", hourlyRows, "company_id,station_code,business_date,hour");

  return orderResults.length;
}

// ── GroceryCentral inbound ───────────────────────────────────────────────────
function gcCookies() {
  const sid  = process.env.GC_MONS_SID;
  const ubid = process.env.GC_MONS_UBID;
  const st   = process.env.GC_MONS_ST;
  if (!sid || !ubid || !st) throw new Error("GC_MONS_SID / GC_MONS_UBID / GC_MONS_ST not set — cannot fetch inbound");
  return `__Host-mons-sid=${sid}; __Host-mons-ubid=${ubid}; __Host-mons-st=${st}`;
}

async function gcPost(path, body, storeType = "KISAN") {
  const r = await fetch(`https://grocerycentral.amazon.dev${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": gcCookies(),
      "Origin": "https://grocerycentral.amazon.dev"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GroceryCentral ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function fetchInboundShipments(store) {
  // Region prefix for the endpoint: derive from region_code (eu-south-2 → dub, ap-south-1 → bom, etc.)
  const regionMap = { "eu-south-2": "dub", "ap-south-1": "bom", "ap-southeast-1": "sin", "us-west-2": "pdx" };
  const regionPrefix = regionMap[store.region_code] ?? "dub";

  const data = await gcPost(`/${regionPrefix}/serenity/getTransshipmentsV2`, {
    storeId: store.amazon_store_id,
    storeType: store.store_type,
    clientId: "IhmTransshipDashboards"
  });

  const manifests = data.transshipManifestsListV2 ?? [];
  const shipmentRows = manifests.map(m => ({
    company_id: COMPANY_ID,
    station_id: store.station_id,
    station_code: store.station_code,
    amazon_shipment_ref_id: m.amazonShipmentRefId,
    source_warehouse_id: m.sourceWarehouseId ?? null,
    departure_time: m.departureTime ? new Date(m.departureTime).toISOString() : null,
    estimated_arrival_time: m.estimatedArrivalTime ? new Date(m.estimatedArrivalTime).toISOString() : null,
    receive_time: m.receiveTime ? new Date(m.receiveTime).toISOString() : null,
    total_units: m.totalUnits ?? null,
    pallet_count: m.palletCount ?? null,
    pct_completion: m.percentageCompletion ?? null,
    has_overage: m.hasOverageReceives ?? false,
    status: (m.percentageCompletion ?? 0) >= 100 ? "complete" : m.receiveTime ? "partial" : "pending",
    updated_at: new Date().toISOString()
  }));

  if (shipmentRows.length) {
    await sbUpsert("ds_inbound_shipments", shipmentRows, "company_id,amazon_shipment_ref_id");
  }

  // Fetch detail for each shipment that is not 100% complete (pending/partial)
  const pending = manifests.filter(m => (m.percentageCompletion ?? 0) < 100);
  let reconRows = 0;
  for (const m of pending) {
    try {
      const detail = await gcPost(`/${regionPrefix}/serenity/getTransshipmentDetails`, {
        storeId: store.amazon_store_id,
        storeType: store.store_type,
        clientId: "IhmTransshipDashboards",
        amazonShipmentRefId: m.amazonShipmentRefId,
        transshipType: "INBOUND"
      });
      // Find the saved shipment row's id
      const savedRows = await sbGet(`/ds_inbound_shipments?company_id=eq.${COMPANY_ID}&amazon_shipment_ref_id=eq.${encodeURIComponent(m.amazonShipmentRefId)}&select=id`);
      const shipmentDbId = savedRows[0]?.id;
      if (!shipmentDbId) continue;

      const totes = detail.toteDetails ?? [];
      const rows = [];
      for (const tote of totes) {
        for (const item of tote.items ?? []) {
          for (const [fcSku, skuDetail] of Object.entries(item.fcSkuDetailMap ?? {})) {
            rows.push({
              company_id: COMPANY_ID,
              shipment_id: shipmentDbId,
              station_code: store.station_code,
              tote_id: tote.toteId ?? null,
              asin: item.asin ?? "",
              fc_sku: fcSku,
              fn_sku: item.fnSku ?? null,
              product_title: item.productTitle ?? null,
              expected_qty: Number(skuDetail.expectedQuantity ?? 0),
              received_qty: Number(skuDetail.unpackedQuantity ?? 0),
              stow_pending_qty: Number(skuDetail.stowPendingQuantity ?? 0)
            });
          }
        }
      }
      if (rows.length) {
        await sbUpsert("ds_inbound_reconciliation", rows, "company_id,shipment_id,asin,fc_sku");
        reconRows += rows.length;
      }
    } catch (e) {
      console.warn(`  Shipment detail ${m.amazonShipmentRefId}: ${e.message}`);
    }
  }
  return { shipments: shipmentRows.length, reconRows };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runPPI(store) {
  console.log(`[${store.station_code}] PPI for ${businessDate} ...`);
  // Time range: midnight to now in ms (IST)
  const dateMs = new Date(`${businessDate}T00:00:00+05:30`).getTime();
  const nowMs  = Date.now();
  const toMs   = Math.min(nowMs, dateMs + 86400000 - 1);
  let status = "ok", msg = null, rows = 0;
  try {
    const [invRows, auditRows] = await Promise.all([
      fetchInventoryAudit(store, dateMs, toMs),
      fetchAssociateAudit(store, dateMs, toMs)
    ]);
    console.log(`  inventory: ${invRows.length} rows, associate audit: ${auditRows.length} rows`);
    const ppi = computePPI(auditRows, invRows);
    rows = await pushPPI(store, businessDate, ppi);
    console.log(`  pushed ${rows} orders, ${ppi.byUser.size} pickers, ${ppi.byHour.size} hours`);
  } catch (e) {
    status = "error"; msg = e.message;
    console.error(`  ERROR: ${e.message}`);
  }
  await logRun(store.station_code, "ppi", businessDate, status, msg, rows);
}

async function runInbound(store) {
  console.log(`[${store.station_code}] Inbound shipments ...`);
  let status = "ok", msg = null;
  let result = { shipments: 0, reconRows: 0 };
  try {
    result = await fetchInboundShipments(store);
    console.log(`  ${result.shipments} shipments, ${result.reconRows} recon rows`);
  } catch (e) {
    status = "error"; msg = e.message;
    console.error(`  ERROR: ${e.message}`);
  }
  await logRun(store.station_code, "inbound", null, status, msg, result.shipments);
}

async function main() {
  console.log(`DropX Dark Store worker — date: ${businessDate}${dryRun ? " [DRY RUN]" : ""}`);
  const stores = await loadStores();
  if (!stores.length) {
    console.error("No store configs found. Add rows to ds_store_config in Supabase.");
    process.exit(1);
  }
  console.log(`Stores: ${stores.map(s => s.station_code).join(", ")}`);
  for (const store of stores) {
    await runPPI(store);
    if (doInbound) await runInbound(store);
  }
  console.log("Done.");
}

main().catch(e => { console.error(e); process.exit(1); });
