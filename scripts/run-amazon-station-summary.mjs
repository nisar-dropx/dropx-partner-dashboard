#!/usr/bin/env node
/**
 * Local/dev runner for Amazon Site Summary red-metric alerts.
 *
 * 1) Calls the Amazon Playwright worker `/station-summary`
 * 2) Uses Gemini to write a short ops caption + one break-up question
 * 3) Posts screenshot alerts to the Dark Store Ops WhatsApp group via the report-bot worker
 * 4) Optionally loops every AMAZON_CHECK_INTERVAL_MINUTES (default 1)
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = process.env.AMAZON_STATION_SUMMARY_STATE_DIR
  || path.join(ROOT, "workers", "amazon-scc-playwright", ".station-summary-state");
const SENT_FILE = path.join(STATE_DIR, "sent-signatures.json");

function splitList(value, fallback = "") {
  return String(value || fallback)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function loadEnvFile(filePath) {
  try {
    await access(filePath);
  } catch {
    return;
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
    if (!(key in process.env)) process.env[key] = value;
  }
}

await loadEnvFile(path.join(ROOT, "workers", "amazon-scc-playwright", ".env.station-summary"));
await loadEnvFile(path.join(ROOT, "workers", "amazon-scc-playwright", ".env"));

const worker = String(process.env.AMAZON_WORKER_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const token = process.env.AMAZON_WORKER_TOKEN || process.env.OPS_PORTAL_WORKER_SECRET || "";
const stations = splitList(process.env.AMAZON_STATIONS, "TCD4_SS,STORE_2,STORE_3,STORE_4,STORE_5");
const intervalMinutes = Number(process.env.AMAZON_CHECK_INTERVAL_MINUTES ?? "1");
const whatsappUrl = String(process.env.WHATSAPP_WORKER_URL || "").replace(/\/$/, "");
const whatsappToken = process.env.WHATSAPP_WORKER_TOKEN || "";
const group = process.env.DARK_STORE_OPS_GROUP_JID || "";
const geminiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.0-flash";

if (!token) {
  console.error("Set AMAZON_WORKER_TOKEN or OPS_PORTAL_WORKER_SECRET.");
  process.exit(1);
}
if (!stations.length) {
  console.error("Set AMAZON_STATIONS to a comma-separated station list.");
  process.exit(1);
}

async function loadSent() {
  try {
    const raw = JSON.parse(await readFile(SENT_FILE, "utf8"));
    return new Map(Object.entries(raw || {}));
  } catch {
    return new Map();
  }
}

async function saveSent(map) {
  await mkdir(STATE_DIR, { recursive: true });
  const entries = [...map.entries()]
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 400);
  await writeFile(SENT_FILE, JSON.stringify(Object.fromEntries(entries), null, 2));
}

function alertSignature(alert) {
  const basis = [
    alert.station || "",
    alert.metric_signature || "",
    ...(alert.metrics || []).map((metric) => `${metric.label}:${metric.value}`)
  ].join("|");
  return createHash("sha1").update(basis).digest("hex");
}

function fallbackCaption(alert) {
  const metricLines = (alert.metrics || [])
    .slice(0, 8)
    .map((metric) => `• ${metric.label ? `${metric.label}: ` : ""}${metric.value}`)
    .join("\n");
  const question = (alert.metrics || []).length > 1
    ? "Which red metric should we break first, and who owns the fix for the next 15 minutes?"
    : "What is the immediate recovery action for this red metric?";
  return [
    `Dark Store Ops · Site Summary red alert`,
    `Station: ${alert.station}`,
    metricLines || "Red condition detected on Site Summary.",
    "",
    `Question: ${question}`
  ].join("\n");
}

async function geminiCaption(alert) {
  if (!geminiKey) return fallbackCaption(alert);
  const metricBlock = (alert.metrics || [])
    .map((metric) => `- ${metric.label || "metric"} = ${metric.value}`)
    .join("\n") || alert.page_text?.slice(0, 1200) || "Red metric detected.";
  const useVision = Boolean(alert.needs_vision_caption || alert.capture_mode === "workspace-stream")
    && Boolean(alert.image_base64);
  const prompt = [
    "You write WhatsApp captions for DropX Dark Store Ops.",
    "Use only the facts visible in the provided metrics/screenshot. Do not invent numbers.",
    "Return plain text only (no markdown fences).",
    "Format:",
    "1) One short headline with the station code",
    "2) Up to 5 bullet lines that break the red metrics into clear actions",
    "3) Exactly one follow-up question asking the group which metric to attack first / how to split ownership",
    "Do not mention AI, Gemini, OCR, or screenshots.",
    "",
    `Station: ${alert.station}`,
    `Capture mode: ${alert.capture_mode || "dom"}`,
    "Red metrics / context:",
    metricBlock,
    useVision
      ? "If a screenshot is attached, read only the red/attention numbers from Amazon Site Summary inside the WorkSpaces desktop and break those metrics into actions."
      : ""
  ].filter(Boolean).join("\n");

  const parts = [{ text: prompt }];
  if (useVision) {
    parts.push({
      inline_data: {
        mime_type: alert.mime || "image/png",
        data: alert.image_base64
      }
    });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": geminiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 350 }
        })
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`Gemini caption failed (${response.status}): ${data?.error?.message || "unknown error"}`);
      return fallbackCaption(alert);
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    return text || fallbackCaption(alert);
  } catch (error) {
    console.error(`Gemini caption error: ${error instanceof Error ? error.message : error}`);
    return fallbackCaption(alert);
  }
}

async function sendWhatsApp(alert, caption) {
  if (!whatsappUrl || !whatsappToken || !group) {
    console.log(`WhatsApp delivery skipped for ${alert.station} (set WHATSAPP_WORKER_URL, WHATSAPP_WORKER_TOKEN, DARK_STORE_OPS_GROUP_JID).`);
    return { skipped: true };
  }
  const response = await fetch(`${whatsappUrl}/send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${whatsappToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      client_ref: `site-summary-${alert.station}-${alertSignature(alert).slice(0, 16)}`,
      to: group,
      image_base64: alert.image_base64,
      mime: alert.mime || "image/png",
      caption: String(caption || "").slice(0, 1024)
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`WhatsApp send failed for ${alert.station}: ${body}`);
  return JSON.parse(body || "{}");
}

async function checkOnce(sent) {
  const started = Date.now();
  const response = await fetch(`${worker}/station-summary`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      stations,
      url: process.env.AMAZON_SITE_SUMMARY_URL || undefined,
      workspaces_url: process.env.AMAZON_WORKSPACES_URL || undefined,
      capture_mode: process.env.AMAZON_CAPTURE_MODE || "auto",
      cdp_url: process.env.AMAZON_CDP_URL || undefined,
      settle_ms: Number(process.env.AMAZON_SETTLE_MS || 1400),
      min_red_pixels: Number(process.env.AMAZON_MIN_RED_PIXELS || 80),
      company_id: process.env.AMAZON_COMPANY_ID || "local-dev",
      username: process.env.AMAZON_USERNAME || "site-summary"
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || result.summary || `Amazon worker returned ${response.status}`);
  }

  console.log(JSON.stringify({
    status: result.status,
    browser_mode: result.browser_mode,
    stations: result.stations,
    alert_count: result.alert_count,
    checked_at: result.checked_at,
    summary: result.summary,
    elapsed_ms: Date.now() - started,
    station_results: (result.station_results || []).map((row) => ({
      station: row.station,
      switched: row.switched,
      red_detected: row.red_detected,
      matching_elements: row.matching_elements,
      metrics: (row.metrics || []).slice(0, 5)
    }))
  }, null, 2));

  for (const alert of result.alerts || []) {
    const signature = alertSignature(alert);
    if (sent.has(signature)) {
      console.log(`Skipping duplicate alert for ${alert.station} (${signature.slice(0, 8)}).`);
      continue;
    }
    const caption = await geminiCaption(alert);
    const sendResult = await sendWhatsApp(alert, caption);
    if (!sendResult?.skipped) {
      sent.set(signature, Date.now());
      await saveSent(sent);
      console.log(`Sent WhatsApp alert for ${alert.station}.`);
    } else {
      // Still remember the signature so dry runs do not spam local logs forever.
      sent.set(signature, Date.now());
      await saveSent(sent);
      console.log(`Captured alert for ${alert.station} without WhatsApp delivery.\n${caption}\n`);
    }
  }

  return result;
}

const sent = await loadSent();
let running = false;

async function tick() {
  if (running) {
    console.warn("Previous Site Summary check is still running; skipping this interval.");
    return;
  }
  running = true;
  try {
    await checkOnce(sent);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

console.log(JSON.stringify({
  worker,
  stations,
  interval_minutes: Number.isFinite(intervalMinutes) ? intervalMinutes : 1,
  capture_mode: process.env.AMAZON_CAPTURE_MODE || "auto",
  workspaces_url: process.env.AMAZON_WORKSPACES_URL
    || "https://ap-southeast-1.webclient.amazonworkspaces.com/wsp.html",
  whatsapp_configured: Boolean(whatsappUrl && whatsappToken && group),
  gemini_configured: Boolean(geminiKey),
  cdp_url: process.env.AMAZON_CDP_URL || null
}, null, 2));

await tick();

const minutes = Number.isFinite(intervalMinutes) ? intervalMinutes : 1;
if (minutes > 0) {
  console.log(`Monitoring every ${minutes} minute(s). Press Ctrl+C to stop.`);
  setInterval(() => {
    tick();
  }, minutes * 60_000);
}
