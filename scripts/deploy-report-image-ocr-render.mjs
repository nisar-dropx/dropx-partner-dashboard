/**
 * Create or redeploy the Python Tesseract OCR service on Render.
 *
 * Usage (from repo root, after the OCR folder is on GitHub main):
 *   node scripts/deploy-report-image-ocr-render.mjs
 *
 * Reads render_api_key from .env
 */
import { readFileSync, randomBytes } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
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
const headers = {
  authorization: `Bearer ${apiKey}`,
  accept: "application/json",
  "content-type": "application/json"
};

async function listServices() {
  const response = await fetch("https://api.render.com/v1/services?limit=50", { headers });
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
          { key: "REPORT_IMAGE_OCR_TOKEN", value: token }
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

const services = await listServices();
const existing = services.find((service) => service.name === SERVICE_NAME);
if (existing) {
  console.log(`Service already exists: ${existing.id}`);
  console.log(`URL: ${existing.serviceDetails?.url ?? existing.dashboardUrl}`);
  const deploy = await triggerDeploy(existing.id);
  console.log(`Redeploy started: ${deploy.id ?? deploy.deploy?.id ?? "ok"}`);
  console.log("Set portal env REPORT_IMAGE_OCR_URL to that URL (token already on the service).");
  process.exit(0);
}

const token = randomBytes(24).toString("hex");
const created = await createService(token);
const service = created.service ?? created;
console.log(`Created ${SERVICE_NAME}: ${service.id}`);
console.log(`URL: ${service.serviceDetails?.url ?? "(pending)"}`);
console.log("");
console.log("Add these to the portal (Vercel) env:");
console.log(`REPORT_IMAGE_OCR_URL=${service.serviceDetails?.url ?? "https://dropx-report-image-ocr.onrender.com"}`);
console.log(`REPORT_IMAGE_OCR_TOKEN=${token}`);
console.log("");
console.log("NOTE: rootDir workers/report-image-ocr must exist on GitHub main before the first build succeeds.");
