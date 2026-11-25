/**
 * Create or redeploy the Python Tesseract OCR service on Render, then wire
 * REPORT_IMAGE_OCR_URL / REPORT_IMAGE_OCR_TOKEN into local .env (and print
 * Vercel env commands).
 *
 * Usage (from repo root, after workers/report-image-ocr is on GitHub main):
 *   node scripts/deploy-report-image-ocr-render.mjs
 *
 * Reads render_api_key from .env
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

const envPath = ".env";
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1).replace(/^"|"$/g, "")];
    })
);

const apiKey = env.render_api_key || env.RENDER_API_KEY;
if (!apiKey) {
  console.error("Missing render_api_key in .env");
  process.exit(1);
}

const OWNER_ID = "tea-d9od66u417fc73f2ovf0";
const SERVICE_NAME = "dropx-report-image-ocr";
const DEFAULT_URL = "https://dropx-report-image-ocr.onrender.com";
const headers = {
  authorization: `Bearer ${apiKey}`,
  accept: "application/json",
  "content-type": "application/json"
};

async function listServices() {
  const response = await fetch("https://api.render.com/v1/services?limit=100", { headers });
  if (!response.ok) throw new Error(`List services: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows.map((row) => row.service);
}

async function createService(token) {
  const response = await fetch("https://api.render.com/v1/services", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "web_service",
      name: SERVICE_NAME,
      ownerId: OWNER_ID,
      repo: "https://github.com/nisar-dropx/dropx-partner-dashboard",
      autoDeploy: "yes",
      branch: "main",
      rootDir: "workers/report-image-ocr",
      serviceDetails: {
        env: "docker",
        plan: "free",
        region: "singapore",
        dockerfilePath: "./Dockerfile",
        dockerContext: ".",
        healthCheckPath: "/health",
        numInstances: 1,
        envVars: [
          { key: "REPORT_IMAGE_OCR_TOKEN", value: token },
          { key: "REPORT_IMAGE_OCR_CONCURRENCY", value: "1" },
          { key: "REPORT_IMAGE_OCR_MAX_LONG_EDGE", value: "1600" },
          { key: "REPORT_IMAGE_OCR_MAX_UPLOAD_MB", value: "8" }
        ]
      }
    })
  });
  if (!response.ok) throw new Error(`Create service: ${response.status} ${await response.text()}`);
  return response.json();
}

async function triggerDeploy(serviceId) {
  const response = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys`, {
    method: "POST",
    headers,
    body: JSON.stringify({ clearCache: "clear" })
  });
  if (!response.ok) throw new Error(`Trigger deploy: ${response.status} ${await response.text()}`);
  return response.json();
}

async function getEnvVars(serviceId) {
  const response = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, { headers });
  if (!response.ok) throw new Error(`List env vars: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows.map((row) => row.envVar ?? row);
}

async function upsertEnvVar(serviceId, key, value) {
  const response = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ value })
  });
  if (!response.ok) {
    // Older API shape: POST collection
    const create = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, {
      method: "PUT",
      headers,
      body: JSON.stringify([{ key, value }])
    });
    if (!create.ok) throw new Error(`Set env ${key}: ${response.status}/${create.status} ${await create.text()}`);
  }
}

async function getService(serviceId) {
  const response = await fetch(`https://api.render.com/v1/services/${serviceId}`, { headers });
  if (!response.ok) throw new Error(`Get service: ${response.status} ${await response.text()}`);
  return response.json();
}

async function waitForHealth(url, token, attempts = 36) {
  const healthUrl = `${url.replace(/\/$/, "")}/health`;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(healthUrl, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        cache: "no-store"
      });
      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        if (body.ok !== false) return body;
      }
    } catch {
      // cold start / building
    }
    console.log(`Waiting for OCR health (${i + 1}/${attempts})…`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`OCR service did not become healthy at ${healthUrl}`);
}

function upsertLocalEnv(url, token) {
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const set = (key, value) => {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, line);
    else text = `${text.trimEnd()}\n${line}\n`;
  };
  // Drop stale comment-only placeholders for these keys.
  text = text.replace(/^#\s*REPORT_IMAGE_OCR_URL=.*$/gm, "");
  text = text.replace(/^#\s*REPORT_IMAGE_OCR_TOKEN=.*$/gm, "");
  set("REPORT_IMAGE_OCR_URL", url);
  set("REPORT_IMAGE_OCR_TOKEN", token);
  writeFileSync(envPath, text.endsWith("\n") ? text : `${text}\n`);
}

const services = await listServices();
let existing = services.find((service) => service.name === SERVICE_NAME);
let token = env.REPORT_IMAGE_OCR_TOKEN?.trim() || "";
let serviceId;
let url;

if (existing) {
  serviceId = existing.id;
  console.log(`Service already exists: ${serviceId}`);
  const fresh = await getService(serviceId);
  const service = fresh.service ?? fresh;
  url = service.serviceDetails?.url || existing.serviceDetails?.url || DEFAULT_URL;
  console.log(`URL: ${url}`);

  const envVars = await getEnvVars(serviceId);
  const current = envVars.find((row) => row.key === "REPORT_IMAGE_OCR_TOKEN");
  if (current?.value) token = current.value;
  if (!token) {
    token = randomBytes(24).toString("hex");
    await upsertEnvVar(serviceId, "REPORT_IMAGE_OCR_TOKEN", token);
    console.log("Generated a new REPORT_IMAGE_OCR_TOKEN on the service.");
  }
  await upsertEnvVar(serviceId, "REPORT_IMAGE_OCR_CONCURRENCY", "1").catch(() => undefined);
  await upsertEnvVar(serviceId, "REPORT_IMAGE_OCR_MAX_LONG_EDGE", "1600").catch(() => undefined);
  await upsertEnvVar(serviceId, "REPORT_IMAGE_OCR_MAX_UPLOAD_MB", "8").catch(() => undefined);
  const deploy = await triggerDeploy(serviceId);
  console.log(`Redeploy started: ${deploy.id ?? deploy.deploy?.id ?? "ok"}`);
} else {
  token = randomBytes(24).toString("hex");
  const created = await createService(token);
  const service = created.service ?? created;
  serviceId = service.id;
  url = service.serviceDetails?.url || DEFAULT_URL;
  console.log(`Created ${SERVICE_NAME}: ${serviceId}`);
  console.log(`URL: ${url}`);
}

upsertLocalEnv(url, token);
console.log("Wrote REPORT_IMAGE_OCR_URL and REPORT_IMAGE_OCR_TOKEN to .env");

console.log("");
console.log("Waiting for first healthy response (free tier cold start can take a few minutes)…");
try {
  const health = await waitForHealth(url, null);
  console.log("OCR health OK:", JSON.stringify(health));
} catch (error) {
  console.warn(String(error.message || error));
  console.warn("Deploy may still be building — re-check /health shortly.");
}

console.log("");
console.log("Portal / Vercel env (production + preview):");
console.log(`REPORT_IMAGE_OCR_URL=${url}`);
console.log(`REPORT_IMAGE_OCR_TOKEN=${token}`);
console.log("");
console.log("If vercel CLI is linked, run:");
console.log(`  printf '%s' '${url}' | npx vercel env add REPORT_IMAGE_OCR_URL production`);
console.log(`  printf '%s' '${token}' | npx vercel env add REPORT_IMAGE_OCR_TOKEN production`);
