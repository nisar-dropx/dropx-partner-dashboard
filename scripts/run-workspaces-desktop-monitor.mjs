#!/usr/bin/env node
/**
 * Host-side Amazon WorkSpaces desktop monitor (standalone pack).
 *
 * Captures the Amazon WorkSpaces desktop-app window from this laptop, detects
 * red Site Summary alerts, writes Gemini wording, and posts a WhatsApp image
 * to the Dark Store Ops group through the existing report-bot worker.
 *
 * Keep WorkSpaces open with Site Summary visible in Firefox inside it.
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = path.resolve(__dirname, "..");
const WORKER_DIR = path.join(PACK_ROOT, "worker");
const require = createRequire(path.join(WORKER_DIR, "package.json"));
const { firefox } = require("playwright");

const STATE_DIR = path.join(WORKER_DIR, ".station-summary-state");
const SENT_FILE = path.join(STATE_DIR, "desktop-sent-signatures.json");
const OUTBOX_DIR = path.join(STATE_DIR, "whatsapp-outbox");
const CAPTURE_SCRIPT = path.join(__dirname, "capture-workspaces-window.ps1");

async function loadEnvFile(filePath, { overwrite = false } = {}) {
  try {
    await access(filePath);
  } catch {
    return false;
  }
  const raw = await readFile(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!overwrite && key in process.env) continue;
    process.env[key] = value;
  }
  return true;
}

// .env.station-summary must win over leftover shell AMAZON_* from prior test runs.
await loadEnvFile(path.join(WORKER_DIR, ".env.station-summary"), { overwrite: true });
await loadEnvFile(path.join(PACK_ROOT, "workers", "amazon-scc-playwright", ".env.station-summary"), { overwrite: false });
await loadEnvFile(path.join(WORKER_DIR, ".env"), { overwrite: false });

const intervalMinutes = Number(process.env.AMAZON_CHECK_INTERVAL_MINUTES ?? "1");
const minRedPixels = Math.max(20, Number(process.env.AMAZON_MIN_RED_PIXELS || 80));
const minWidth = Math.max(200, Number(process.env.AMAZON_MIN_CAPTURE_WIDTH || 400));
const minHeight = Math.max(150, Number(process.env.AMAZON_MIN_CAPTURE_HEIGHT || 300));
const cooldownMinutes = Math.max(1, Number(process.env.AMAZON_ALERT_COOLDOWN_MINUTES || 5));
const screenLockCooldownMinutes = Math.max(5, Number(process.env.SCREEN_LOCK_ALERT_COOLDOWN_MINUTES || 15));
const stations = String(process.env.AMAZON_STATIONS || process.env.AMAZON_ACTIVE_STATION || "TCC3,TCD4")
  .split(",")
  .map((part) => part.trim())
  .filter(Boolean);
const stationTabMap = (() => {
  const map = new Map();
  const raw = String(process.env.AMAZON_STATION_TABS || "").trim();
  if (raw) {
    for (const part of raw.split(",")) {
      const [name, idx] = part.split(":").map((s) => s.trim());
      const n = Number(idx);
      if (name && Number.isFinite(n) && n >= 1 && n <= 8) map.set(name.toUpperCase(), n);
    }
  }
  // Default: AMAZON_STATIONS order = Firefox tab order (1-based).
  stations.forEach((name, i) => {
    const key = name.toUpperCase();
    if (!map.has(key)) map.set(key, i + 1);
  });
  return map;
})();
// Quiet capture = PrintWindow without preparing/focusing for the screenshot itself.
// Station cycling can still run with AMAZON_SWITCH_BACKGROUND=1 (brief focus, then restore).
const quietMonitor = !["0", "false", "no", "off"].includes(
  String(process.env.AMAZON_MONITOR_QUIET ?? "1").trim().toLowerCase()
);
const switchMode = String(
  process.env.AMAZON_STATION_SWITCH_MODE || (quietMonitor ? "Off" : "Dropdown")
).trim() || "Off";
const allowStationSwitch = !["off", "none", "0", "false"].includes(switchMode.toLowerCase())
  && !["1", "true", "yes", "on"].includes(String(process.env.AMAZON_MONITOR_QUIET_NO_SWITCH || "").trim().toLowerCase());
const switchBackground = !["0", "false", "no", "off"].includes(
  String(process.env.AMAZON_SWITCH_BACKGROUND ?? "1").trim().toLowerCase()
);
const useGemini = !["0", "false", "no", "off"].includes(
  String(process.env.AMAZON_USE_GEMINI ?? "1").trim().toLowerCase()
);
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
const dropX = Number(process.env.AMAZON_WS_DROP_X || 0.935);
const dropY = Number(process.env.AMAZON_WS_DROP_Y || 0.195);
const switchWaitMs = Math.max(1800, Number(process.env.AMAZON_STATION_SWITCH_WAIT_MS || 3200));
const whatsappUrl = String(process.env.WHATSAPP_WORKER_URL || process.env.REPORT_BOT_WORKER_URL || "").replace(/\/$/, "");
const whatsappToken = process.env.WHATSAPP_WORKER_TOKEN || process.env.REPORT_BOT_WORKER_TOKEN || "";
const fallbackGroup = process.env.DARK_STORE_OPS_GROUP_JID
  || process.env.DARK_STORE_TESTING_GROUP_JID
  || "";
/** Per-station war room JIDs: TCC3:1203…@g.us,TCD4:… */
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
  const code = String(station || "")
    .trim()
    .toUpperCase()
    .replace(/^AMAZONNOW\s+/, "")
    .replace(/_SS$/, "");
  return stationGroupMap[code] || fallbackGroup;
}
const screenLockAlertTo = String(process.env.SCREEN_LOCK_ALERT_JID || process.env.SCREEN_LOCK_ALERT_PHONE || "919645881397")
  .replace(/\D/g, "");
const screenLockAlertJid = screenLockAlertTo ? `${screenLockAlertTo}@s.whatsapp.net` : "";
const geminiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const acceptanceThresholdSec = Math.max(
  1,
  Number(process.env.ACCEPTANCE_TIME_THRESHOLD_SECONDS || process.env.AMAZON_ACCEPTANCE_TIME_SECONDS || 15)
);
const alertMetric = String(process.env.AMAZON_ALERT_METRIC || "acceptance_time").trim().toLowerCase();
const siteSummaryUrl = process.env.AMAZON_SITE_SUMMARY_URL
  || "https://eu.store-management.f3.amazon.dev/siteSummary";
const SWITCH_SCRIPT = path.join(__dirname, "switch-site-summary-station.ps1");
const KEEPALIVE_SCRIPT = path.join(__dirname, "keepalive-workspaces-window.ps1");
/** Idle keep-alive interval (seconds). 0 disables. Default 180s to beat typical 5–10 min WorkSpaces lock. */
const keepAliveSeconds = Math.max(
  0,
  Number(process.env.AMAZON_WS_KEEPALIVE_SECONDS ?? "180")
);
const keepAliveEnabled = keepAliveSeconds > 0
  && !["0", "false", "no", "off"].includes(String(process.env.AMAZON_WS_KEEPALIVE ?? "1").trim().toLowerCase());
let lastKeepAliveAt = 0;
let lastScreenLockAlertAt = 0;
const recentImageHashes = new Set();

function runPowerShell(scriptPath, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      ...extraArgs
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error((stderr || stdout || `capture exited ${code}`).trim()));
      else resolve((stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "");
    });
  });
}

function stationFilter(station) {
  const code = String(station || "").trim().toUpperCase().replace(/^AMAZONNOW\s+/, "").replace(/_SS$/, "");
  return filterMap[code] || filterMap[String(station).toUpperCase()] || code;
}

async function switchStation(station) {
  const tabIndex = stationTabMap.get(String(station).toUpperCase()) || 1;
  const args = [
    "-Station", stationFilter(station),
    "-TabIndex", String(tabIndex),
    "-Mode", switchMode,
    "-WaitMs", String(switchWaitMs),
    "-DropX", String(dropX),
    "-DropY", String(dropY)
  ];
  if (switchBackground) args.push("-Background");
  if (process.env.AMAZON_WS_MENU_X) args.push("-MenuX", String(process.env.AMAZON_WS_MENU_X));
  if (process.env.AMAZON_WS_MENU_Y) args.push("-MenuY", String(process.env.AMAZON_WS_MENU_Y));
  return runPowerShell(SWITCH_SCRIPT, args);
}

async function countRedPixels(pngPath) {
  const bytes = await readFile(pngPath);
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await page.evaluate(async ({ imageBase64, threshold }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${imageBase64}`;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Unable to decode WorkSpaces screenshot."));
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const x0 = Math.floor(canvas.width * 0.08);
      const y0 = Math.floor(canvas.height * 0.12);
      const x1 = Math.floor(canvas.width * 0.92);
      const y1 = Math.floor(canvas.height * 0.95);
      const w = Math.max(1, x1 - x0);
      const h = Math.max(1, y1 - y0);
      const { data } = ctx.getImageData(x0, y0, w, h);
      let red = 0;
      for (let i = 0; i < data.length; i += 16) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 180) continue;
        if (r >= 160 && g <= 110 && b <= 110 && (r - Math.max(g, b)) >= 40) red += 1;
      }
      let white = 0;
      let blueish = 0;
      let samples = 0;
      for (let i = 0; i < data.length; i += 64) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 180) continue;
        samples += 1;
        if (r >= 235 && g >= 235 && b >= 235) white += 1;
        // Windows Bloom lock wallpaper + dark login: strong blue dominance, little UI chrome.
        if (b > r + 25 && b > g + 10 && b >= 80 && b <= 210 && r <= 120) blueish += 1;
      }
      const white_ratio = samples ? white / samples : 0;
      const blue_ratio = samples ? blueish / samples : 0;
      // Loading / disconnect pages are mostly white and must not page Dark Store Ops.
      const invalid_workspace =
        white_ratio >= 0.72
        || (white_ratio >= 0.55 && red >= threshold * 8);
      // Locked WorkSpaces session (Ctrl+Alt+Delete / password prompt) — not Site Summary.
      const locked_workspace =
        !invalid_workspace
        && red < Math.max(10, threshold / 4)
        && white_ratio < 0.18
        && blue_ratio >= 0.35;
      return {
        detected: !invalid_workspace && !locked_workspace && red >= threshold,
        red_pixels: red,
        width: canvas.width,
        height: canvas.height,
        white_ratio: Number(white_ratio.toFixed(3)),
        blue_ratio: Number(blue_ratio.toFixed(3)),
        invalid_workspace,
        locked_workspace
      };
    }, { imageBase64: bytes.toString("base64"), threshold: minRedPixels });
  } finally {
    await browser.close().catch(() => null);
  }
}

async function loadSent() {
  try {
    return new Map(Object.entries(JSON.parse(await readFile(SENT_FILE, "utf8")) || {}));
  } catch {
    return new Map();
  }
}

async function saveSent(map) {
  await mkdir(STATE_DIR, { recursive: true });
  const entries = [...map.entries()].sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 400);
  await writeFile(SENT_FILE, JSON.stringify(Object.fromEntries(entries), null, 2));
}

function alertSignature(station, acceptanceSeconds) {
  const band = Math.round(Number(acceptanceSeconds || 0) / 5) * 5;
  return createHash("sha1").update(`${station}|acceptance_time|${band}|${acceptanceThresholdSec}`).digest("hex");
}

function clientRefFor(signature) {
  return `wsdesk_${signature.slice(0, 24)}`;
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function formatAcceptanceClock(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return null;
  const s = Math.round(totalSeconds);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function normalizeOidLabel(label) {
  const raw = String(label || "").trim();
  if (!raw) return "";
  if (/^oid\b/i.test(raw)) return raw.replace(/^oid\s*/i, "OID ");
  if (/^\d+$/.test(raw)) return `OID ${raw}`;
  return raw;
}

function buildAcceptanceCaption(station, analysis) {
  const code = String(station || "")
    .trim()
    .toUpperCase()
    .replace(/^AMAZONNOW\s+/, "")
    .replace(/_SS$/, "") || "STORE";
  const seconds = Number(analysis.acceptance_time_seconds) || 0;
  const rawClock = analysis.acceptance_time_display
    || formatAcceptanceClock(seconds)
    || "n/a";
  const clock = String(rawClock).includes("/")
    ? String(rawClock).split("/")[0].trim()
    : String(rawClock).trim();
  const pending = Number.isFinite(Number(analysis.pending_orders))
    ? Number(analysis.pending_orders)
    : (Array.isArray(analysis.breakdown) ? analysis.breakdown.length : 0);
  const orderWord = pending === 1 ? "order" : "orders";
  return [
    code,
    `* High acceptance time over ${acceptanceThresholdSec}s SLA`,
    `* ${pending} ${orderWord} pending acceptance (Worst ${clock || "n/a"})`,
    "",
    "Move more people to picking"
  ].join("\n").slice(0, 1024);
}

async function readAcceptanceTime(station, imageBase64) {
  if (!geminiKey) {
    return { ok: false, reason: "missing_gemini", over_threshold: false };
  }
  const prompt = [
    "You are reading Amazon Quick Commerce Site Summary (HWMS) from a WorkSpaces Firefox screenshot.",
    `Expected page: ${siteSummaryUrl}`,
    "If the image is a WorkSpaces loading screen, Midway login, disconnect page, Windows Task View, or not Site Summary: set visible=false and page_ok=false.",
    "Focus ONLY on Acceptance Time / orders pending acceptance.",
    "Acceptance Time is elapsed / SLA like 02:45 / 00:15 (mm:ss). 00:15 = 15 seconds.",
    "Read the red Attention banner for pending acceptance count.",
    "Read station/store code if visible (e.g. TCC3, TCD4). Prefer on-screen station over the hint.",
    "List each visible OID with Acceptance Time and Assigned Associate. Do not invent rows.",
    `Station hint (may be wrong if quiet capture of whatever tab is open): ${station}`,
    `Alert if worst elapsed Acceptance Time >= ${acceptanceThresholdSec} seconds.`,
    "Return JSON only:",
    JSON.stringify({
      page_ok: true,
      visible: true,
      station_detected: "TCD4",
      pending_orders: 4,
      acceptance_time_seconds: 165,
      acceptance_time_display: "02:45",
      over_threshold: true,
      blocker: "No Idle Associates — pickers unavailable to accept",
      breakdown: [
        { label: "5559", value: "02:45 / 00:15", note: "No Idle Associates" }
      ]
    })
  ].join("\n");
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": geminiKey, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              { inline_data: { mime_type: "image/png", data: imageBase64 } }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
        })
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`Acceptance read failed (${response.status}): ${data?.error?.message || "unknown"}`);
      return { ok: false, reason: data?.error?.message || `http_${response.status}`, over_threshold: false };
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim() || "";
    const parsed = parseJsonObject(text);
    if (!parsed) {
      console.error("Acceptance read returned non-JSON.");
      return { ok: false, reason: "bad_json", over_threshold: false, raw: text.slice(0, 200) };
    }
    const secondsRaw = parsed.acceptance_time_seconds ?? parsed.seconds ?? parsed.value_seconds;
    const seconds = Number(secondsRaw);
    const pageOk = parsed.page_ok !== false;
    const visible = pageOk && parsed.visible !== false;
    const overFromModel = Boolean(parsed.over_threshold);
    const over_threshold = visible && (
      overFromModel
      || (Number.isFinite(seconds) && seconds >= acceptanceThresholdSec)
    );
    const pending = Number(parsed.pending_orders ?? parsed.pending ?? parsed.orders_pending);
    const detected = String(parsed.station_detected || parsed.station || "").trim().toUpperCase();
    return {
      ok: true,
      page_ok: pageOk,
      visible,
      station_detected: detected || null,
      pending_orders: Number.isFinite(pending) ? pending : null,
      acceptance_time_seconds: Number.isFinite(seconds) ? seconds : null,
      acceptance_time_display: String(parsed.acceptance_time_display || "").trim() || null,
      over_threshold,
      metric_title: String(parsed.metric_title || "Acceptance Time"),
      breakdown: Array.isArray(parsed.breakdown) ? parsed.breakdown : [],
      blocker: String(parsed.blocker || "").trim(),
      summary: String(parsed.summary || parsed.blocker || "").trim()
    };
  } catch (error) {
    console.error(`Acceptance read error: ${error instanceof Error ? error.message : error}`);
    return { ok: false, reason: error instanceof Error ? error.message : String(error), over_threshold: false };
  }
}

function whatsappConfigured() {
  return Boolean(whatsappUrl && whatsappToken && (fallbackGroup || Object.keys(stationGroupMap).length));
}

async function sendWhatsApp({ to, clientRef, text, imageBase64, caption }) {
  if (!whatsappUrl || !whatsappToken || !to) {
    return { skipped: true, reason: "missing_whatsapp_env" };
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientRef)) {
    throw new Error(`Invalid client_ref: ${clientRef}`);
  }
  const payload = imageBase64
    ? {
      client_ref: clientRef,
      to,
      image_base64: imageBase64,
      mime: "image/png",
      caption: String(caption || "").slice(0, 1024)
    }
    : {
      client_ref: clientRef,
      to,
      text: String(text || "").slice(0, 4000)
    };
  const response = await fetch(`${whatsappUrl}/send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${whatsappToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`WhatsApp send failed (${response.status}): ${body}`);
  try {
    return JSON.parse(body || "{}");
  } catch {
    return { ok: true, raw: body };
  }
}

function isScreenLockError(error) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return /too small|not found|screen lock|locked|restore\/open|unlock/i.test(message);
}

async function keepWorkSpacesAwake(force = false) {
  if (!keepAliveEnabled) return { skipped: "disabled" };
  if (!force && lastKeepAliveAt && Date.now() - lastKeepAliveAt < keepAliveSeconds * 1000) {
    return { skipped: "cooldown" };
  }
  try {
    const args = [];
    if (switchBackground) args.push("-Background");
    const out = await runPowerShell(KEEPALIVE_SCRIPT, args);
    lastKeepAliveAt = Date.now();
    console.log(`WorkSpaces keep-alive: ${out || "ok"}`);
    return { ok: true, out };
  } catch (error) {
    console.warn(`WorkSpaces keep-alive failed: ${error instanceof Error ? error.message : error}`);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function alertScreenLock(reason) {
  if (!screenLockAlertJid) return;
  if (Date.now() - lastScreenLockAlertAt < screenLockCooldownMinutes * 60_000) {
    console.log("Screen-lock alert suppressed by cooldown.");
    return;
  }
  const text = [
    "Amazon Quick Commerce · WorkSpaces monitor issue",
    `Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    `Issue: ${reason}`,
    `Stations paused: ${stations.join(", ") || "n/a"}`,
    "Unlock WorkSpaces (View → Send Ctrl+Alt+Delete), open Site Summary in Firefox.",
    "Tip: in WorkSpaces Windows set Screen saver = None and require sign-in on wake = Never so idle lock stops returning."
  ].join("\n");
  try {
    if (!whatsappUrl || !whatsappToken) {
      console.error("Screen-lock alert not sent (WhatsApp worker env missing).");
      console.error(text);
      return;
    }
    await sendWhatsApp({
      to: screenLockAlertJid,
      clientRef: `wslock_${Date.now().toString(36)}`,
      text
    });
    lastScreenLockAlertAt = Date.now();
    console.log(`Screen-lock alert sent to ${screenLockAlertJid}.`);
  } catch (error) {
    console.error(`Screen-lock alert failed: ${error instanceof Error ? error.message : error}`);
    console.error(text);
  }
}

async function enqueueOutbox(payload) {
  await mkdir(OUTBOX_DIR, { recursive: true });
  const file = path.join(OUTBOX_DIR, `${payload.client_ref}.json`);
  await writeFile(file, JSON.stringify(payload));
  return file;
}

async function flushOutbox() {
  if (!whatsappConfigured()) return { sent: 0, skipped: true };
  let files = [];
  try {
    files = (await readdir(OUTBOX_DIR)).filter((name) => name.endsWith(".json"));
  } catch {
    return { sent: 0 };
  }
  let sentCount = 0;
  for (const name of files) {
    const file = path.join(OUTBOX_DIR, name);
    try {
      const payload = JSON.parse(await readFile(file, "utf8"));
      const caption = String(payload.caption || "");
      if (/\bred\b|pixel|Site Summary red alert/i.test(caption)) {
        await unlink(file).catch(() => null);
        console.warn(`Dropped stale outbox ${payload.client_ref} (old red-alert wording).`);
        continue;
      }
      await sendWhatsApp({
        to: groupForStation(payload.station) || fallbackGroup,
        clientRef: payload.client_ref,
        imageBase64: payload.image_base64,
        caption
      });
      await unlink(file).catch(() => null);
      sentCount += 1;
      console.log(`Flushed outbox WhatsApp image ${payload.client_ref}.`);
    } catch (error) {
      console.error(`Outbox flush failed for ${name}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return { sent: sentCount };
}

async function deliverAlert({ imageBase64, caption, clientRef, station, redPixels }) {
  if (!whatsappConfigured()) {
    await enqueueOutbox({
      client_ref: clientRef,
      station,
      red_pixels: redPixels,
      caption,
      image_base64: imageBase64,
      mime: "image/png",
      created_at: new Date().toISOString()
    });
    console.log("WhatsApp env missing — screenshot queued in outbox. Set WHATSAPP_WORKER_URL, WHATSAPP_WORKER_TOKEN, DARK_STORE_OPS_GROUP_JID.");
    console.log(caption);
    return { queued: true };
  }
  try {
    const to = groupForStation(station);
    if (!to) throw new Error(`No WhatsApp group configured for station ${station}`);
    const result = await sendWhatsApp({
      to,
      clientRef,
      imageBase64,
      caption
    });
    console.log(`WhatsApp image sent for ${station} → ${to}.`);
    return result;
  } catch (error) {
    await enqueueOutbox({
      client_ref: clientRef,
      station,
      red_pixels: redPixels,
      caption,
      image_base64: imageBase64,
      mime: "image/png",
      created_at: new Date().toISOString(),
      last_error: error instanceof Error ? error.message : String(error)
    });
    console.error(`${error instanceof Error ? error.message : error} — queued for retry.`);
    return { queued: true, error: true };
  }
}

async function checkStation(sent, station, { cycleHashes }) {
  if (allowStationSwitch && stations.length > 1) {
    try {
      await switchStation(station);
      // Give Firefox Site Summary a moment after an interruptive tab switch.
      await new Promise((r) => setTimeout(r, 1500));
    } catch (error) {
      if (isScreenLockError(error)) throw error;
      console.warn(`Station switch to ${station} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  const outFile = path.join(STATE_DIR, `workspaces-capture-${station}-${Date.now()}.png`);
  await mkdir(STATE_DIR, { recursive: true });
  const saved = await runPowerShell(CAPTURE_SCRIPT, ["-OutFile", outFile, "-Quiet"]);
  const pngPath = saved || outFile;
  const red = await countRedPixels(pngPath);
  const imageBytes = await readFile(pngPath);
  const imageHash = createHash("sha1").update(imageBytes).digest("hex");

  console.log(JSON.stringify({
    station,
    quiet: quietMonitor,
    switch: allowStationSwitch,
    tab: stationTabMap.get(String(station).toUpperCase()) || null,
    attention_detected: red.detected,
    attention_score: red.red_pixels,
    white_ratio: red.white_ratio,
    blue_ratio: red.blue_ratio ?? null,
    invalid_workspace: Boolean(red.invalid_workspace),
    locked_workspace: Boolean(red.locked_workspace),
    image_hash: imageHash.slice(0, 12),
    size: `${red.width}x${red.height}`,
    checked_at: new Date().toISOString()
  }, null, 2));

  if (red.width < minWidth || red.height < minHeight) {
    await unlink(pngPath).catch(() => null);
    throw new Error(`Amazon WorkSpaces window is too small (${red.width}x${red.height}). Keep WorkSpaces open (not minimized).`);
  }

  if (red.locked_workspace) {
    await unlink(pngPath).catch(() => null);
    throw new Error("Amazon WorkSpaces screen lock detected. Unlock/restore the screen.");
  }

  if (red.invalid_workspace) {
    await unlink(pngPath).catch(() => null);
    console.warn(`Skipping ${station}: WorkSpaces is loading/disconnected — open ${siteSummaryUrl} in Firefox.`);
    return { ...red, skipped: "invalid_workspace" };
  }

  if (cycleHashes.has(imageHash)) {
    await unlink(pngPath).catch(() => null);
    console.warn(`Skipping ${station}: identical capture already used this cycle (same image would be resent).`);
    return { ...red, skipped: "duplicate_image" };
  }

  // Red cells/banner = acceptance issue signal (no AI). Skip clean stores.
  if (!red.detected) {
    await unlink(pngPath).catch(() => null);
    return { ...red, skipped: "no_red_acceptance_signal" };
  }

  const imageBase64 = imageBytes.toString("base64");
  let acceptance;
  if (useGemini && geminiKey) {
    acceptance = await readAcceptanceTime(station, imageBase64);
  } else {
    // No AI: scripts already switched + captured; alert from red-pixel signal only.
    acceptance = {
      ok: true,
      page_ok: true,
      visible: true,
      over_threshold: true,
      station_detected: station,
      pending_orders: 0,
      acceptance_time_seconds: acceptanceThresholdSec,
      acceptance_time_display: "",
      breakdown: [],
      reason: "red_pixel_only"
    };
  }
  const resolvedStation = (
    acceptance.station_detected
    && stations.map((s) => s.toUpperCase()).includes(
      String(acceptance.station_detected).toUpperCase().replace(/^AMAZONNOW\s+/, "").replace(/_SS$/, "")
    )
  ) ? acceptance.station_detected : station;

  console.log(JSON.stringify({
    station: resolvedStation,
    station_hint: station,
    metric: "acceptance_time",
    gemini: Boolean(useGemini && geminiKey),
    page_ok: acceptance.page_ok ?? null,
    threshold_seconds: acceptanceThresholdSec,
    acceptance_ok: acceptance.ok,
    acceptance_visible: acceptance.visible ?? null,
    acceptance_time_seconds: acceptance.acceptance_time_seconds ?? null,
    over_threshold: Boolean(acceptance.over_threshold),
    breakdown_rows: Array.isArray(acceptance.breakdown) ? acceptance.breakdown.length : 0
  }));

  if (useGemini && (!acceptance.ok || acceptance.page_ok === false || acceptance.visible === false)) {
    await unlink(pngPath).catch(() => null);
    console.warn(`Skipping ${station}: Site Summary / Acceptance Time not readable (${acceptance.reason || "page"}).`);
    return { ...red, skipped: "acceptance_unreadable", acceptance };
  }

  if (!acceptance.over_threshold) {
    await unlink(pngPath).catch(() => null);
    return { ...red, skipped: "acceptance_ok", acceptance };
  }

  const sig = alertSignature(resolvedStation, acceptance.acceptance_time_seconds);
  const lastSentAt = Number(sent.get(sig) || 0);
  if (lastSentAt && Date.now() - lastSentAt < cooldownMinutes * 60_000) {
    console.log(`Skipping duplicate/cooldown Acceptance Time alert for ${resolvedStation} (${sig.slice(0, 8)}).`);
    await unlink(pngPath).catch(() => null);
    return { ...red, skipped: "cooldown", acceptance };
  }

  const caption = buildAcceptanceCaption(resolvedStation, acceptance);
  const clientRef = clientRefFor(sig);
  await deliverAlert({
    imageBase64,
    caption,
    clientRef,
    station: resolvedStation,
    redPixels: acceptance.acceptance_time_seconds ?? red.red_pixels
  });
  cycleHashes.add(imageHash);
  recentImageHashes.add(imageHash);
  sent.set(sig, Date.now());
  await saveSent(sent);
  await unlink(pngPath).catch(() => null);
  return { ...red, acceptance, station: resolvedStation };
}

async function checkOnce(sent) {
  await flushOutbox();
  // Reset remote idle clock before the cycle so Windows lock is less likely mid-run.
  await keepWorkSpacesAwake(true);
  const cycleHashes = new Set();
  if (!allowStationSwitch) {
    // No switch: one quiet capture of whatever Site Summary site is already visible.
    const visibleHint = stations[0] || "ACTIVE";
    await checkStation(sent, visibleHint, { cycleHashes });
    return;
  }
  // One-by-one: switch → quiet capture → alert only if acceptance is over SLA.
  for (const station of stations) {
    await checkStation(sent, station, { cycleHashes });
  }
}

const sent = await loadSent();
let running = false;

async function tick() {
  if (running) {
    console.warn("Previous capture still running; skip.");
    return;
  }
  running = true;
  try {
    await checkOnce(sent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (isScreenLockError(error)) {
      await alertScreenLock(message);
    }
  } finally {
    running = false;
  }
}

console.log(JSON.stringify({
  mode: "workspaces-desktop-host",
  pack_root: PACK_ROOT,
  quiet_capture: quietMonitor,
  allow_station_switch: allowStationSwitch,
  switch_background: switchBackground,
  use_gemini_for_caption_numbers: useGemini && Boolean(geminiKey),
  stations,
  station_filters: Object.fromEntries([...stations.map((s) => [s, stationFilter(s)])]),
  switch_mode: switchMode,
  site_summary_url: siteSummaryUrl,
  alert_group_fallback: fallbackGroup || null,
  station_group_jids: stationGroupMap,
  screen_lock_alert_jid: screenLockAlertJid || null,
  keepalive_seconds: keepAliveEnabled ? keepAliveSeconds : 0,
  interval_minutes: Number.isFinite(intervalMinutes) ? intervalMinutes : 1,
  alert_metric: alertMetric,
  acceptance_threshold_seconds: acceptanceThresholdSec,
  min_red_pixels: minRedPixels,
  min_capture: `${minWidth}x${minHeight}`,
  cooldown_minutes: cooldownMinutes,
  whatsapp_configured: whatsappConfigured(),
  gemini_configured: Boolean(geminiKey),
  note: allowStationSwitch
    ? "Cron cycles every station one-by-one (script switch, not AI). Captures quietly; only WhatsApps stores with acceptance issues. Background switch + keep-alive restore your previous window and stop idle lock."
    : "No station switch — leave Site Summary on the store to watch. Capture is quiet PrintWindow; keep-alive still nudges WorkSpaces so it does not lock."
}, null, 2));

await tick();
const minutes = Number.isFinite(intervalMinutes) ? intervalMinutes : 1;
if (minutes > 0) {
  console.log(`WorkSpaces station monitor every ${minutes} minute(s). Ctrl+C to stop.`);
  setInterval(() => { tick(); }, minutes * 60_000);
}
if (keepAliveEnabled) {
  const ms = Math.max(30, keepAliveSeconds) * 1000;
  console.log(`WorkSpaces keep-alive every ${keepAliveSeconds}s (brief Background nudge).`);
  setInterval(() => { keepWorkSpacesAwake(false); }, ms);
}
