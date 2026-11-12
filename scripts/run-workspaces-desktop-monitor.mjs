#!/usr/bin/env node
/**
 * Host-side Amazon WorkSpaces desktop monitor.
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
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(path.join(ROOT, "workers", "amazon-scc-playwright", "package.json"));
const { firefox } = require("playwright");

const STATE_DIR = path.join(ROOT, "workers", "amazon-scc-playwright", ".station-summary-state");
const SENT_FILE = path.join(STATE_DIR, "desktop-sent-signatures.json");
const OUTBOX_DIR = path.join(STATE_DIR, "whatsapp-outbox");
const CAPTURE_SCRIPT = path.join(__dirname, "capture-workspaces-window.ps1");

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

await loadEnvFile(path.join(ROOT, ".env"));
await loadEnvFile(path.join(ROOT, "workers", "amazon-scc-playwright", ".env.station-summary"));
await loadEnvFile(path.join(ROOT, "workers", "amazon-scc-playwright", ".env"));

const intervalMinutes = Number(process.env.AMAZON_CHECK_INTERVAL_MINUTES ?? "1");
const minRedPixels = Math.max(20, Number(process.env.AMAZON_MIN_RED_PIXELS || 80));
const minWidth = Math.max(200, Number(process.env.AMAZON_MIN_CAPTURE_WIDTH || 400));
const minHeight = Math.max(150, Number(process.env.AMAZON_MIN_CAPTURE_HEIGHT || 300));
const cooldownMinutes = Math.max(1, Number(process.env.AMAZON_ALERT_COOLDOWN_MINUTES || 5));
const stationLabel = String(
  process.env.AMAZON_ACTIVE_STATION
  || (process.env.AMAZON_STATIONS || "ACTIVE").split(",")[0]
  || "ACTIVE"
).trim() || "ACTIVE";
const whatsappUrl = String(process.env.WHATSAPP_WORKER_URL || process.env.REPORT_BOT_WORKER_URL || "").replace(/\/$/, "");
const whatsappToken = process.env.WHATSAPP_WORKER_TOKEN || process.env.REPORT_BOT_WORKER_TOKEN || "";
const group = process.env.DARK_STORE_OPS_GROUP_JID || "";
const geminiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.0-flash";

function runPowerShell(scriptPath, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-OutFile", outFile
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error((stderr || stdout || `capture exited ${code}`).trim()));
      else resolve((stdout || outFile).trim().split(/\r?\n/).filter(Boolean).pop());
    });
  });
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
      // Ignore outer chrome (WorkSpaces title bar / window controls) to reduce false reds.
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
      return { detected: red >= threshold, red_pixels: red, width: canvas.width, height: canvas.height };
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

function alertSignature(station, redPixels, width, height) {
  const band = Math.round(redPixels / 25) * 25;
  const sizeBand = `${Math.round(width / 50) * 50}x${Math.round(height / 50) * 50}`;
  return createHash("sha1").update(`${station}|${band}|${sizeBand}`).digest("hex");
}

function clientRefFor(signature) {
  return `wsdesk_${signature.slice(0, 24)}`;
}

function fallbackCaption(station, redPixels) {
  return [
    `Dark Store Ops · WorkSpaces Site Summary red alert`,
    `Station focus: ${station}`,
    `Red alert pixels detected: ${redPixels}`,
    "",
    "Question: Which red metric should we break first, and who owns the next 15 minutes?"
  ].join("\n");
}

async function geminiCaption(station, redPixels, imageBase64) {
  if (!geminiKey) return fallbackCaption(station, redPixels);
  const prompt = [
    "You write WhatsApp captions for DropX Dark Store Ops.",
    "This screenshot is Amazon Site Summary inside Amazon WorkSpaces (Firefox).",
    "Read only the red/attention metrics. Do not invent numbers.",
    "Return plain text only.",
    "Format: short headline with station, up to 5 bullets breaking the metrics, exactly one follow-up question about which metric to attack first.",
    `Station focus: ${station}`,
    `Approximate red alert pixels: ${redPixels}`
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
          generationConfig: { temperature: 0.2, maxOutputTokens: 350 }
        })
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`Gemini caption failed (${response.status}): ${data?.error?.message || "unknown"}`);
      return fallbackCaption(station, redPixels);
    }
    return data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim()
      || fallbackCaption(station, redPixels);
  } catch (error) {
    console.error(`Gemini caption error: ${error instanceof Error ? error.message : error}`);
    return fallbackCaption(station, redPixels);
  }
}

function whatsappConfigured() {
  return Boolean(whatsappUrl && whatsappToken && group);
}

async function sendWhatsApp(imageBase64, caption, clientRef) {
  if (!whatsappConfigured()) {
    return { skipped: true, reason: "missing_whatsapp_env" };
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientRef)) {
    throw new Error(`Invalid client_ref: ${clientRef}`);
  }
  const response = await fetch(`${whatsappUrl}/send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${whatsappToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      client_ref: clientRef,
      to: group,
      image_base64: imageBase64,
      mime: "image/png",
      caption: String(caption || "").slice(0, 1024)
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`WhatsApp send failed (${response.status}): ${body}`);
  try {
    return JSON.parse(body || "{}");
  } catch {
    return { ok: true, raw: body };
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
  let sent = 0;
  for (const name of files) {
    const file = path.join(OUTBOX_DIR, name);
    try {
      const payload = JSON.parse(await readFile(file, "utf8"));
      await sendWhatsApp(payload.image_base64, payload.caption, payload.client_ref);
      await unlink(file).catch(() => null);
      sent += 1;
      console.log(`Flushed outbox WhatsApp image ${payload.client_ref}.`);
    } catch (error) {
      console.error(`Outbox flush failed for ${name}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return { sent };
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
    const result = await sendWhatsApp(imageBase64, caption, clientRef);
    console.log(`WhatsApp image sent for ${station}.`);
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

async function checkOnce(sent) {
  await flushOutbox();
  const outFile = path.join(STATE_DIR, `workspaces-capture-${Date.now()}.png`);
  await mkdir(STATE_DIR, { recursive: true });
  const saved = await runPowerShell(CAPTURE_SCRIPT, outFile);
  const pngPath = saved || outFile;
  const red = await countRedPixels(pngPath);

  console.log(JSON.stringify({
    station: stationLabel,
    red_detected: red.detected,
    red_pixels: red.red_pixels,
    size: `${red.width}x${red.height}`,
    checked_at: new Date().toISOString()
  }, null, 2));

  if (red.width < minWidth || red.height < minHeight) {
    console.warn(`Capture too small (${red.width}x${red.height}); keep WorkSpaces open (not minimized).`);
    await unlink(pngPath).catch(() => null);
    return { ...red, skipped: "too_small" };
  }

  if (!red.detected) {
    await unlink(pngPath).catch(() => null);
    return red;
  }

  const sig = alertSignature(stationLabel, red.red_pixels, red.width, red.height);
  const lastSentAt = Number(sent.get(sig) || 0);
  if (lastSentAt && Date.now() - lastSentAt < cooldownMinutes * 60_000) {
    console.log(`Skipping duplicate/cooldown alert (${sig.slice(0, 8)}).`);
    await unlink(pngPath).catch(() => null);
    return { ...red, skipped: "cooldown" };
  }

  const imageBase64 = (await readFile(pngPath)).toString("base64");
  const caption = await geminiCaption(stationLabel, red.red_pixels, imageBase64);
  const clientRef = clientRefFor(sig);
  await deliverAlert({ imageBase64, caption, clientRef, station: stationLabel, redPixels: red.red_pixels });
  sent.set(sig, Date.now());
  await saveSent(sent);
  await unlink(pngPath).catch(() => null);
  return red;
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
    console.error(error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

console.log(JSON.stringify({
  mode: "workspaces-desktop-host",
  station: stationLabel,
  interval_minutes: Number.isFinite(intervalMinutes) ? intervalMinutes : 1,
  min_red_pixels: minRedPixels,
  min_capture: `${minWidth}x${minHeight}`,
  cooldown_minutes: cooldownMinutes,
  whatsapp_configured: whatsappConfigured(),
  gemini_configured: Boolean(geminiKey),
  note: "Keep Amazon WorkSpaces open with Site Summary (Firefox) visible inside it."
}, null, 2));

await tick();
const minutes = Number.isFinite(intervalMinutes) ? intervalMinutes : 1;
if (minutes > 0) {
  console.log(`Monitoring WorkSpaces window every ${minutes} minute(s). Ctrl+C to stop.`);
  setInterval(() => { tick(); }, minutes * 60_000);
}
