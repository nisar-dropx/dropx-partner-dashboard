import http from "node:http";
import crypto from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, firefox } from "playwright";

const PORT = Number(process.env.PORT || 8080);
const WORKER_SECRET = process.env.OPS_PORTAL_WORKER_SECRET || process.env.WORKER_SECRET || "";
const HEADLESS = String(process.env.HEADLESS ?? "true").toLowerCase() !== "false";
const SLOW_MO_MS = Number(process.env.SLOW_MO_MS || 0);
// Keep the worker comfortably inside Vercel's request ceiling even if an older
// deployment still supplies the previous six-minute environment value.
const WORKER_TIMEOUT_MS = Math.min(Number(process.env.WORKER_TIMEOUT_MS || 180000), 180000);
const DEBUG_ARTIFACT_DIR = process.env.DEBUG_ARTIFACT_DIR || "";
const SESSION_STATE_DIR = process.env.SESSION_STATE_DIR || path.join(process.cwd(), ".amazon-portal-sessions");
// A scheduled check must report that human approval is needed instead of
// occupying the only browser slot for several minutes. The operator can finish
// the challenge in noVNC and retry immediately.
const MANUAL_APPROVAL_WAIT_MS = Math.min(
  Number(process.env.MANUAL_APPROVAL_WAIT_MS || 30000),
  30000,
  Math.max(WORKER_TIMEOUT_MS - 15000, 10000)
);
const ENABLE_VNC = String(process.env.ENABLE_VNC || "false").toLowerCase() === "true";
const NOVNC_PORT = Number(process.env.NOVNC_PORT || 6080);

const DRIVER_RECON_URL = "https://www.amazonlogistics.eu/station/dashboard/driverreconciliation";
const BANK_DEPOSITS_URL = "https://www.amazonlogistics.eu/station/dashboard/bankdeposits";
const BROWSER_CLOSE_TIMEOUT_MS = 3000;
const PORTAL_DEFINITIONS = {
  scc: {
    baseUrl: "https://www.amazonlogistics.eu/",
    code: "scc",
    loginUrl: "https://www.amazonlogistics.eu/station/dashboard/workitemsvisibility",
    name: "Amazon SCC",
    shortName: "SCC"
  },
  lsc: {
    baseUrl: "https://logistics.amazon.in/",
    code: "lsc",
    loginUrl: "https://logistics.amazon.in/",
    name: "Amazon LSC",
    shortName: "LSC"
  },
  yms: {
    baseUrl: "https://www.amazonlogistics.eu/",
    code: "yms",
    loginUrl: "https://www.amazonlogistics.eu/",
    name: "Amazon YMS",
    shortName: "YMS"
  }
};

function portalDefinition(payload = {}) {
  const code = String(payload.portal_code || payload.portal || "scc").toLowerCase();
  return PORTAL_DEFINITIONS[code] || PORTAL_DEFINITIONS.scc;
}

async function closeBrowserSafely(browser) {
  await Promise.race([
    browser.close().catch(() => null),
    new Promise((resolve) => setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS))
  ]);
}

function normalizePortalPayload(payload = {}) {
  const definition = portalDefinition(payload);
  return {
    ...payload,
    base_url: payload.base_url || definition.baseUrl,
    login_url: payload.login_url || definition.loginUrl,
    portal: definition.code,
    portal_code: definition.code
  };
}

function portalShortName(payload = {}) {
  return portalDefinition(payload).shortName;
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function htmlResponse(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function unauthorized(res) {
  jsonResponse(res, 401, { error: "Unauthorized" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        req.destroy();
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function workerInfo() {
  return {
    ok: true,
    service: "dropx-amazon-portal-playwright-worker",
    headless: HEADLESS,
    vnc_enabled: ENABLE_VNC,
    vnc_port: ENABLE_VNC ? NOVNC_PORT : null,
    vnc_path: ENABLE_VNC ? "/vnc.html" : null,
    interactive_login_supported: ENABLE_VNC || !HEADLESS,
    session_mode: "worker_browser_storage_state",
    saved_session_without_password_supported: true,
    local_chrome_session_reused: false,
    biometric_attendance_safe: true,
    biometric_middleware_host: "bio.dropxlogistics.com is not used by this worker",
    session_state_dir: SESSION_STATE_DIR,
    manual_approval_wait_ms: MANUAL_APPROVAL_WAIT_MS,
    worker_timeout_ms: WORKER_TIMEOUT_MS,
    station_summary_timeout_ms: STATION_SUMMARY_TIMEOUT_MS,
    station_summary_path: "/station-summary",
    station_summary_cdp_env: "AMAZON_CDP_URL",
    workspaces_web_url: WORKSPACES_WEB_DEFAULT_URL,
    capture_modes: ["auto", "dom", "workspace-stream"],
    station_summary_browser: "firefox",
    station_summary_note: "Run /station-summary inside Amazon WorkSpaces so Firefox opens on the remote desktop."
  };
}

function landingPage() {
  const info = workerInfo();
  const vncMarkup = info.vnc_enabled
    ? `<a class="button primary" href="/vnc.html" target="_blank" rel="noreferrer">Open Amazon worker browser</a>
       <p class="hint">Use this browser for one-time Amazon SCC/LSC/YMS login, MFA, or captcha approval. The session is saved on this worker.</p>`
    : `<p class="warn">Interactive browser is disabled. Start the worker with ENABLE_VNC=true and HEADLESS=false for the first Amazon approval.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DropX Amazon Portal Worker</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f7f8fb;
        color: #1f2933;
      }
      body { margin: 0; padding: 32px; }
      main {
        max-width: 920px;
        margin: 0 auto;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
        padding: 28px;
      }
      .eyebrow {
        color: #e94b22;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: .04em;
        text-transform: uppercase;
      }
      h1 { margin: 6px 0 8px; font-size: 30px; line-height: 1.1; }
      p { color: #58616f; line-height: 1.55; }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 12px;
        margin: 22px 0;
      }
      .card {
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 14px;
        background: #fbfcfe;
      }
      .label { color: #6b7280; font-size: 12px; font-weight: 700; text-transform: uppercase; }
      .value { margin-top: 6px; font-weight: 800; word-break: break-word; }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 42px;
        padding: 0 16px;
        border-radius: 7px;
        border: 1px solid #d1d5db;
        color: #111827;
        text-decoration: none;
        font-weight: 800;
        margin-right: 10px;
      }
      .primary {
        background: #e94b22;
        border-color: #e94b22;
        color: #fff;
      }
      .hint { margin-top: 10px; }
      .warn {
        border: 1px solid #fecaca;
        background: #fff1f2;
        color: #991b1b;
        border-radius: 8px;
        padding: 12px;
      }
      code {
        background: #f3f4f6;
        border-radius: 5px;
        padding: 2px 5px;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Worker service</div>
      <h1>Amazon portal automation is running</h1>
      <p>This service logs in to Amazon SCC/LSC/YMS with its own saved browser sessions. SCC checks can send Driver Reconciliation and Prepared Deposit results back to the DropX dashboard.</p>

      <div class="grid">
        <div class="card"><div class="label">Worker</div><div class="value">${info.service}</div></div>
        <div class="card"><div class="label">Browser mode</div><div class="value">${info.headless ? "Headless" : "Interactive"}</div></div>
        <div class="card"><div class="label">noVNC</div><div class="value">${info.vnc_enabled ? `Enabled on ${info.vnc_port}` : "Disabled"}</div></div>
        <div class="card"><div class="label">Biometric safety</div><div class="value">Separate from bio.dropxlogistics.com</div></div>
      </div>

      ${vncMarkup}
      <a class="button" href="/health" target="_blank" rel="noreferrer">Open health check</a>

      <p>The normal Chrome login on your laptop is not shared with this worker. For stable automation, approve Amazon once inside the worker browser for each portal and keep <code>SESSION_STATE_DIR</code> on persistent storage.</p>
    </main>
  </body>
</html>`;
}

function assertAuthorized(req, res) {
  if (!WORKER_SECRET) return true;
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${WORKER_SECRET}`) return true;
  unauthorized(res);
  return false;
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  return JSON.parse(raw || "{}");
}

function withWorkerTimeout(task) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Worker timed out after ${WORKER_TIMEOUT_MS}ms.`)), WORKER_TIMEOUT_MS);
  });
  return Promise.race([task, timeout]);
}

function requiredString(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function safeNumber(value) {
  const text = String(value ?? "").replace(/[,₹\s]/g, "");
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatSccDate(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return text;
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function withStationParam(url, stationCode) {
  const station = String(stationCode ?? "").trim().toUpperCase();
  if (!station) return url;
  try {
    const nextUrl = new URL(url);
    nextUrl.searchParams.set("stationCode", station);
    return nextUrl.toString();
  } catch {
    return url;
  }
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeName(value) {
  return normalizeText(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function compactIdentifier(value) {
  return normalizeText(value).replace(/[^a-z0-9_-]+/gi, "").toUpperCase();
}

function stableRosterId(stationCode, name, candidateId) {
  const explicit = compactIdentifier(candidateId);
  if (explicit && !/^(0|NA|N\/A|NULL|-)$/.test(explicit)) return explicit;
  const slug = normalizeName(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `SCC-${compactIdentifier(stationCode) || "STATION"}-${slug || "ASSOCIATE"}`;
}

function isLikelyHeaderOrTotal(row) {
  const text = normalizeText((row || []).join(" ")).toLowerCase();
  if (!text) return true;
  return /\b(total|grand total|summary|station|employee count|pending count)\b/i.test(text) ||
    /\b(name|driver|associate|executive)\b.*\b(status|amount|cod|recon)\b/i.test(text);
}

function isNonNameCell(value) {
  const text = normalizeText(value);
  if (!text) return true;
  if (/^\d+([.,]\d+)?$/.test(text.replace(/[,₹\s]/g, ""))) return true;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)) return true;
  if (/^\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?$/i.test(text)) return true;
  if (/^(pending|completed|done|closed|open|yes|no|na|n\/a|status|amount|cod|cash|driver|associate)$/i.test(text)) return true;
  return false;
}

function pickByHeader(headers, row, patterns) {
  const normalizedHeaders = (headers || []).map((header) => normalizeText(header).toLowerCase());
  for (const pattern of patterns) {
    const index = normalizedHeaders.findIndex((header) => pattern.test(header));
    if (index >= 0 && row[index] !== undefined) return row[index];
  }
  return "";
}

function amountFromRow(headers, row) {
  const value = pickByHeader(headers, row, [
    /pending.*recon/i,
    /pending.*reconciliation/i,
    /pending.*amount/i,
    /pending.*cod/i,
    /short/i,
    /liability/i,
    /\bcod\b/i,
    /amount/i
  ]);
  return safeNumber(value);
}

function statusFromRow(headers, row) {
  const headerValue = pickByHeader(headers, row, [/status/i, /state/i, /recon/i, /reconciliation/i]);
  if (normalizeText(headerValue)) return normalizeText(headerValue);
  const text = normalizeText(row.join(" "));
  const match = text.match(/\b(pending|completed|done|reconciled|not reconciled|unreconciled|short|closed|open)\b/i);
  return match ? match[0] : null;
}

function nameFromRow(headers, row) {
  const headerValue = pickByHeader(headers, row, [
    /associate.*name/i,
    /driver.*name/i,
    /executive.*name/i,
    /\bda\s*name\b/i,
    /\bname\b/i
  ]);
  if (normalizeText(headerValue) && !isNonNameCell(headerValue)) return normalizeText(headerValue);

  const candidates = row
    .map(normalizeText)
    .filter((value) => value && !isNonNameCell(value) && /[a-z]/i.test(value))
    .filter((value) => !/pending|recon|amount|status|station|route|total|liability/i.test(value));
  candidates.sort((first, second) => second.length - first.length);
  return candidates[0] || "";
}

function idFromRow(headers, row, name) {
  const headerValue = pickByHeader(headers, row, [
    /provider.*id/i,
    /employee.*id/i,
    /transporter.*id/i,
    /\bda\s*id\b/i,
    /driver.*id/i,
    /executive.*id/i,
    /\bid\b/i
  ]);
  if (compactIdentifier(headerValue)) return compactIdentifier(headerValue);

  const nameText = normalizeText(name).toLowerCase();
  const candidate = row
    .map(normalizeText)
    .find((value) => {
      const compact = compactIdentifier(value);
      if (!compact || normalizeText(value).toLowerCase() === nameText) return false;
      if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(value)) return false;
      if (/^\d{1,2}:\d{2}/.test(value)) return false;
      if (/^\d+([.,]\d+)?$/.test(value.replace(/[,₹\s]/g, ""))) return false;
      return /^[A-Z0-9][A-Z0-9_-]{2,30}$/i.test(compact);
    });
  return compactIdentifier(candidate);
}

function extractDriverReconciliationAssociates(evidence, stationCode = "") {
  const rowsById = new Map();
  const tables = [...(evidence.tables || [])];
  if (Array.isArray(evidence.row_groups) && evidence.row_groups.length) {
    tables.push(...evidence.row_groups);
  }
  for (const table of tables) {
    const tableRows = Array.isArray(table.rows) ? table.rows : [];
    const headerCandidates = Array.isArray(table.headers) && table.headers.length ? table.headers : tableRows[0] || [];
    const headers = headerCandidates.map(normalizeText);
    for (const row of tableRows) {
      const cells = (row || []).map(normalizeText);
      if (cells.length < 2 || isLikelyHeaderOrTotal(cells)) continue;
      const isSccPaymentLayout = cells.length >= 10
        && /^[A-Z0-9][A-Z0-9_-]{5,30}$/i.test(compactIdentifier(cells[1]))
        && /^(DSP|DA|DRIVER|ASSOCIATE)$/i.test(cells[3] || "");
      if (isSccPaymentLayout) {
        const associateName = cells[0];
        const normalizedAssociateName = normalizeName(associateName);
        const providerEmployeeId = stableRosterId(stationCode, associateName, cells[1]);
        rowsById.set(providerEmployeeId, {
          provider_employee_id: providerEmployeeId,
          associate_name: associateName,
          normalized_associate_name: normalizedAssociateName,
          route_code: null,
          reconciliation_state: "SCC Driver Reconciliation",
          pending_amount: safeNumber(cells[9]),
          raw_row: {
            headers: ["name", "id", "provider", "type", "expected", "undebriefed mpos", "undebriefed cash", "variance", "running balance", "pending recon"],
            cells
          }
        });
        continue;
      }
      const associateName = nameFromRow(headers, cells);
      if (!associateName) continue;
      const normalizedAssociateName = normalizeName(associateName);
      if (!normalizedAssociateName || normalizedAssociateName.length < 3) continue;
      const providerEmployeeId = stableRosterId(stationCode, associateName, idFromRow(headers, cells, associateName));
      const pendingAmount = amountFromRow(headers, cells);
      const reconciliationState = statusFromRow(headers, cells);
      const routeCode = normalizeText(pickByHeader(headers, cells, [/route/i, /wave/i, /cycle/i]));
      rowsById.set(providerEmployeeId, {
        provider_employee_id: providerEmployeeId,
        associate_name: associateName,
        normalized_associate_name: normalizedAssociateName,
        route_code: routeCode || null,
        reconciliation_state: reconciliationState,
        pending_amount: pendingAmount,
        raw_row: { headers, cells }
      });
    }
  }
  for (const row of evidence.text_rows || []) {
    const cells = String(row ?? "").split(/\s{2,}|\t+/).map(normalizeText).filter(Boolean);
    if (cells.length >= 2 && !isLikelyHeaderOrTotal(cells)) {
      const headers = ["name", "id", "provider", "type", "expected", "undebriefed mpos", "undebriefed cash", "variance", "running balance", "pending recon"];
      const associateName = nameFromRow(headers, cells);
      if (associateName) {
        const normalizedAssociateName = normalizeName(associateName);
        const providerEmployeeId = stableRosterId(stationCode, associateName, idFromRow(headers, cells, associateName));
        if (!rowsById.has(providerEmployeeId)) {
          rowsById.set(providerEmployeeId, {
            provider_employee_id: providerEmployeeId,
            associate_name: associateName,
            normalized_associate_name: normalizedAssociateName,
            route_code: null,
            reconciliation_state: "SCC Driver Reconciliation",
            pending_amount: amountFromRow(headers, cells),
            raw_row: { headers, cells, source: "text_row" }
          });
        }
      }
    }
  }
  return Array.from(rowsById.values()).sort((first, second) =>
    String(first.associate_name).localeCompare(String(second.associate_name))
  );
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function amountTextVariants(value) {
  const amount = safeNumber(value);
  if (!amount) return [];
  return Array.from(new Set([
    String(amount),
    amount.toFixed(2),
    amount.toLocaleString("en-IN"),
    amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    `₹ ${amount.toLocaleString("en-IN")}`,
    `₹${amount.toLocaleString("en-IN")}`
  ].filter(Boolean)));
}

function detailTrackingIdFromRow(headers, row) {
  const value = pickByHeader(headers, row, [/tracking/i, /shipment/i, /package/i, /order/i, /\bawb\b/i, /\btba\b/i]);
  if (compactIdentifier(value)) return normalizeText(value);
  const candidate = row.map(normalizeText).find((cell) => {
    const compact = compactIdentifier(cell);
    if (compact.length < 7) return false;
    if (/^\d+([.,]\d+)?$/.test(cell.replace(/[,₹\s]/g, ""))) return false;
    if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(cell)) return false;
    return /[A-Z0-9]/i.test(compact);
  });
  return candidate ? normalizeText(candidate) : "";
}

function detailStatusFromRow(headers, row) {
  const value = pickByHeader(headers, row, [/status/i, /state/i, /reason/i, /remark/i]);
  if (normalizeText(value)) return normalizeText(value);
  const text = normalizeText(row.join(" "));
  const match = text.match(/\b(pending|open|closed|debriefed|undebriefed|reconciled|short|excess|paid|unpaid)\b/i);
  return match ? match[0] : "";
}

function detailAmountFromRow(headers, row) {
  return amountFromRow(headers, row) || safeNumber(pickByHeader(headers, row, [/amount/i, /cash/i, /\bcod\b/i, /pending/i]));
}

function extractPendingReconDetailRows(evidence, associate) {
  const details = [];
  const tables = [...(evidence.tables || [])];
  if (Array.isArray(evidence.row_groups)) tables.push(...evidence.row_groups);
  for (const table of tables) {
    const tableRows = Array.isArray(table.rows) ? table.rows : [];
    const headerCandidates = Array.isArray(table.headers) && table.headers.length ? table.headers : tableRows[0] || [];
    const headers = headerCandidates.map(normalizeText);
    for (const row of tableRows) {
      const cells = (row || []).map(normalizeText).filter(Boolean);
      if (cells.length < 2 || isLikelyHeaderOrTotal(cells)) continue;
      const trackingId = detailTrackingIdFromRow(headers, cells);
      const amount = detailAmountFromRow(headers, cells);
      const status = detailStatusFromRow(headers, cells);
      if (!trackingId && !amount) continue;
      details.push({
        tracking_id: trackingId || null,
        amount,
        status: status || null,
        description: cells.slice(0, 8).join(" | "),
        raw_row: { headers, cells, source_url: evidence.url, associate: associate.associate_name }
      });
      if (details.length >= 100) return details;
    }
  }
  if (!details.length) {
    for (const row of evidence.text_rows || []) {
      const cells = String(row ?? "").split(/\s{2,}|\t+/).map(normalizeText).filter(Boolean);
      if (cells.length < 2 || isLikelyHeaderOrTotal(cells)) continue;
      const headers = ["tracking", "amount", "status", "description"];
      const trackingId = detailTrackingIdFromRow(headers, cells);
      const amount = detailAmountFromRow(headers, cells);
      if (!trackingId && !amount) continue;
      details.push({
        tracking_id: trackingId || null,
        amount,
        status: detailStatusFromRow(headers, cells) || null,
        description: cells.slice(0, 8).join(" | "),
        raw_row: { headers, cells, source: "text_row", source_url: evidence.url, associate: associate.associate_name }
      });
      if (details.length >= 100) break;
    }
  }
  return details;
}

async function clickPendingReconForAssociate(page, associate) {
  const name = normalizeText(associate.associate_name);
  const rawCells = Array.isArray(associate.raw_row?.cells) ? associate.raw_row.cells : [];
  const explicitId = compactIdentifier(rawCells[1] || associate.provider_employee_id);
  const rowNeedle = explicitId && !explicitId.startsWith("SCC-") ? explicitId : name;
  const pendingAmount = safeNumber(associate.pending_amount);
  const amountVariants = amountTextVariants(pendingAmount);
  const rowLocator = page.locator("tr, [role='row']").filter({
    hasText: new RegExp(escapeRegex(rowNeedle), "i")
  }).first();

  if (!(await rowLocator.count().catch(() => 0))) return false;
  if (!(await rowLocator.isVisible().catch(() => false))) return false;

  const clickables = await rowLocator.locator("a, button, [role='button'], [onclick]").all().catch(() => []);
  for (const clickable of clickables) {
    const text = normalizeText(await clickable.innerText().catch(() => ""));
    const href = normalizeText(await clickable.getAttribute("href").catch(() => ""));
    const haystack = `${text} ${href}`;
    const amountMatch = amountVariants.some((variant) => haystack.includes(variant));
    if (amountMatch || /pending|recon|amount|cash|liability/i.test(haystack)) {
      await clickable.click({ timeout: 5000 }).catch(() => null);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
      return true;
    }
  }

  for (const variant of amountVariants) {
    const amountLink = rowLocator.getByText(variant, { exact: false }).first();
    if (await amountLink.count().catch(() => 0)) {
      await amountLink.click({ timeout: 5000 }).catch(() => null);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
      return true;
    }
  }
  return false;
}

async function closePendingDetail(page, beforeUrl) {
  if (page.url() !== beforeUrl) {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
    return;
  }
  await clickFirst(page, [
    { role: "button", name: /close|back|cancel|done|ok/i },
    "[aria-label*='close' i]",
    ".modal button.close",
    ".modal .close"
  ]).catch(() => null);
  await page.keyboard.press("Escape").catch(() => null);
  await page.waitForTimeout(400);
}

async function collectPendingDetailsForAssociates(page, associates) {
  const limit = Math.max(0, Number(process.env.SCC_PENDING_DETAIL_LIMIT || 0));
  const enriched = [];
  let checked = 0;
  for (const associate of associates) {
    const pendingAmount = safeNumber(associate.pending_amount);
    if (pendingAmount <= 0 || checked >= limit) {
      enriched.push({ ...associate, pending_details: [] });
      continue;
    }
    const beforeUrl = page.url();
    const clicked = await clickPendingReconForAssociate(page, associate);
    if (!clicked) {
      enriched.push({
        ...associate,
        pending_details: [],
        raw_row: { ...(associate.raw_row || {}), detail_error: "Pending recon link was not found." }
      });
      continue;
    }
    await page.waitForTimeout(800);
    const detailEvidence = await collectPageEvidence(page);
    const pendingDetails = extractPendingReconDetailRows(detailEvidence, associate);
    const checkedAt = new Date().toISOString();
    enriched.push({
      ...associate,
      pending_details: pendingDetails,
      last_detail_checked_at: checkedAt,
      raw_row: {
        ...(associate.raw_row || {}),
        pending_details: pendingDetails,
        detail_url: detailEvidence.url,
        detail_checked_at: checkedAt
      }
    });
    checked += 1;
    await closePendingDetail(page, beforeUrl);
  }
  return enriched;
}

function parseAmountNear(text, labels) {
  const normalized = text.replace(/\s+/g, " ");
  for (const label of labels) {
    const pattern = new RegExp(`${label}[^0-9-]*(-?\\d[\\d,]*(?:\\.\\d+)?)`, "i");
    const match = normalized.match(pattern);
    if (match) return safeNumber(match[1]);
  }
  return 0;
}

function hasMfaOrHumanBlocker(text) {
  return /otp|one time password|two.?step|multi.?factor|captcha|approve.*notification|authentication required|enter(?:\s+the)?\s+verification code|verification code\s+(?:sent|required|expires)/i.test(text);
}

function isAuthenticatedPortalPage(text, url) {
  return /\/station\/dashboard\//i.test(String(url || "")) &&
    /station command center/i.test(String(text || ""));
}

function isSiteSummaryAuthenticated(text, url) {
  const pageUrl = String(url || "");
  if (!/store-management|siteSummary|site.?summary/i.test(pageUrl)) return false;
  if (/\/ap\/signin|signin|\/login/i.test(pageUrl)) return false;
  const body = String(text || "");
  return /site summary|station summary|idle|acceptance|productivity|throughput/i.test(body);
}

function isLoginVisible(text, url) {
  if (isAuthenticatedPortalPage(text, url) || isSiteSummaryAuthenticated(text, url)) return false;
  if (/signin|login/i.test(url)) return true;
  return /(?:^|\n)\s*(?:sign in|log in|login)\s*(?:$|\n)|enter\s+(?:your\s+)?(?:password|email|username)/i.test(text);
}

const SITE_SUMMARY_DEFAULT_URL = "https://eu.store-management.f3.amazon.dev/siteSummary";
const WORKSPACES_WEB_DEFAULT_URL = process.env.AMAZON_WORKSPACES_URL
  || "https://ap-southeast-1.webclient.amazonworkspaces.com/wsp.html";
const STATION_SUMMARY_TIMEOUT_MS = Math.min(
  Number(process.env.STATION_SUMMARY_TIMEOUT_MS || 420000),
  600000
);

function resolveCaptureMode(payload = {}) {
  const raw = String(payload.capture_mode || process.env.AMAZON_CAPTURE_MODE || "auto").trim().toLowerCase();
  if (raw === "dom" || raw === "site-summary") return "dom";
  if (raw === "workspace-stream" || raw === "workspaces" || raw === "stream") return "workspace-stream";
  // auto: prefer stream when a WorkSpaces URL/session is explicitly configured.
  if (payload.workspaces_url || process.env.AMAZON_WORKSPACES_URL) return "workspace-stream";
  return "dom";
}

async function withTimeout(task, timeoutMs, label = "Worker task") {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sessionStatePath(payload) {
  const key = [
    payload.company_id || "company",
    payload.portal_code || "scc",
    payload.username || "user"
  ].map((part) => compactIdentifier(part) || "X").join("-");
  return path.join(SESSION_STATE_DIR, `${key}.json`);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeTotpSecret(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^otpauth:\/\//i.test(raw)) {
    try {
      return normalizeTotpSecret(new URL(raw).searchParams.get("secret") || "");
    } catch {
      return "";
    }
  }
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

function base32ToBuffer(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = normalizeTotpSecret(secret).replace(/=+$/g, "");
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error("Invalid MFA authenticator secret.");
  }

  let bits = "";
  for (const char of normalized) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret, now = Date.now()) {
  const key = base32ToBuffer(secret);
  const counter = Math.floor(now / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter & 0xffffffff, 4);

  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

async function waitForLoginToClear(page, waitMs) {
  const deadline = Date.now() + Math.max(0, Number.isFinite(waitMs) ? waitMs : 0);
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
    const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    if (isAuthenticatedPortalPage(text, page.url()) ||
      isSiteSummaryAuthenticated(text, page.url()) ||
      (!hasMfaOrHumanBlocker(text) && !isLoginVisible(text, page.url()))) {
      return true;
    }
  }
  return false;
}

async function attemptMfa(page, payload) {
  const secret = normalizeTotpSecret(payload.mfa_secret);
  if (!secret) return { attempted: false, submitted: false, message: "No MFA authenticator secret saved." };

  let code = "";
  try {
    code = generateTotp(secret);
  } catch (error) {
    return { attempted: true, submitted: false, message: (error).message || "Invalid MFA authenticator secret." };
  }

  const filled = await fillFirst(page, [
    "#auth-mfa-otpcode",
    "input[name='otpCode']",
    "input[name='code']",
    "input[autocomplete='one-time-code']",
    "input[id*='otp' i]",
    "input[id*='mfa' i]",
    "input[type='tel']",
    "input[type='text']"
  ], code);

  if (!filled) return { attempted: true, submitted: false, message: "MFA code field was not found." };

  await clickFirst(page, [
    "#auth-signin-button",
    "#signInSubmit",
    { role: "button", name: /verify|submit|continue|sign in|log in|login/i },
    "button[type='submit']",
    "input[type='submit']"
  ]);
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
  return { attempted: true, submitted: true, message: "MFA authenticator code submitted." };
}

async function resolveMfaOrManualBlocker(page, payload) {
  const portalName = portalShortName(payload);
  const mfaAttempt = await attemptMfa(page, payload);
  if (mfaAttempt.submitted) {
    const text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
    if (!hasMfaOrHumanBlocker(text) && !isLoginVisible(text, page.url())) {
      return { resolved: true, message: "Login completed with saved MFA authenticator secret.", mfaAttempt };
    }
  }

  const approved = await waitForLoginToClear(page, MANUAL_APPROVAL_WAIT_MS);
  if (approved) {
    return { resolved: true, message: "Login completed after Amazon approval.", mfaAttempt };
  }

  const interactiveHint = ENABLE_VNC
    ? `Open the ${portalName} worker noVNC browser at /vnc.html on the worker host, approve Amazon/TOTP/captcha there, then retry sync/check.`
    : `Run the Amazon worker with ENABLE_VNC=true and HEADLESS=false for the first ${portalName} approval, then retry sync/check.`;
  const workerApprovalMessage = `Amazon requested MFA/manual verification inside the ${portalName} worker browser. Your normal Chrome login is not shared with this worker. ${interactiveHint} The biometric attendance middleware is separate.`;
  const message = mfaAttempt.attempted
    ? `${mfaAttempt.message} ${workerApprovalMessage}`
    : workerApprovalMessage;

  return { resolved: false, message, mfaAttempt };
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.fill(value);
        return true;
      }
    }
  }
  return false;
}

async function clickFirst(page, candidates) {
  for (const candidate of candidates) {
    const locator = typeof candidate === "string"
      ? page.locator(candidate).first()
      : page.getByRole(candidate.role, { name: candidate.name }).first();
    if (await locator.count().catch(() => 0)) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click();
        return true;
      }
    }
  }
  return false;
}

async function maybeLogin(page, payload, initialUrl = "") {
  payload = normalizePortalPayload(payload);
  const loginUrl = payload.login_url || portalDefinition(payload).loginUrl;
  await page.goto(initialUrl || loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(750);

  let text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  if (
    isAuthenticatedPortalPage(text, page.url()) ||
    isSiteSummaryAuthenticated(text, page.url()) ||
    !isLoginVisible(text, page.url())
  ) {
    return { loggedIn: true, message: "Session already active." };
  }

  if (!String(payload.username ?? "").trim() || !String(payload.password ?? "").trim()) {
    const portalName = portalShortName(payload);
    const interactiveHint = ENABLE_VNC
      ? `Open /vnc.html on the ${portalName} worker, complete the Amazon login once, then retry this check.`
      : `Start the worker with ENABLE_VNC=true and HEADLESS=false, complete Amazon login once, then retry this check.`;
    return {
      loggedIn: false,
      manualReview: true,
      message: `The saved ${portalName} session has expired or is not available. ${interactiveHint}`
    };
  }

  const userFilled = await fillFirst(page, [
    "#ap_email",
    "input[type='email']",
    "input[name='email']",
    "input[name='username']",
    "input[name='userName']",
    "input[id*='email' i]",
    "input[id*='user' i]"
  ], payload.username);

  if (userFilled) {
    await clickFirst(page, [
      "#continue",
      { role: "button", name: /continue|next/i },
      "button[type='submit']",
      "input[type='submit']"
    ]);
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);
  }

  const passwordFilled = await fillFirst(page, [
    "#ap_password",
    "input[type='password']",
    "input[name='password']",
    "input[id*='password' i]"
  ], payload.password);

  if (!passwordFilled) {
    text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
    if (hasMfaOrHumanBlocker(text)) {
      const challenge = await resolveMfaOrManualBlocker(page, payload);
      if (challenge.resolved) {
        return { loggedIn: true, message: challenge.message, mfaAttempt: challenge.mfaAttempt };
      }
      return { loggedIn: false, manualReview: true, message: challenge.message, mfaAttempt: challenge.mfaAttempt };
    }
    return { loggedIn: false, manualReview: true, message: "Password field was not found. Amazon login layout needs mapping." };
  }

  await clickFirst(page, [
    "#signInSubmit",
    { role: "button", name: /sign in|log in|login|submit/i },
    "button[type='submit']",
    "input[type='submit']"
  ]);
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

  text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  if (hasMfaOrHumanBlocker(text)) {
    const challenge = await resolveMfaOrManualBlocker(page, payload);
    if (challenge.resolved) {
      return { loggedIn: true, message: challenge.message, mfaAttempt: challenge.mfaAttempt };
    }
    return { loggedIn: false, manualReview: true, message: challenge.message, mfaAttempt: challenge.mfaAttempt };
  }
  if (isLoginVisible(text, page.url())) {
    const challenge = await resolveMfaOrManualBlocker(page, payload);
    if (challenge.resolved) {
      return { loggedIn: true, message: challenge.message, mfaAttempt: challenge.mfaAttempt };
    }
    return {
      loggedIn: false,
      manualReview: true,
      message: challenge.message || `Login did not complete. Check ${portalShortName(payload)} credentials or Amazon login challenge.`,
      mfaAttempt: challenge.mfaAttempt
    };
  }
  return { loggedIn: true, message: "Login completed." };
}

async function setStation(page, stationCode) {
  const station = String(stationCode ?? "").trim();
  if (!station) return { changed: false, message: "No station code provided." };

  const selectors = [
    "select[name*='station' i]",
    "select[id*='station' i]",
    "input[name*='station' i]",
    "input[id*='station' i]",
    "input[placeholder*='station' i]"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.count().catch(() => 0))) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    const tagName = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
    if (tagName === "select") {
      const matchingValue = await locator.evaluate((select, expected) => {
        const options = Array.from(select.options || []);
        const match = options.find((option) => {
          const haystack = `${option.textContent || ""} ${option.value || ""}`;
          return haystack.toLowerCase().includes(String(expected).toLowerCase());
        });
        return match?.value || "";
      }, station).catch(() => "");
      if (!matchingValue) continue;
      await locator.selectOption(matchingValue);
    } else {
      await locator.fill(station);
      await locator.press("Enter").catch(() => null);
    }
    await page.waitForTimeout(500);
    return { changed: true, message: `Station set to ${station}.` };
  }

  await clickFirst(page, [
    { role: "button", name: /station|site|location/i },
    "[aria-label*='station' i]",
    "[data-testid*='station' i]"
  ]).catch(() => null);

  const option = page.getByText(new RegExp(`\\b${station}\\b`, "i")).first();
  if (await option.count().catch(() => 0)) {
    await option.click().catch(() => null);
    await page.waitForTimeout(750);
    return { changed: true, message: `Station selected from visible option ${station}.` };
  }

  return { changed: false, message: "Station selector was not found; inspected currently active station." };
}

/**
 * Site Summary keeps the active site in the top header menu. Prefer that
 * control so we can rotate the five stores without leaving the page shell.
 */
async function setSiteSummaryStation(page, stationCode) {
  const station = String(stationCode ?? "").trim();
  if (!station) return { changed: false, message: "No station code provided." };
  const aliases = [...new Set([station, station.replace(/_SS$/i, ""), `${station.replace(/_SS$/i, "")}_SS`])];
  const escaped = aliases.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const stationPattern = new RegExp(`(?:${escaped})`, "i");

  const alreadyActive = await page.evaluate((expected) => {
    const header = document.querySelector("header, [role='banner'], nav") || document.body;
    const text = (header?.innerText || "").replace(/\s+/g, " ").toLowerCase();
    return [expected, `${expected}_SS`].some((value) => text.includes(String(value).toLowerCase()));
  }, station.replace(/_SS$/i, "")).catch(() => false);

  const openCandidates = [
    page.getByRole("button", { name: stationPattern }).first(),
    page.getByRole("combobox", { name: /site|station|store|location/i }).first(),
    page.locator("header [role='button'], header button, header [aria-haspopup], nav [role='button'], nav button").filter({ hasText: stationPattern }).first(),
    page.locator("[aria-label*='site' i], [aria-label*='station' i], [data-testid*='site' i], [data-testid*='station' i]").first(),
    page.locator("header button, header [role='button'], nav button, nav [role='button']").first()
  ];

  for (const opener of openCandidates) {
    if (!(await opener.count().catch(() => 0))) continue;
    if (!(await opener.isVisible().catch(() => false))) continue;
    await opener.click({ timeout: 4000 }).catch(() => null);
    await page.waitForTimeout(400);

    const search = page.locator("input[placeholder*='search' i], input[aria-label*='search' i], [role='listbox'] input, [role='menu'] input").first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill(station).catch(() => null);
      await page.waitForTimeout(350);
    }

    const option = page.getByRole("option", { name: stationPattern }).first()
      .or(page.locator("[role='option'], [role='menuitem'], li, button, a").filter({ hasText: stationPattern }).first());
    if (await option.count().catch(() => 0)) {
      await option.click({ timeout: 4000 }).catch(() => null);
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);
      await page.waitForTimeout(900);
      const verified = await page.evaluate((expected) => {
        const header = document.querySelector("header, [role='banner'], nav") || document.body;
        const text = (header?.innerText || "").replace(/\s+/g, " ").toLowerCase();
        return [expected, `${expected}_ss`].some((value) => text.includes(String(value).toLowerCase()));
      }, station.replace(/_SS$/i, "")).catch(() => false);
      if (verified) return { changed: true, verified: true, method: "top-menu", message: `Site Summary station switched to ${station}.` };
    }
  }

  const fallback = await setStation(page, station);
  if (fallback.changed) return { ...fallback, method: "generic-selector" };
  if (alreadyActive) return { changed: false, verified: true, method: "already-active", message: `Station ${station} already appears active in the header.` };
  return { changed: false, method: "not-found", message: `Could not switch Site Summary to ${station}.` };
}

async function detectRedSiteSummaryMetrics(page) {
  return page.evaluate(() => {
    const parseChannels = (value) => {
      const raw = String(value || "").trim().toLowerCase();
      if (!raw || raw === "transparent" || raw === "rgba(0, 0, 0, 0)") return null;
      const rgb = raw.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
      if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
      const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (!hex) return null;
      const h = hex[1];
      if (h.length === 3) {
        return {
          r: Number.parseInt(h[0] + h[0], 16),
          g: Number.parseInt(h[1] + h[1], 16),
          b: Number.parseInt(h[2] + h[2], 16)
        };
      }
      return {
        r: Number.parseInt(h.slice(0, 2), 16),
        g: Number.parseInt(h.slice(2, 4), 16),
        b: Number.parseInt(h.slice(4, 6), 16)
      };
    };
    const isRed = (value) => {
      const channels = parseChannels(value);
      if (!channels) {
        const raw = String(value || "").toLowerCase();
        return /(^|\s)(red|tomato|crimson|indianred|firebrick)(\s|$)/.test(raw);
      }
      const { r, g, b } = channels;
      return r >= 160 && g <= 110 && b <= 110 && (r - Math.max(g, b)) >= 40;
    };

    const metrics = [];
    const seen = new Set();
    const nodes = Array.from(document.querySelectorAll("span, div, p, td, th, strong, b, label, li, h1, h2, h3, h4, h5, h6"));
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 120) continue;
      if (!/\d/.test(text)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") < 0.2) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4 || rect.width > 900 || rect.height > 220) continue;
      const redText = isRed(style.color);
      const redFill = isRed(style.backgroundColor) || isRed(style.borderTopColor) || isRed(style.outlineColor);
      if (!redText && !redFill) continue;

      let label = "";
      const parent = el.closest("section, article, li, tr, [class*='card' i], [class*='metric' i], [class*='tile' i], [class*='kpi' i], [data-testid]");
      if (parent) {
        const parentText = (parent.innerText || "").replace(/\s+/g, " ").trim();
        const lines = parentText.split(/(?<=\.)\s+|\n| {2,}/).map((line) => line.trim()).filter(Boolean);
        label = lines.find((line) => line !== text && line.length <= 80) || lines[0] || "";
      }
      const key = `${label}|${text}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      metrics.push({
        label: label.slice(0, 120),
        value: text.slice(0, 80),
        color: style.color,
        via: redText ? "text" : "surface"
      });
      if (metrics.length >= 25) break;
    }

    const pageText = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 5000);
    return {
      detected: metrics.length > 0,
      matching_elements: metrics.length,
      metrics,
      text: pageText,
      title: document.title || "",
      url: location.href
    };
  });
}

function pickSessionPage(pages, captureMode) {
  const list = Array.isArray(pages) ? pages : [];
  if (captureMode === "workspace-stream") {
    return list.find((candidate) => /amazonworkspaces\.com|webclient\.amazonworkspaces/i.test(candidate.url()))
      || list[0]
      || null;
  }
  return list.find((candidate) => /siteSummary|store-management/i.test(candidate.url()))
    || list.find((candidate) => /amazonworkspaces\.com/i.test(candidate.url()))
    || list[0]
    || null;
}

/**
 * Site Summary monitoring always uses Firefox. Run this worker inside Amazon
 * WorkSpaces so Firefox opens on the remote desktop (not on the local laptop).
 */
async function openStationSummarySession(payload = {}) {
  const captureMode = resolveCaptureMode(payload);
  await mkdir(SESSION_STATE_DIR, { recursive: true });
  const portalCode = captureMode === "workspace-stream" ? "workspaces-web" : "site-summary";
  const statePath = sessionStatePath({ ...payload, portal_code: portalCode });
  const profileDir = path.join(
    SESSION_STATE_DIR,
    `firefox-${compactIdentifier(portalCode) || "site-summary"}-${compactIdentifier(payload.company_id || "local") || "local"}`
  );
  await mkdir(profileDir, { recursive: true });

  // Channel "firefox" keeps Site Summary on Firefox only (no Chromium/CDP attach).
  const context = await firefox.launchPersistentContext(profileDir, {
    headless: HEADLESS,
    slowMo: Number.isFinite(SLOW_MO_MS) ? SLOW_MO_MS : 0,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    viewport: { width: 1536, height: 900 },
    ...(await pathExists(statePath) ? { storageState: statePath } : {})
  });
  const page = pickSessionPage(context.pages(), captureMode) || context.pages()[0] || await context.newPage();
  // Persistent context owns the browser; closeBrowserSafely no-ops on missing browser.
  return {
    browser: context.browser() || { close: async () => context.close() },
    context,
    page,
    mode: "firefox",
    keepBrowserOpen: false,
    statePath,
    captureMode,
    browser_name: "firefox"
  };
}

async function ensureWorkspacesWebSession(page, payload = {}, settleMs = 1400) {
  const workspacesUrl = String(
    payload.workspaces_url || process.env.AMAZON_WORKSPACES_URL || WORKSPACES_WEB_DEFAULT_URL
  ).trim();
  if (!/amazonworkspaces\.com/i.test(page.url())) {
    await page.goto(workspacesUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await page.waitForTimeout(settleMs);
  }

  const text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  const hasCanvas = await page.locator("canvas").count().catch(() => 0);
  const connected = hasCanvas > 0
    || /disconnect|connected|session|workspace/i.test(text);
  const needsLogin = /sign in|log in|register|one-time password|enter code|username|password/i.test(text)
    && hasCanvas === 0;

  if (needsLogin) {
    return {
      loggedIn: false,
      manualReview: true,
      message: `Open ${workspacesUrl}, complete Amazon WorkSpaces Web Access login, wait until the remote desktop canvas is visible, then retry. Site Summary red checks run against that streamed desktop.`
    };
  }
  return {
    loggedIn: true,
    message: connected
      ? "Amazon WorkSpaces Web Access session is available."
      : "WorkSpaces page loaded; waiting for the remote desktop stream.",
    workspaces_url: workspacesUrl
  };
}

async function captureWorkspacesStreamPng(page) {
  const canvas = page.locator("canvas").first();
  if (await canvas.count().catch(() => 0)) {
    const box = await canvas.boundingBox().catch(() => null);
    if (box && box.width > 40 && box.height > 40) {
      return page.screenshot({
        type: "png",
        clip: {
          x: Math.max(0, box.x),
          y: Math.max(0, box.y),
          width: Math.min(box.width, 2400),
          height: Math.min(box.height, 1600)
        }
      });
    }
    return canvas.screenshot({ type: "png" }).catch(() => page.screenshot({ type: "png" }));
  }
  return page.screenshot({ type: "png", fullPage: true });
}

async function countRedPixelsInPng(page, pngBuffer, minPixels = 80) {
  const b64 = Buffer.from(pngBuffer).toString("base64");
  return page.evaluate(async ({ imageBase64, threshold }) => {
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
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let red = 0;
    for (let i = 0; i < data.length; i += 16) {
      // Sample every 4th pixel for speed on large WorkSpaces frames.
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 180) continue;
      if (r >= 160 && g <= 110 && b <= 110 && (r - Math.max(g, b)) >= 40) red += 1;
    }
    return {
      detected: red >= threshold,
      red_pixels: red,
      width: canvas.width,
      height: canvas.height,
      sample_stride: 4
    };
  }, { imageBase64: b64, threshold: minPixels }).catch((error) => ({
    detected: false,
    red_pixels: 0,
    error: error instanceof Error ? error.message : "Red pixel scan failed."
  }));
}

/**
 * Best-effort station switch inside the streamed WorkSpaces desktop.
 * Clicks are forwarded through the remote canvas; exact coordinates vary by
 * resolution, so this is optional and configurable.
 */
async function switchStationInWorkspacesStream(page, stationCode, payload = {}) {
  const station = String(stationCode || "").trim();
  if (!station) return { changed: false, method: "none", message: "No station provided." };

  const canvas = page.locator("canvas").first();
  if (!(await canvas.count().catch(() => 0))) {
    return { changed: false, method: "no-canvas", message: "WorkSpaces canvas not found." };
  }

  const box = await canvas.boundingBox().catch(() => null);
  if (!box) return { changed: false, method: "no-box", message: "WorkSpaces canvas has no box." };

  const clicks = payload.station_clicks || {};
  const preset = clicks[station];
  const menuX = Number(preset?.menu_x ?? payload.menu_x ?? process.env.AMAZON_WS_MENU_X ?? (box.x + box.width * 0.18));
  const menuY = Number(preset?.menu_y ?? payload.menu_y ?? process.env.AMAZON_WS_MENU_Y ?? (box.y + Math.min(48, box.height * 0.05)));

  await page.mouse.click(menuX, menuY);
  await page.waitForTimeout(500);
  await page.keyboard.type(station, { delay: 40 });
  await page.waitForTimeout(350);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(Number(payload.settle_ms || 1600));
  return {
    changed: true,
    method: "workspace-stream-click",
    message: `Sent WorkSpaces stream click/type for ${station}.`,
    click: { x: menuX, y: menuY }
  };
}

async function runWorkspaceStreamMonitor(payload = {}, session) {
  const stations = Array.isArray(payload.stations)
    ? payload.stations.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const settleMs = Math.max(400, Number(payload.settle_ms || 1600));
  const minRedPixels = Math.max(20, Number(payload.min_red_pixels || process.env.AMAZON_MIN_RED_PIXELS || 80));
  const { browser, context, page, keepBrowserOpen, statePath, mode } = session;

  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);

  const login = await ensureWorkspacesWebSession(page, payload, settleMs);
  if (!login.loggedIn) {
    return {
      status: "Manual Review",
      summary: login.message,
      stations,
      alert_count: 0,
      alerts: [],
      checked_at: new Date().toISOString(),
      browser_mode: mode,
      capture_mode: "workspace-stream",
      workspaces_url: login.workspaces_url || WORKSPACES_WEB_DEFAULT_URL
    };
  }

  const alerts = [];
  const stationResults = [];
  const targets = stations.length ? stations : ["ACTIVE"];

  for (const station of targets) {
    const stationResult = targets.length === 1 && station === "ACTIVE"
      ? { changed: false, method: "visible-desktop", message: "Capturing the currently visible WorkSpaces desktop." }
      : await switchStationInWorkspacesStream(page, station, payload);
    await page.waitForTimeout(settleMs);

    const image = await captureWorkspacesStreamPng(page);
    const red = await countRedPixelsInPng(page, image, minRedPixels);
    stationResults.push({
      station,
      switched: Boolean(stationResult.changed),
      station_selector: stationResult,
      red_detected: Boolean(red.detected),
      matching_elements: red.red_pixels || 0,
      metrics: []
    });

    if (!red.detected) continue;

    const metricSignature = `ws-red:${station}:${red.red_pixels}:${red.width}x${red.height}`;
    alerts.push({
      station,
      station_selector: stationResult,
      reason: "workspace-stream-red",
      matching_elements: red.red_pixels,
      metrics: [],
      metric_signature: metricSignature,
      page_text: `Amazon WorkSpaces stream showed about ${red.red_pixels} red alert pixels for ${station}.`,
      page_url: page.url(),
      page_title: await page.title().catch(() => "Amazon WorkSpaces"),
      image_base64: Buffer.from(image).toString("base64"),
      mime: "image/png",
      capture_mode: "workspace-stream",
      needs_vision_caption: true,
      captured_at: new Date().toISOString()
    });
  }

  if (statePath) await context.storageState({ path: statePath }).catch(() => null);

  return {
    status: "Ready",
    stations: targets,
    station_results: stationResults,
    alert_count: alerts.length,
    alerts,
    checked_at: new Date().toISOString(),
    browser_mode: mode,
    capture_mode: "workspace-stream",
    workspaces_url: String(payload.workspaces_url || process.env.AMAZON_WORKSPACES_URL || WORKSPACES_WEB_DEFAULT_URL),
    summary: alerts.length
      ? `Captured ${alerts.length} red WorkSpaces stream screenshot(s).`
      : `Checked WorkSpaces stream for ${targets.length} station target(s); no red alert pixels detected.`
  };
}

async function setDate(page, checkDate) {
  const date = String(checkDate ?? "").trim();
  if (!date) return { changed: false, message: "No date provided." };
  const displayDate = formatSccDate(date);

  const selectors = [
    "input[type='date']",
    "input[name*='date' i]",
    "input[id*='date' i]",
    "input[placeholder*='date' i]"
  ];

  for (const selector of selectors) {
    const inputs = await page.locator(selector).all().catch(() => []);
    for (const input of inputs) {
      if (!(await input.isVisible().catch(() => false))) continue;
      const type = await input.getAttribute("type").catch(() => "");
      const value = type === "date" ? date : displayDate;
      await input.click({ clickCount: 3 }).catch(() => null);
      await input.press("Control+A").catch(() => null);
      await input.fill(value).catch(() => null);
      await input.evaluate((element, nextValue) => {
        const prototype = element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (valueSetter) valueSetter.call(element, nextValue);
        else element.value = nextValue;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true }));
      }, value).catch(() => null);
      await input.press("Enter").catch(() => null);
      await input.press("Tab").catch(() => null);
      await page.waitForTimeout(900);

      const observedValue = await input.inputValue().catch(() => "");
      const normalizedObserved = /^\d{4}-\d{2}-\d{2}$/.test(observedValue)
        ? formatSccDate(observedValue)
        : observedValue;
      const visibleValue = observedValue || await input.getAttribute("value").catch(() => "") || "";
      const changed = observedValue === date ||
        observedValue === displayDate ||
        normalizedObserved === displayDate ||
        visibleValue === date ||
        visibleValue === displayDate;
      if (changed) {
        return {
          changed: true,
          message: `Date set to ${displayDate}.`,
          requested_value: displayDate,
          observed_value: visibleValue
        };
      }

      return {
        changed: false,
        message: `SCC kept ${visibleValue || "its existing date"} instead of ${displayDate}.`,
        requested_value: displayDate,
        observed_value: visibleValue
      };
    }
  }

  return { changed: false, message: "Date input was not found; inspected the default date shown by SCC." };
}

async function setAllDrivers(page) {
  const selectors = [
    "select[name*='driver' i]",
    "select[id*='driver' i]",
    "select[aria-label*='driver' i]"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.count().catch(() => 0))) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    const matchingValue = await locator.evaluate((select) => {
      const options = Array.from(select.options || []);
      const match = options.find((option) =>
        /all\s*drivers?/i.test(`${option.textContent || ""} ${option.value || ""}`)
      );
      return match?.value ?? "";
    }).catch(() => "");
    if (matchingValue !== "") {
      await locator.selectOption(matchingValue);
      await page.waitForTimeout(500);
      return { changed: true, message: "Driver set to All Drivers." };
    }
  }

  const allDriversControl = page.getByText(/^\s*all\s*drivers?\s*$/i).first();
  if (await allDriversControl.count().catch(() => 0)) {
    await allDriversControl.click().catch(() => null);
    await page.waitForTimeout(500);
    return { changed: true, message: "All Drivers option selected." };
  }

  return { changed: false, message: "All Drivers option was not found." };
}

async function waitForReportFrame(page) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const hasReportControls = await frame.locator(
        "table, select[name*='driver' i], select[id*='driver' i], input[name*='date' i], input[id*='date' i]"
      ).count().catch(() => 0);
      if (hasReportControls) return frame;
    }
    await page.waitForTimeout(500);
  }
  return page;
}

async function applyFilters(page) {
  await clickFirst(page, [
    { role: "button", name: /search|apply|filter|show|submit|go/i },
    "button[type='submit']",
    "input[type='submit']"
  ]).catch(() => null);
  await page.waitForTimeout(1500);
}

async function collectPageEvidence(page) {
  const frameResults = await Promise.all(page.frames().map((frame) =>
    frame.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      const cleanCell = (value) => (value || "").replace(/\s+/g, " ").trim();
      const tables = Array.from(document.querySelectorAll("table")).map((table) => {
      const headers = Array.from(table.querySelectorAll("thead th, tr:first-child th, tr:first-child td"))
        .map((cell) => cleanCell(cell.textContent || ""))
        .filter(Boolean);
      const rows = Array.from(table.querySelectorAll("tbody tr, tr")).slice(0, 200).map((row) =>
        Array.from(row.querySelectorAll("th, td")).map((cell) => cleanCell(cell.textContent || ""))
      ).filter((row) => row.some(Boolean));
      return { headers, rows };
    });
      const rowGroups = Array.from(document.querySelectorAll("[role='table'], [role='grid'], .table, .grid, .driver-reconciliation, .driverReconciliation"))
      .slice(0, 20)
      .map((group) => {
        const headerNodes = Array.from(group.querySelectorAll("[role='columnheader'], th"));
        const headers = headerNodes.map((cell) => cleanCell(cell.textContent || "")).filter(Boolean);
        const rows = Array.from(group.querySelectorAll("[role='row'], tr"))
          .slice(0, 250)
          .map((row) => {
            const cells = Array.from(row.querySelectorAll("[role='cell'], [role='gridcell'], td, th"));
            return cells.length
              ? cells.map((cell) => cleanCell(cell.textContent || "")).filter(Boolean)
              : cleanCell(row.textContent || "").split(/\s{2,}|\t+/).map(cleanCell).filter(Boolean);
          })
          .filter((row) => row.length > 1);
        return { headers, rows };
      })
      .filter((group) => group.rows.length);
      const textRows = Array.from(document.querySelectorAll("tr, [role='row']"))
      .slice(0, 250)
      .map((row) => cleanCell(row.textContent || ""))
      .filter(Boolean);
      return {
        title: document.title,
        url: location.href,
        text: bodyText.replace(/\s+/g, " ").slice(0, 12000),
        raw_text: bodyText.slice(0, 20000),
        tables,
        row_groups: rowGroups,
        text_rows: textRows
      };
    }).catch(() => null)
  ));
  const available = frameResults.filter(Boolean);
  return {
    title: available.map((result) => result.title).find(Boolean) || "",
    url: page.url(),
    text: available.map((result) => result.text).join(" ").slice(0, 12000),
    raw_text: available.map((result) => result.raw_text).join("\n").slice(0, 40000),
    tables: available.flatMap((result) => result.tables || []),
    row_groups: available.flatMap((result) => result.row_groups || []),
    text_rows: available.flatMap((result) => result.text_rows || [])
  };
}

function countPendingRows(tables) {
  let pending = 0;
  const examples = [];
  for (const table of tables) {
    for (const row of table.rows || []) {
      const text = row.join(" ");
      if (/pending|not reconciled|unreconciled|short|liability/i.test(text) && !/header/i.test(text)) {
        pending += 1;
        if (examples.length < 10) examples.push(row);
      }
    }
  }
  return { pending, examples };
}

function summarizeDriverReconciliation(evidence, stationCode, checkDate, associatesOverride = null) {
  const text = evidence.text || "";
  if (hasMfaOrHumanBlocker(text) && !isAuthenticatedPortalPage(text, evidence.url)) {
    return {
      status: "Manual Review",
      pending_count: 0,
      pending_amount: 0,
      summary: "Amazon SCC needs MFA or manual verification before Driver Reconciliation can be inspected.",
      associates: [],
      evidence
    };
  }

  const associates = Array.isArray(associatesOverride) ? associatesOverride : extractDriverReconciliationAssociates(evidence, stationCode);
  const pendingAmount = parseAmountNear(text, [
    "pending recon amount",
    "pending reconciliation amount",
    "pending amount",
    "recon amount",
    "short amount"
  ]);
  const pendingRows = countPendingRows(evidence.tables || []);
  const explicitZero = /pending\s*(recon|reconciliation)?\s*(amount|count)?\s*[:=-]?\s*(0|0\.00|₹\s*0)/i.test(text) ||
    /no\s+(pending|liability|reconciliation)/i.test(text);
  const hasReportRows = (evidence.tables || []).some((table) => (table.rows || []).length > 1);
  const status = pendingAmount > 0 || pendingRows.pending > 0 ? "Fail" : (explicitZero || hasReportRows ? "Pass" : "Manual Review");

  return {
    status,
    pending_count: pendingRows.pending,
    pending_amount: pendingAmount,
    associates,
    summary: status === "Pass"
      ? `Driver reconciliation is clear for ${stationCode} on ${checkDate}.`
      : status === "Fail"
        ? `Driver reconciliation has pending rows or amount for ${stationCode} on ${checkDate}.`
        : `Driver reconciliation page loaded, but layout was not clear enough to confirm ${stationCode} on ${checkDate}.`,
    evidence: {
      ...evidence,
      pending_examples: pendingRows.examples,
      associates
    }
  };
}

function summarizePreparedDeposit(evidence, stationCode, checkDate) {
  const text = evidence.text || "";
  if (hasMfaOrHumanBlocker(text) && !isAuthenticatedPortalPage(text, evidence.url)) {
    return {
      status: "Manual Review",
      pending_count: 0,
      pending_amount: 0,
      summary: "Amazon SCC needs MFA or manual verification before Prepared Deposit can be inspected.",
      evidence
    };
  }

  const pendingAmount = parseAmountNear(text, [
    "pending liability",
    "liability amount",
    "amount to generate",
    "pending amount",
    "deposit amount"
  ]);
  const pendingRows = countPendingRows(evidence.tables || []);
  const noLiability = /you\s+don'?t\s+have\s+any\s+liability\s+to\s+prepare\s+deposit|no\s+(pending\s+)?liability|no\s+amount|nothing\s+to\s+generate/i.test(text);
  const pageLooksRelevant = /prepared deposit|bank deposit|liability|remittance/i.test(text);
  const openRemittances = [];
  for (const table of evidence.tables || []) {
    const headers = (table.headers || []).map((header) => normalizeText(header).toLowerCase());
    const codeIndex = headers.findIndex((header) => header === "code" || /remittance.*code/.test(header));
    const statusIndex = headers.findIndex((header) => header === "status");
    const expectedIndex = headers.findIndex((header) => header === "expected" || /amount.*expected|expected.*amount/.test(header));
    const creationIndex = headers.findIndex((header) => /creation date|created at|created on/.test(header));
    if (statusIndex < 0 || expectedIndex < 0) continue;
    for (const cells of table.rows || []) {
      const statusText = normalizeText(cells[statusIndex]).toUpperCase();
      const code = codeIndex >= 0 ? normalizeText(cells[codeIndex]) : "";
      if (statusText !== "CREATED" || code) continue;
      openRemittances.push({
        code: null,
        status: statusText,
        creation_date: creationIndex >= 0 ? normalizeText(cells[creationIndex]) : null,
        expected: safeNumber(cells[expectedIndex]),
        raw_row: { headers: table.headers || [], cells }
      });
    }
  }
  const openExpected = Number(openRemittances.reduce((sum, row) => sum + row.expected, 0).toFixed(2));
  const status = pendingAmount > 0 || pendingRows.pending > 0
    ? "Fail"
    : (noLiability && openRemittances.length ? "Pass" : "Manual Review");

  return {
    status,
    pending_count: pendingRows.pending,
    pending_amount: pendingAmount,
    no_deposit_liability: noLiability,
    open_remittances: openRemittances,
    open_remittance_expected: openExpected,
    summary: status === "Pass"
      ? `Prepared deposit is clear and ${openRemittances.length} open remittance(s) total ₹${openExpected.toFixed(2)} for ${stationCode} on ${checkDate}.`
      : status === "Fail"
        ? `Prepared deposit shows pending liability for ${stationCode} on ${checkDate}.`
        : noLiability
          ? `No deposit liability remains, but no open CREATED remittance without code was found for ${stationCode} on ${checkDate}.`
          : `Prepared deposit page loaded, but no-liability status was not confirmed for ${stationCode} on ${checkDate}.`,
    evidence: {
      ...evidence,
      pending_examples: pendingRows.examples,
      no_deposit_liability: noLiability,
      open_remittances: openRemittances,
      open_remittance_expected: openExpected
    }
  };
}

async function captureDebug(page, runId, label) {
  if (!DEBUG_ARTIFACT_DIR) return null;
  await mkdir(DEBUG_ARTIFACT_DIR, { recursive: true });
  const safeRunId = String(runId || "manual").replace(/[^a-z0-9_-]/gi, "_");
  const filePath = path.join(DEBUG_ARTIFACT_DIR, `${safeRunId}-${label}-${Date.now()}.png`);
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => null);
  return filePath;
}

async function runSccCheck(payload) {
  payload = normalizePortalPayload({ ...payload, portal_code: "scc" });
  const stationCode = requiredString(payload.portal_station_code || payload.station_code, "station_code");
  const checkDate = requiredString(payload.check_date, "check_date");
  const checkType = requiredString(payload.check_type, "check_type");
  const targetUrl = checkType === "prepared_deposit"
    ? payload.urls?.bank_deposits || BANK_DEPOSITS_URL
    : payload.urls?.driver_reconciliation || DRIVER_RECON_URL;
  const stationTargetUrl = withStationParam(targetUrl, stationCode);

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: Number.isFinite(SLOW_MO_MS) ? SLOW_MO_MS : 0
  });

  try {
    await mkdir(SESSION_STATE_DIR, { recursive: true });
    const statePath = sessionStatePath(payload);
    const hasStoredSession = await pathExists(statePath);
    const context = await browser.newContext({
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      viewport: { width: 1440, height: 1000 },
      ...(hasStoredSession ? { storageState: statePath } : {})
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);

    const loginResult = await maybeLogin(page, payload, stationTargetUrl);
    if (!loginResult.loggedIn) {
      const debugScreenshot = await captureDebug(page, payload.run_id, "login-blocked");
      return {
        status: loginResult.manualReview ? "Manual Review" : "Error",
        pending_count: 0,
        pending_amount: 0,
        summary: loginResult.message,
        evidence: {
          url: page.url(),
          title: await page.title().catch(() => ""),
          debug_screenshot: debugScreenshot
        },
        raw_result: { login: { ...loginResult, session_reused: hasStoredSession } }
      };
    }

    await context.storageState({ path: statePath }).catch(() => null);

    if (!page.url().startsWith(targetUrl)) {
      await page.goto(stationTargetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    }
    await page.waitForTimeout(750);

    const stationResult = await setStation(page, stationCode);
    const reportFrame = checkType === "driver_reconciliation"
      ? await waitForReportFrame(page)
      : page;
    const dateResult = await setDate(reportFrame, checkDate);
    const driverResult = checkType === "driver_reconciliation"
      ? await setAllDrivers(reportFrame)
      : { changed: false, message: "Driver selection is not used for this check." };

    if (checkType === "prepared_deposit") {
      await clickFirst(page, [
        { role: "button", name: /prepared\s+deposit|prepare\s+deposit|generate|search|show/i },
        "button[type='submit']"
      ]).catch(() => null);
    } else {
      await applyFilters(reportFrame);
    }

    await page.waitForTimeout(1500);
    const evidence = await collectPageEvidence(page);
    const debugScreenshot = await captureDebug(page, payload.run_id, checkType);
    if (!dateResult.changed) {
      return {
        status: "Manual Review",
        pending_count: 0,
        pending_amount: 0,
        summary: dateResult.message,
        evidence: {
          ...evidence,
          debug_screenshot: debugScreenshot,
          station_selector: stationResult,
          date_selector: dateResult,
          driver_selector: driverResult
        },
        raw_result: {
          login: { ...loginResult, session_reused: hasStoredSession, session_saved: true },
          station_selector: stationResult,
          date_selector: dateResult,
          driver_selector: driverResult,
          inspected_url: evidence.url,
          page_title: evidence.title
        }
      };
    }
    let summary;
    if (checkType === "prepared_deposit") {
      summary = summarizePreparedDeposit(evidence, stationCode, checkDate);
    } else {
      const rosterAssociates = extractDriverReconciliationAssociates(evidence, stationCode);
      const enrichedAssociates = await collectPendingDetailsForAssociates(page, rosterAssociates);
      summary = summarizeDriverReconciliation(evidence, stationCode, checkDate, enrichedAssociates);
    }

    return {
      ...summary,
      evidence: {
        ...summary.evidence,
        debug_screenshot: debugScreenshot,
        station_selector: stationResult,
        date_selector: dateResult,
        driver_selector: driverResult
      },
      raw_result: {
        login: { ...loginResult, session_reused: hasStoredSession, session_saved: true },
        station_selector: stationResult,
        date_selector: dateResult,
        driver_selector: driverResult,
        inspected_url: evidence.url,
        page_title: evidence.title
      }
    };
  } finally {
    await closeBrowserSafely(browser);
  }
}

async function runSccWarmup(payload) {
  const warmupPayload = normalizePortalPayload(payload);
  const portalName = portalShortName(warmupPayload);

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: Number.isFinite(SLOW_MO_MS) ? SLOW_MO_MS : 0
  });

  try {
    await mkdir(SESSION_STATE_DIR, { recursive: true });
    const statePath = sessionStatePath(warmupPayload);
    const hasStoredSession = await pathExists(statePath);
    const context = await browser.newContext({
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      viewport: { width: 1440, height: 1000 },
      ...(hasStoredSession ? { storageState: statePath } : {})
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    const loginResult = await maybeLogin(page, warmupPayload);
    const text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
    const authenticatedPage = isAuthenticatedPortalPage(text, page.url());
    const stillBlocked = !loginResult.loggedIn ||
      (!authenticatedPage && (hasMfaOrHumanBlocker(text) || isLoginVisible(text, page.url())));

    if (stillBlocked) {
      const debugScreenshot = await captureDebug(page, warmupPayload.run_id || "warmup", "login-blocked");
      const pageTitle = await page.title().catch(() => "");
      const pageUrl = page.url();
      await context.close().catch(() => null);
      return {
        status: "Manual Review",
        pending_count: 0,
        pending_amount: 0,
        summary: loginResult.message || `Amazon still needs approval inside the ${portalName} worker browser. Your Chrome login is not reused by the worker. Complete Login worker once, then retry sync/check.`,
        evidence: {
          url: pageUrl,
          title: pageTitle,
          debug_screenshot: debugScreenshot
        },
        raw_result: {
          login: { ...loginResult, session_reused: hasStoredSession }
        }
      };
    }

    await context.storageState({ path: statePath });
    const pageTitle = await page.title().catch(() => "");
    const pageUrl = page.url();
    await context.close().catch(() => null);
    return {
      status: "Ready",
      pending_count: 0,
      pending_amount: 0,
      summary: `${portalName} worker session is ready and saved for automatic sync.`,
      evidence: {
        url: pageUrl,
        title: pageTitle,
        session_state_saved: true
      },
      raw_result: {
        login: { ...loginResult, session_reused: hasStoredSession, session_saved: true }
      }
    };
  } finally {
    await closeBrowserSafely(browser);
  }
}

async function handleRun(req, res) {
  if (!assertAuthorized(req, res)) return;
  const payload = await parseJsonBody(req);
  const result = await withWorkerTimeout(runSccCheck(payload));
  jsonResponse(res, 200, result);
}

/**
 * Capture Amazon Site Summary for several stations in one authenticated browser
 * session. Screenshots are returned as base64 so the report-bot runner can post
 * them to WhatsApp without writing Amazon data into the dashboard filesystem.
 *
 * capture_mode:
 * - dom: read Site Summary HTML/CSS directly (best accuracy; run where the portal is reachable)
 * - workspace-stream: watch Amazon WorkSpaces Web Access canvas in the browser
 *   (https://ap-southeast-1.webclient.amazonworkspaces.com/wsp.html) and detect red pixels
 */
async function runStationSummaryMonitor(payload = {}) {
  const stations = Array.isArray(payload.stations)
    ? payload.stations.map((value) => String(value).trim()).filter(Boolean)
    : [];
  if (!stations.length) throw new Error("stations must contain at least one station code.");

  const captureMode = resolveCaptureMode(payload);
  const session = await openStationSummarySession({ ...payload, capture_mode: captureMode });
  const { browser, context, page, keepBrowserOpen, statePath, mode } = session;

  try {
    if (captureMode === "workspace-stream") {
      return await runWorkspaceStreamMonitor(payload, session);
    }

    const targetUrl = String(payload.url || process.env.AMAZON_SITE_SUMMARY_URL || SITE_SUMMARY_DEFAULT_URL).trim() || SITE_SUMMARY_DEFAULT_URL;
    const settleMs = Math.max(400, Number(payload.settle_ms || 1400));
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);

    const loginPayload = {
      ...payload,
      portal_code: "site-summary",
      login_url: targetUrl
    };
    let login = mode === "cdp"
      ? await (async () => {
        if (!/siteSummary|store-management/i.test(page.url())) {
          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
          await page.waitForTimeout(settleMs);
        }
        const text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
        if (isSiteSummaryAuthenticated(text, page.url()) || !isLoginVisible(text, page.url())) {
          return { loggedIn: true, message: "Attached to an already authenticated browser session." };
        }
        return {
          loggedIn: false,
          manualReview: true,
          message: "Connected over CDP, but Site Summary still shows a login screen. Complete Amazon login in that Chrome window, then retry."
        };
      })()
      : await maybeLogin(page, loginPayload, targetUrl);

    // Interactive local/dev runs keep the browser open so the operator can finish
    // Amazon login/MFA with the same WorkSpaces credentials, then continue.
    if (!login.loggedIn && (!HEADLESS || ENABLE_VNC || mode === "cdp")) {
      const waitMs = Math.min(
        Number(payload.login_wait_ms || process.env.AMAZON_LOGIN_WAIT_MS || 300000),
        600000
      );
      console.log(`Waiting up to ${Math.round(waitMs / 1000)}s for Site Summary Amazon login in the open browser...`);
      const deadline = Date.now() + waitMs;
      let approved = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(3000).catch(() => null);
        const text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
        if (isSiteSummaryAuthenticated(text, page.url()) ||
          (!isLoginVisible(text, page.url()) && /store-management|siteSummary/i.test(page.url()) && !hasMfaOrHumanBlocker(text))) {
          approved = true;
          break;
        }
      }
      if (approved) {
        login = { loggedIn: true, message: "Amazon Site Summary login completed interactively." };
        if (statePath) await context.storageState({ path: statePath }).catch(() => null);
      }
    }

    if (!login.loggedIn) {
      return {
        status: "Manual Review",
        summary: login.message || "Complete Amazon Site Summary login in the worker browser, then retry.",
        stations,
        alert_count: 0,
        alerts: [],
        checked_at: new Date().toISOString(),
        browser_mode: mode,
        capture_mode: "dom"
      };
    }

    const alerts = [];
    const stationResults = [];

    for (const station of stations) {
      if (!/siteSummary/i.test(page.url())) {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
        await page.waitForTimeout(settleMs);
      }

      const stationResult = await setSiteSummaryStation(page, station);
      await page.waitForTimeout(settleMs);
      const red = await detectRedSiteSummaryMetrics(page);
      stationResults.push({
        station,
        switched: stationResult.changed || stationResult.method === "already-active",
        station_selector: stationResult,
        red_detected: Boolean(red.detected),
        matching_elements: red.matching_elements || 0,
        metrics: red.metrics || []
      });

      if (!red.detected) continue;

      const image = await page.screenshot({ type: "png", fullPage: true });
      const metricSignature = (red.metrics || [])
        .map((metric) => `${metric.label}:${metric.value}`)
        .sort()
        .join("|");
      alerts.push({
        station,
        station_selector: stationResult,
        reason: "red-metric",
        matching_elements: red.matching_elements,
        metrics: red.metrics,
        metric_signature: metricSignature,
        page_text: red.text,
        page_url: red.url || page.url(),
        page_title: red.title,
        image_base64: image.toString("base64"),
        mime: "image/png",
        capture_mode: "dom",
        captured_at: new Date().toISOString()
      });
    }

    if (statePath) await context.storageState({ path: statePath }).catch(() => null);

    return {
      status: "Ready",
      stations,
      station_results: stationResults,
      alert_count: alerts.length,
      alerts,
      checked_at: new Date().toISOString(),
      browser_mode: mode,
      capture_mode: "dom",
      summary: alerts.length
        ? `Captured ${alerts.length} red Site Summary screenshot(s) across ${stations.length} station(s).`
        : `Checked ${stations.length} station(s); no red Site Summary metrics detected.`
    };
  } finally {
    if (!keepBrowserOpen) {
      await context.close().catch(() => null);
      await closeBrowserSafely(browser);
    }
  }
}

async function handleStationSummary(req, res) {
  if (!assertAuthorized(req, res)) return;
  const payload = await parseJsonBody(req);
  jsonResponse(res, 200, await withTimeout(
    runStationSummaryMonitor(payload),
    STATION_SUMMARY_TIMEOUT_MS,
    "Station summary monitor"
  ));
}

async function handleWarmup(req, res) {
  if (!assertAuthorized(req, res)) return;
  const payload = await parseJsonBody(req);
  const result = await withWorkerTimeout(runSccWarmup(payload));
  jsonResponse(res, 200, result);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/") {
      return htmlResponse(res, 200, landingPage());
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse(res, 200, workerInfo());
    }
    if (req.method === "POST" && url.pathname === "/warmup") return await handleWarmup(req, res);
    if (req.method === "POST" && url.pathname === "/station-summary") return await handleStationSummary(req, res);
    if (req.method === "POST" && (url.pathname === "/run" || url.pathname === "/")) {
      return await handleRun(req, res);
    }
    jsonResponse(res, 404, { error: "Not found" });
  } catch (error) {
    jsonResponse(res, 500, {
      status: "Error",
      error: error instanceof Error ? error.message : "Worker failed.",
      summary: error instanceof Error ? error.message : "Worker failed.",
      pending_count: 0,
      pending_amount: 0
    });
  }
});

server.listen(PORT, () => {
  console.log(`Amazon Portal Playwright worker listening on ${PORT}`);
});
