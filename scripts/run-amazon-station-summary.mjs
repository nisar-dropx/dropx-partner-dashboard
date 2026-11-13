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

function acceptanceCaption(alert) {
  const text = String(alert.page_text || "").replace(/\s+/g, " ").trim();
  const station = String(alert.station || "").replace(/_SS$/i, "");
  const acceptanceSignal = /acceptance\s*time|pending\s+acceptance/i.test(text)
    || (alert.metrics || []).some((metric) => /acceptance/i.test(`${metric.label} ${metric.value}`));
  if (!acceptanceSignal) return null;

  // Only count the banner's pending orders. An assigned order is not pending
  // for this message, even when its acceptance clock is red.
  const pendingMatch = text.match(/(?:you\s+have\s+)?(\d+)\s+orders?\s+pending\s+acceptance/i);
  const hasUnassigned = /no\s+idle\s+associates/i.test(text);
  const clocks = [...text.matchAll(/(\d{1,2}:\d{2})\s*\/\s*00?:?15\b/gi)].map((match) => match[1]);
  const seconds = (value) => value.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
  const worst = clocks.sort((a, b) => seconds(b) - seconds(a))[0];
  const lines = [station, "* High acceptance time over 15s SLA"];
  if (hasUnassigned && pendingMatch) {
    lines.push(`* ${pendingMatch[1]} order${pendingMatch[1] === "1" ? "" : "s"} pending acceptance${worst ? ` (Worst ${worst})` : ""}`);
  }
  lines.push("", "Move more people to picking");
  return lines.join("\n");
}

function fallbackCaption(alert) {
  const metricLines = (alert.metrics || [])
    .slice(0, 8)
    .map((metric) => `• ${metric.label || "Metric"}${metric.value ? `: ${metric.value}` : ""}`)
    .join("\n");
  const named = (alert.metrics || []).map((metric) => metric.label).filter(Boolean).slice(0, 4);
  const firstAsk = named.length
    ? `1) Clear which first for customer promise — ${named.join(", ")}?`
    : `1) Clear which first for customer promise — Waiting for Orders, Pending Acceptance, Idle, or Productivity?`;
  return [
    `Amazon Quick Commerce · ${alert.station} · Site Summary attention`,
    metricLines || "Attention is showing on one or more store metrics.",
    "",
    "Need now:",
    firstAsk,
    named[0]
      ? `2) Who owns ${named[0]} recovery for the next 15 minutes, and what is ETA to clear?`
      : `2) Who owns recovery for the next 15 minutes, and what is ETA to clear?`
  ].join("\n");
}

async function geminiCaption(alert) {
  const deterministic = acceptanceCaption(alert);
  if (deterministic) return deterministic;
  if (!geminiKey) return fallbackCaption(alert);
  const metricBlock = (alert.metrics || [])
    .map((metric) => `- header: ${metric.label || "unknown"} | value: ${metric.value || "n/a"}`)
    .join("\n") || alert.page_text?.slice(0, 1200) || "Attention metrics detected.";
  const useVision = Boolean(alert.needs_vision_caption || alert.capture_mode === "workspace-stream")
    && Boolean(alert.image_base64);
  const prompt = [
    "You write WhatsApp ops alerts for DropX Amazon Quick Commerce (dark store / NOW) stations.",
    "Audience: store leads and Dark Store Ops.",
    "CRITICAL wording rules:",
    "- Do NOT use the words red, green, amber, color, pixel, screenshot, AI, Gemini, or the phrase 'Site Summary header'.",
    "- Always use the EXACT on-screen metric names (Waiting for Orders, Pending Acceptance, Idle, Productivity, etc.).",
    "- Only include metrics that need attention. Do not invent names or numbers.",
    "Tone: calm, direct, operations.",
    "Return plain text only (no markdown fences, no emoji).",
    "Format:",
    "Line 1: Amazon Quick Commerce · <station> · Site Summary attention",
    "Then 3 to 5 short bullets. Each bullet starts with the exact metric name, then value if known, then store impact.",
    "Then 'Need now:' with exactly 2 questions that NAME those exact metrics, e.g.",
    "  1) Clear Waiting for Orders or Pending Acceptance first for customer promise?",
    "  2) Who owns Waiting for Orders recovery for the next 15 minutes, and what is ETA to clear?",
    "Do not ask generic which-header questions.",
    "",
    `Station: ${alert.station}`,
    "Metrics / values:",
    metricBlock,
    useVision
      ? "If an image is attached, read the exact metric names and values that need attention and use those names in bullets and questions."
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
