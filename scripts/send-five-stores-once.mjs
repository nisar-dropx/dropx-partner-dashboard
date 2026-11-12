#!/usr/bin/env node
/** Switch DropX Site Summary stores via .header-row, capture at 50% zoom, send short captions if chip matches. */
import { spawn } from "node:child_process";
import { readFile, mkdir, unlink, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const workerCandidates = [
  path.join(root, "worker"),
  path.join(root, "workers", "amazon-scc-playwright"),
];
let worker = workerCandidates[0];
for (const candidate of workerCandidates) {
  try {
    await access(path.join(candidate, ".env.station-summary"));
    worker = candidate;
    break;
  } catch {
    /* try next */
  }
}
const state = path.join(worker, ".station-summary-state");

async function loadEnv(filePath, { overwrite = true } = {}) {
  try { await access(filePath); } catch { return false; }
  for (const line of (await readFile(filePath, "utf8")).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const key = t.slice(0, i).trim();
    if (!overwrite && key in process.env) continue;
    process.env[key] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return true;
}
// Dedicated monitor env wins over leftover shell vars from earlier runs.
const loaded =
  (await loadEnv(path.join(worker, ".env.station-summary"), { overwrite: true })) ||
  (await loadEnv(path.join(root, "workers", "amazon-scc-playwright", ".env.station-summary"), { overwrite: true }));
if (!loaded) console.warn("No .env.station-summary found — using process env only");
process.env.GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const suffix = String(process.env.AMAZON_STATION_DROPDOWN_SUFFIX || "");
const chipPrefix = String(process.env.AMAZON_STATION_CHIP_PREFIX || "AmazonNow").trim();
const stations = String(process.env.AMAZON_STATIONS || "TCC3,TCD4,TTB3,TTA5,TZC4,TTG9,TFB7")
  .split(",").map((s) => s.trim()).filter(Boolean);

/** Optional map: TCC3:TCC3,TCD4:TCD4_SS — exact text typed into the site filter. */
const filterMap = Object.fromEntries(
  String(process.env.AMAZON_STATION_FILTERS || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(":");
      if (i < 0) return null;
      return [p.slice(0, i).trim().toUpperCase(), p.slice(i + 1).trim()];
    })
    .filter(Boolean)
);

function stationCode(station) {
  let s = String(station).trim().toUpperCase();
  s = s.replace(/^AMAZONNOW\s+/, "").replace(/_SS$/, "").replace(/_$/, "");
  return s;
}
function dropdownCode(station) {
  const code = stationCode(station);
  if (filterMap[code]) return filterMap[code];
  return suffix ? `${code}${suffix}` : code;
}
function expectedChip(station) {
  const code = stationCode(station);
  const filter = filterMap[code] || dropdownCode(station);
  // Chip may show "AmazonNow TCC3" or "TCD4_SS".
  if (/_SS$/i.test(filter)) return filter.toUpperCase();
  if (/^amazonnow\s+/i.test(filter)) return filter;
  return `${chipPrefix} ${code}`.trim();
}

const waitMs = Math.max(1800, Number(process.env.AMAZON_STATION_SWITCH_WAIT_MS || 2500));
const dropX = Number(process.env.AMAZON_WS_DROP_X || 0.935);
const dropY = Number(process.env.AMAZON_WS_DROP_Y || 0.195);
const switchPs = path.join(root, "scripts", "switch-site-summary-station.ps1");
const capturePs = path.join(root, "scripts", "capture-workspaces-window.ps1");
const threshold = Math.max(1, Number(process.env.ACCEPTANCE_TIME_THRESHOLD_SECONDS || 15));

function ps(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { windowsHide: true });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      if (code === 0) resolve((out || "").trim().split(/\r?\n/).filter(Boolean).pop() || "");
      else reject(new Error((err || out || String(code)).trim()));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try { return JSON.parse(candidate); } catch {
    const start = candidate.indexOf("{"); const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) { try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; } }
    return null;
  }
}

function normalizeStation(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function stationMatches(expected, detected) {
  const e = normalizeStation(expected).replace(/^AMAZONNOW/, "");
  const d = normalizeStation(detected).replace(/^AMAZONNOW/, "");
  if (!e || !d) return false;
  if (d.includes(e) || e.includes(d)) return true;
  const eCore = e.replace(/SS$/, ""); const dCore = d.replace(/SS$/, "");
  return Boolean(eCore) && (d.includes(eCore) || dCore.includes(eCore) || eCore.includes(dCore));
}

function looksLocked(analysis) {
  const blob = `${analysis?.blocker || ""} ${analysis?.reason || ""} ${analysis?.station_detected || ""}`.toLowerCase();
  return /lock screen|windows lock|ctrl\+alt\+delete|password|sign.in options|gafoor/.test(blob);
}

async function geminiGenerate(imageBase64, prompt, model) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data: imageBase64 } }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 700 }
      })
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `gemini ${res.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  const parsed = parseJsonObject(text);
  if (!parsed) throw new Error(`bad json: ${text.slice(0, 160)}`);
  return parsed;
}

async function readAcceptance(station, imageBase64) {
  const prompt = [
    "Read Amazon Site Summary screenshot at ~50% zoom.",
    "Read TOP-RIGHT site selector chip exactly as shown (e.g. AmazonNow TCD4, AmazonNow TCC3) into station_detected.",
    "If Windows lock/login screen: page_ok=false and blocker='Windows lock screen'.",
    "If not Site Summary / popup covering: page_ok=false.",
    "List ONLY OID rows with Acceptance Time elapsed > 00:15. Do not invent.",
    `Expected chip: ${expectedChip(station)}`,
    'JSON only: {"page_ok":true,"station_detected":"AmazonNow TCD4","pending_orders":1,"acceptance_time_seconds":27,"acceptance_time_display":"00:27","over_threshold":true,"blocker":"","breakdown":[{"label":"5103","value":"00:27 / 00:15","note":"shemavau"}]}'
  ].join("\n");
  const primary = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const fallbacks = [...new Set([primary, "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash"])];
  let lastError = null;
  for (const model of fallbacks) {
    try {
      return await geminiGenerate(imageBase64, prompt, model);
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      if (!/high demand|unavailable|429|503|404|not found/i.test(msg)) throw error;
      console.warn(`gemini ${model} failed: ${msg}; trying next`);
    }
  }
  throw lastError || new Error("gemini failed");
}

function shortStoreLabel(station, detected) {
  const raw = String(detected || station || "").trim();
  const code = stationCode(raw || station);
  return code || String(station).trim().toUpperCase();
}

function worstClock(a) {
  const fromDisplay = String(a.acceptance_time_display || "");
  if (fromDisplay.includes("/")) return fromDisplay.split("/")[0].trim();
  if (/^\d{1,2}:\d{2}/.test(fromDisplay)) return fromDisplay.trim();
  let worstSec = Number(a.acceptance_time_seconds) || 0;
  for (const row of Array.isArray(a.breakdown) ? a.breakdown : []) {
    const v = String(row?.value || row?.acceptance_time || row || "");
    const m = v.match(/(\d{1,2}):(\d{2})/);
    if (!m) continue;
    const sec = Number(m[1]) * 60 + Number(m[2]);
    if (sec > worstSec) worstSec = sec;
  }
  if (worstSec <= 0) return "";
  const mm = String(Math.floor(worstSec / 60)).padStart(2, "0");
  const ss = String(worstSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function isOverAcceptance(a) {
  return Boolean(a?.over_threshold) && (
    (Array.isArray(a.breakdown) && a.breakdown.length > 0) ||
    Number(a.pending_orders) > 0 ||
    Number(a.acceptance_time_seconds) > threshold
  );
}

function caption(station, a) {
  const code = shortStoreLabel(station, a.station_detected);
  const pending = Number(a.pending_orders);
  const count = Number.isFinite(pending) && pending > 0
    ? pending
    : (Array.isArray(a.breakdown) ? a.breakdown.length : 0);
  const worst = worstClock(a) || "n/a";
  const orderWord = count === 1 ? "order" : "orders";
  return [
    code,
    `* High acceptance time over ${threshold}s SLA`,
    `* ${count} ${orderWord} pending acceptance (Worst ${worst})`,
    "",
    "Move more people to picking"
  ].join("\n").slice(0, 1024);
}

const stationGroupMap = Object.fromEntries(
  String(process.env.AMAZON_STATION_GROUP_JIDS || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(":");
      if (i < 0) return null;
      return [p.slice(0, i).trim().toUpperCase(), p.slice(i + 1).trim()];
    })
    .filter(Boolean)
);

function groupForStation(station) {
  const code = stationCode(station);
  return stationGroupMap[code]
    || process.env.DARK_STORE_OPS_GROUP_JID
    || process.env.DARK_STORE_TESTING_GROUP_JID
    || "";
}

async function send(imageBase64, text, station) {
  const ref = `dstest_${createHash("sha1").update(`${station}|${Date.now()}`).digest("hex").slice(0, 24)}`;
  const url = String(process.env.WHATSAPP_WORKER_URL || "").replace(/\/$/, "");
  const to = groupForStation(station);
  if (!to) throw new Error(`No WhatsApp group for ${station}`);
  const res = await fetch(`${url}/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.WHATSAPP_WORKER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ client_ref: ref, to, image_base64: imageBase64, mime: "image/png", caption: text })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(body));
  return { ref, id: body.id, to };
}

async function switchAndCapture(label, filter) {
  const args = [
    "-Station", filter,
    "-Mode", "Dropdown",
    "-WaitMs", String(waitMs),
    "-DropX", String(dropX),
    "-DropY", String(dropY)
  ];
  console.log(await ps(switchPs, args));
  await sleep(400);
  const out = path.join(state, `hq-${label}-${Date.now()}.png`);
  const saved = await ps(capturePs, ["-OutFile", out, "-Prepare"]);
  const png = saved || out;
  const bytes = await readFile(png);
  await writeFile(path.join(state, `last-${label}.png`), bytes);
  return { png, bytes, hash: createHash("sha1").update(bytes).digest("hex") };
}

function filterCandidates(label, dropdown) {
  const code = stationCode(label);
  const primary = dropdown || code;
  const ss = `${code}_SS`;
  const list = [primary];
  if (!/_SS$/i.test(primary)) list.push(ss);
  if (primary !== code) list.push(code);
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

await mkdir(state, { recursive: true });
const plan = stations.map((s) => ({ label: s, dropdown: dropdownCode(s), chip: expectedChip(s) }));
console.log(JSON.stringify({
  plan,
  wait_ms: waitMs,
  drop: [dropX, dropY],
  to: process.env.DARK_STORE_TESTING_GROUP_JID,
  zoom: "50%",
  note: "fast switch; retry CODE_SS on mismatch"
}, null, 2));

const results = [];
const hashes = new Set();

for (const { label, dropdown, chip } of plan) {
  console.log(`\n=== ${label} → ${chip} ===`);
  try {
    const candidates = filterCandidates(label, dropdown);
    let sentOk = false;
    let lastDetected = null;

    for (let i = 0; i < candidates.length; i++) {
      const filter = candidates[i];
      const { png, bytes, hash } = await switchAndCapture(label, filter);
      console.log(JSON.stringify({ station: label, filter, bytes: bytes.length, hash: hash.slice(0, 12) }));

      if (hashes.has(hash)) {
        console.warn(`${label}: duplicate image after filter=${filter}`);
        await unlink(png).catch(() => null);
        continue;
      }

      const b64 = bytes.toString("base64");
      let analysis;
      try { analysis = await readAcceptance(filter, b64); }
      catch (e) {
        console.error(`${label} gemini: ${e.message}`);
        await unlink(png).catch(() => null);
        if (i === candidates.length - 1) {
          results.push({ station: label, ok: false, skipped: "gemini_failed", error: e.message });
        }
        continue;
      }
      console.log(JSON.stringify({ station: label, filter, analysis }, null, 2));
      lastDetected = analysis.station_detected || null;

      if (looksLocked(analysis) || /lock screen/i.test(String(analysis.blocker || ""))) {
        await unlink(png).catch(() => null);
        console.error("WorkSpaces is locked — aborting cycle. Unlock (View → Send Ctrl+Alt+Delete) and re-run.");
        results.push({ station: label, ok: false, skipped: "workspaces_locked", detected: analysis.station_detected || null });
        console.log("\nDONE", JSON.stringify(results, null, 2));
        process.exit(2);
      }

      if (analysis.page_ok === false) {
        await unlink(png).catch(() => null);
        continue;
      }

      const matched =
        stationMatches(filter, analysis.station_detected) ||
        stationMatches(label, analysis.station_detected) ||
        stationMatches(chip, analysis.station_detected);

      if (!matched) {
        console.warn(`${label}: chip="${analysis.station_detected}" wanted=${filter}; retry next filter`);
        await unlink(png).catch(() => null);
        continue;
      }

      hashes.add(hash);
      if (!isOverAcceptance(analysis)) {
        console.log(`${label}: OK within ${threshold}s SLA — not sending`);
        results.push({
          station: label,
          filter,
          ok: true,
          skipped: "acceptance_ok",
          detected: analysis.station_detected,
          hash: hash.slice(0, 12)
        });
        await unlink(png).catch(() => null);
        sentOk = true;
        break;
      }
      const text = caption(label, analysis);
      console.log(text);
      const sent = await send(b64, text, label);
      console.log("SENT", sent);
      results.push({
        station: label,
        filter,
        ok: true,
        ...sent,
        detected: analysis.station_detected,
        hash: hash.slice(0, 12)
      });
      await unlink(png).catch(() => null);
      sentOk = true;
      break;
    }

    if (!sentOk && !results.some((r) => r.station === label)) {
      results.push({ station: label, ok: false, skipped: "station_mismatch", detected: lastDetected });
    }
  } catch (error) {
    console.error(`${label} FAILED: ${error instanceof Error ? error.message : error}`);
    results.push({ station: label, ok: false, error: String(error instanceof Error ? error.message : error) });
  }
}

console.log("\nDONE", JSON.stringify(results, null, 2));
