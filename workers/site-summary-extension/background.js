// Background script — monitoring cycle with Start / Pause / Resume / Stop
// v1.4 — screenshot scaled to 900px via createImageBitmap (no DOM APIs in bg script),
//         cycleRunning reset on tab error, sendTest uses CONFIG.STATIONS[0]

"use strict";

// ── State ─────────────────────────────────────────────────────────────────────
let monitoring     = false;
let paused         = false;
let cycleTimer     = null;
let statusMsg      = "Stopped";
let lastCycleAt    = null;
let currentStation = null;
// station → timestamp of last sent alert
const cooldowns    = {};
// Log ring buffer
const log          = [];
function addLog(msg) {
  const ts = new Date().toLocaleTimeString("en-IN", { hour12: false });
  log.unshift(`[${ts}] ${msg}`);
  if (log.length > 80) log.pop();
}

// ── Config (config.js loaded before this in manifest) ─────────────────────────

function groupFor(stationCode) {
  if (CONFIG.TESTING_GROUP) return CONFIG.TESTING_GROUP;
  return CONFIG.STATION_GROUPS[stationCode] || "";
}

function switchWaitFor(stationCode) {
  return CONFIG.SWITCH_WAIT_OVERRIDES[stationCode] || CONFIG.SWITCH_WAIT_MS;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtClock(s) {
  if (s == null || s < 0) return "—";
  const sec = Math.round(s);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

function isOnCooldown(station) {
  const last = cooldowns[station] || 0;
  return Date.now() - last < CONFIG.COOLDOWN_MINUTES * 60_000;
}
function markSent(station) { cooldowns[station] = Date.now(); }

// ── Tab management ─────────────────────────────────────────────────────────────
async function getSiteSummaryTab() {
  const tabs = await browser.tabs.query({ url: "https://eu.store-management.f3.amazon.dev/*" });
  return tabs.length ? tabs[0] : null;
}

async function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise(resolve => {
    const done = () => { browser.tabs.onUpdated.removeListener(listener); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") { clearTimeout(timer); done(); }
    }
    browser.tabs.onUpdated.addListener(listener);
  });
}

async function ensureSiteSummaryTab() {
  let tab = await getSiteSummaryTab();
  if (!tab) {
    tab = await browser.tabs.create({ url: "https://eu.store-management.f3.amazon.dev/siteSummary", active: false });
    await waitForTabLoad(tab.id, 20000);
    // Extra buffer for content script injection + React hydration
    await sleep(5000);
  }
  return tab;
}

async function refreshSiteSummaryTab() {
  const tab = await getSiteSummaryTab();
  if (!tab) return { ok: false, reason: "no tab" };
  await browser.tabs.reload(tab.id);
  addLog("⟳ Page refreshed");
  return { ok: true };
}

// ── Tab messaging ──────────────────────────────────────────────────────────────
async function sendToTab(tabId, msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await browser.tabs.sendMessage(tabId, msg);
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1500);
    }
  }
}

// ── Image generation (OffscreenCanvas) — fallback when screenshot fails ───────
async function buildAlertImage(stationCode, breachingRows, thresholdS) {
  const W = 600, ROW_H = 42, HEADER_H = 52, BANNER_H = 44, TABLE_HEAD_H = 36, FOOTER_H = 32;
  const rows = breachingRows.slice(0, 8);
  const H = HEADER_H + BANNER_H + TABLE_HEAD_H + rows.length * ROW_H + FOOTER_H;

  const canvas = new OffscreenCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  const RED   = "#dc2626", AMBER = "#d97706", DARK = "#1e293b";
  const LIGHT = "#f8fafc", BORDER = "#e5e7eb", TEXT = "#374151";
  const MUTED = "#6b7280", WHITE = "#ffffff";

  const nowIST = new Date(Date.now() + 5.5 * 3600 * 1000);
  const timeLabel  = `${String(nowIST.getUTCHours()).padStart(2,"0")}:${String(nowIST.getUTCMinutes()).padStart(2,"0")} IST`;
  const slaClock   = fmtClock(thresholdS);
  const worst      = rows.reduce((a, b) => (b.elapsedS ?? 0) > (a.elapsedS ?? 0) ? b : a, rows[0]);
  const worstClock = fmtClock(worst.elapsedS);

  let y = 0;

  // Header
  ctx.fillStyle = DARK; ctx.fillRect(0, y, W, HEADER_H);
  ctx.fillStyle = WHITE; ctx.font = "bold 20px Arial"; ctx.textBaseline = "middle";
  ctx.fillText(stationCode, 16, y + HEADER_H / 2);
  ctx.fillStyle = "#94a3b8"; ctx.font = "12px Arial"; ctx.textAlign = "right";
  ctx.fillText(timeLabel, W - 16, y + HEADER_H / 2);
  ctx.textAlign = "left"; y += HEADER_H;

  // Alert banner
  ctx.fillStyle = "#fef2f2"; ctx.fillRect(0, y, W, BANNER_H);
  ctx.fillStyle = RED; ctx.fillRect(0, y, 4, BANNER_H);
  ctx.font = "bold 13px Arial"; ctx.textBaseline = "middle"; ctx.fillStyle = RED;
  const bannerLeft1 = `⚠  ${rows.length} order${rows.length > 1 ? "s" : ""} pending acceptance`;
  ctx.fillText(bannerLeft1, 14, y + BANNER_H / 2);
  ctx.fillStyle = AMBER;
  const bx = 14 + ctx.measureText(bannerLeft1).width + 10;
  ctx.fillText(`Worst: ${worstClock}`, bx, y + BANNER_H / 2);
  y += BANNER_H;

  // Table header
  ctx.fillStyle = RED; ctx.fillRect(0, y, W, TABLE_HEAD_H);
  ctx.fillStyle = WHITE; ctx.font = "bold 12px Arial";
  ctx.fillText("OID",              10,  y + TABLE_HEAD_H / 2);
  ctx.fillText("Associate",        100, y + TABLE_HEAD_H / 2);
  ctx.fillText("Items",            268, y + TABLE_HEAD_H / 2);
  ctx.fillText("Acceptance / SLA", 326, y + TABLE_HEAD_H / 2);
  y += TABLE_HEAD_H;

  // Order rows
  ctx.font = "13px Arial";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    ctx.fillStyle = i % 2 === 0 ? LIGHT : WHITE;
    ctx.fillRect(0, y, W, ROW_H);
    ctx.strokeStyle = BORDER; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + ROW_H); ctx.lineTo(W, y + ROW_H); ctx.stroke();
    ctx.textBaseline = "middle";

    ctx.fillStyle = TEXT;
    ctx.fillText(row.oid, 10, y + ROW_H / 2);

    ctx.fillStyle = MUTED;
    const assoc = row.associate.length > 18 ? row.associate.slice(0, 17) + "…" : row.associate;
    ctx.fillText(assoc, 100, y + ROW_H / 2);

    ctx.fillStyle = TEXT;
    ctx.fillText(String(row.items), 268, y + ROW_H / 2);

    ctx.font = "bold 13px Arial";
    ctx.fillStyle = row.red ? RED : "#16a34a";
    ctx.fillText(`${row.elapsedText || "—"} / ${row.slaText || slaClock}`, 326, y + ROW_H / 2);
    ctx.font = "13px Arial";
    y += ROW_H;
  }

  // Footer
  ctx.fillStyle = LIGHT; ctx.fillRect(0, y, W, FOOTER_H);
  ctx.strokeStyle = BORDER; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  ctx.fillStyle = MUTED; ctx.font = "11px Arial"; ctx.textBaseline = "middle";
  ctx.fillText("Site Summary Monitor · DropX OpsPulse", 14, y + FOOTER_H / 2);

  return canvas.convertToBlob({ type: "image/png" });
}

// ── Screenshot capture ─────────────────────────────────────────────────────────
// Tab must already be active and in foreground when called.
// windowId is passed to captureVisibleTab so it works even if tab is in a non-current window.
async function captureTabScreenshot(tabId) {
  const tabInfo = await browser.tabs.get(tabId).catch(() => null);
  const windowId = tabInfo?.windowId ?? null;
  const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: "png" });

  // Scale to fixed 900px wide so WhatsApp renders it at a readable size
  // without distortion regardless of the browser viewport width.
  // Use createImageBitmap + OffscreenCanvas — Image and FileReader are not
  // available in background scripts (no DOM).
  const TARGET_W = 1400;
  const resp = await fetch(dataUrl);
  const srcBlob = await resp.blob();
  const bitmap = await createImageBitmap(srcBlob);
  const scale = TARGET_W / bitmap.width;
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(TARGET_W, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, TARGET_W, h);
  bitmap.close();
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const arrayBuf = await outBlob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

// ── WhatsApp send ──────────────────────────────────────────────────────────────
async function sendWhatsApp(stationCode, breachingRows, { overrideGroup, tabId } = {}) {
  const to = overrideGroup || groupFor(stationCode);
  if (!to) { addLog(`⚠ ${stationCode}: no group JID — skipped`); return { ok: false, reason: "no_group" }; }

  const worst      = breachingRows.reduce((a, b) => (b.elapsedS ?? 0) > (a.elapsedS ?? 0) ? b : a, breachingRows[0]);
  const worstClock = fmtClock(worst.elapsedS);
  const unassigned = breachingRows.filter(r => !r.associate || r.associate === "Unassigned" || r.associate === "No Idle Associates");
  const allAssigned = unassigned.length === 0;
  const orderWord = breachingRows.length === 1 ? "order" : "orders";
  const bullet = allAssigned
    ? `Acceptance time over ${CONFIG.ACCEPTANCE_THRESHOLD_S}s SLA (Worst ${worstClock})`
    : `${breachingRows.length} ${orderWord} pending acceptance (Worst ${worstClock})`;
  const action = allAssigned
    ? "Ask people to accept fast"
    : "Move more people to picking or ask people to accept fast";
  const caption = [stationCode, `* ${bullet}`, "", action].join("\n");

  // Use browser screenshot if tab is available, else fall back to generated image
  let imageBase64;
  if (tabId) {
    try {
      imageBase64 = await captureTabScreenshot(tabId);
      addLog(`📸 ${stationCode}: screenshot captured`);
    } catch (e) {
      addLog(`⚠ ${stationCode}: screenshot failed (${e.message}), using generated image`);
    }
  }
  if (!imageBase64) {
    const blob     = await buildAlertImage(stationCode, breachingRows, CONFIG.ACCEPTANCE_THRESHOLD_S);
    const arrayBuf = await blob.arrayBuffer();
    const bytes    = new Uint8Array(arrayBuf);
    let binary = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    imageBase64 = btoa(binary);
  }

  const windowId  = Math.floor(Date.now() / (CONFIG.COOLDOWN_MINUTES * 60_000));
  const clientRef = `ssmon_${stationCode}_${windowId}`;

  const r = await fetch(`${CONFIG.WA_URL}/send`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${CONFIG.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_ref: clientRef, to, image_base64: imageBase64, mime: "image/png", caption }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`WhatsApp send failed (${r.status}): ${body}`);
  }
  addLog(`✅ ${stationCode} → alert sent (worst ${worstClock}) → ${overrideGroup ? "testing group" : "war room"}`);
  return { ok: true };
}

// ── Send Test ──────────────────────────────────────────────────────────────────
async function sendTest() {
  const testingGroup = CONFIG.TESTING_GROUP || "120363429732355530@g.us";
  const fakeRows = [{
    oid: "TEST", items: "3", associate: "testuser",
    elapsedText: "00:26", elapsedS: 26, slaText: "00:15", slaS: 15, red: true,
  }];
  try {
    const tab = await getSiteSummaryTab();
    if (tab) {
      // Make tab active so captureVisibleTab works
      await browser.tabs.update(tab.id, { active: true }).catch(() => {});
      await sleep(300);
      const data = await sendToTab(tab.id, { type: "READ_SITE_SUMMARY" });
      const storeId     = data?.storeId;
      const stationCode = CONFIG.STORE_MAP[storeId] || "TEST";
      const realRows    = (data?.rows || []).filter(r => r.elapsedS != null && r.elapsedS > 0);
      const rows        = realRows.length ? realRows : fakeRows;
      await sendWhatsApp(stationCode, rows, { overrideGroup: testingGroup, tabId: tab.id });
      addLog(`🔔 Test sent for ${stationCode}`);
      return { ok: true };
    }
  } catch (e) {
    addLog(`⚠ Test: falling back to fake data (${e.message})`);
  }
  await sendWhatsApp(CONFIG.STATIONS[0] || "TEST", fakeRows, { overrideGroup: testingGroup });
  addLog("🔔 Test sent (fake data — no Site Summary tab open)");
  return { ok: true };
}

// ── Core: check one station ───────────────────────────────────────────────────
async function checkStation(tabId, stationCode, storeId) {
  currentStation = stationCode;

  // Remember which tab was active so we can restore it on every exit path
  const prevTabs = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const prevTabId = prevTabs[0]?.id ?? null;

  async function restorePrevTab() {
    if (prevTabId && prevTabId !== tabId) {
      await browser.tabs.update(prevTabId, { active: true }).catch(() => {});
    }
  }

  addLog(`→ Switching to ${stationCode}…`);

  // Bring tab to foreground — shadow DOM needs to be visible for kat-dropdown
  // options to render, and captureVisibleTab needs the tab active for screenshot.
  await browser.tabs.update(tabId, { active: true }).catch(() => {});

  // Send SWITCH_STATION: content.js polls until the shadow <select> is ready,
  // sets its value, and waits for React to confirm via the attribute.
  try {
    const switchResult = await sendToTab(tabId, { type: "SWITCH_STATION", storeId });
    if (!switchResult?.ok) addLog(`⚠ ${stationCode}: switch not confirmed (${switchResult?.reason ?? "timeout"})`);
  } catch (e) {
    addLog(`⚠ ${stationCode}: switch failed — ${e.message}`);
    await restorePrevTab();
    return;
  }

  // Wait for data fetch to complete
  const waitMs = switchWaitFor(stationCode);
  addLog(`${stationCode}: waiting ${waitMs / 1000}s for data to load…`);
  await sleep(waitMs);

  // Guard: if stopped or paused while sleeping, bail
  if (!monitoring || paused) {
    await restorePrevTab();
    return;
  }

  let data;
  try {
    data = await sendToTab(tabId, { type: "READ_SITE_SUMMARY" });
  } catch (e) {
    addLog(`⚠ ${stationCode}: read failed — ${e.message}`);
    await restorePrevTab();
    return;
  }

  if (!data?.onSiteSummary) {
    addLog(`⚠ ${stationCode}: not on Site Summary`);
    await restorePrevTab();
    return;
  }

  // "Pending acceptance" = red acceptance time AND no associate assigned yet.
  // Orders assigned to a picker are accepted even if picking hasn't started (0%).
  // The banner count confirms this — it only counts unassigned red rows.
  const UNASSIGNED = ["Unassigned", "No Idle Associates", ""];
  const isUnassigned = r => !r.associate || UNASSIGNED.includes(r.associate.trim());
  const redRows = (data.rows || []).filter(r => r.red === true);
  const pendingRows = redRows.filter(r => isUnassigned(r));
  const bannerCount = data.bannerPendingCount ?? null;

  // Use banner count to catch rows not in DOM (pagination/scroll), pad if needed
  let breaching = pendingRows;
  if (bannerCount !== null && bannerCount > pendingRows.length) {
    const extra = bannerCount - pendingRows.length;
    const synthetic = Array.from({ length: extra }, () => ({
      oid: "—", items: "—", pct: "—", associate: "No Idle Associates",
      elapsedText: null, elapsedS: null, slaText: "00:15", slaS: 15, red: true,
    }));
    breaching = [...pendingRows, ...synthetic];
  }
  addLog(`${stationCode}: ${(data.rows||[]).length} orders, ${breaching.length} breaching`);

  if (breaching.length === 0) {
    await restorePrevTab();
    return;
  }

  if (isOnCooldown(stationCode)) {
    addLog(`${stationCode}: cooldown — skipped`);
    await restorePrevTab();
    return;
  }

  // Tab is already in foreground — screenshot + send, then restore
  try {
    await sendWhatsApp(stationCode, breaching, { tabId });
    markSent(stationCode);
  } catch (e) {
    addLog(`❌ ${stationCode}: send error — ${e.message}`);
  }

  await restorePrevTab();
}

// ── Full cycle ─────────────────────────────────────────────────────────────────
let cycleRunning = false;

async function runCycle() {
  if (!monitoring || paused) return;
  if (cycleRunning) { addLog("⚠ cycle already running — skipped"); return; }
  cycleRunning = true;
  statusMsg = "Running cycle…";
  addLog("── cycle start ──");

  let tab;
  try { tab = await ensureSiteSummaryTab(); } catch (e) { addLog(`❌ Tab error: ${e.message}`); statusMsg = "Error — no tab"; cycleRunning = false; scheduleNext(); return; }
  if (!tab) { addLog("❌ No Site Summary tab"); statusMsg = "Error — no tab"; cycleRunning = false; scheduleNext(); return; }

  const codeToStore = {};
  for (const [id, code] of Object.entries(CONFIG.STORE_MAP)) codeToStore[code] = id;

  for (const stationCode of CONFIG.STATIONS) {
    if (!monitoring || paused) break;
    const storeId = codeToStore[stationCode];
    if (!storeId) { addLog(`⚠ ${stationCode}: no storeId`); continue; }
    try { await checkStation(tab.id, stationCode, storeId); }
    catch (e) { addLog(`❌ ${stationCode}: ${e.message}`); }
    if (monitoring && !paused) await sleep(400);
  }

  currentStation = null;
  lastCycleAt    = Date.now();
  cycleRunning   = false;
  statusMsg      = paused ? "Paused" : "Watching…";
  addLog("── cycle done ──");
  updateBadge();
  scheduleNext();
}

function scheduleNext() {
  if (!monitoring || paused) return;
  cycleTimer = setTimeout(runCycle, CONFIG.CYCLE_INTERVAL_S * 1000);
}

// ── Badge ──────────────────────────────────────────────────────────────────────
function updateBadge() {
  if (!monitoring)       { browser.browserAction.setBadgeText({ text: "" }); return; }
  if (paused)            { browser.browserAction.setBadgeText({ text: "⏸" }); browser.browserAction.setBadgeBackgroundColor({ color: "#6366f1" }); return; }
  if (currentStation)    { browser.browserAction.setBadgeText({ text: currentStation.slice(0,4) }); browser.browserAction.setBadgeBackgroundColor({ color: "#d97706" }); return; }
  browser.browserAction.setBadgeText({ text: "ON" });
  browser.browserAction.setBadgeBackgroundColor({ color: "#16a34a" });
}

// ── Start / Pause / Resume / Stop ──────────────────────────────────────────────
function startMonitoring() {
  if (monitoring && !paused) return;
  monitoring = true; paused = false;
  statusMsg  = "Starting…";
  addLog("▶ Monitoring started");
  browser.storage.local.set({ monitoring: true });
  updateBadge();
  runCycle();
}

function pauseMonitoring() {
  if (!monitoring) return;
  paused    = true;
  statusMsg = "Paused";
  if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; }
  addLog("⏸ Paused");
  updateBadge();
}

function resumeMonitoring() {
  if (!monitoring || !paused) return;
  paused    = false;
  statusMsg = "Resuming…";
  addLog("▶ Resumed");
  updateBadge();
  runCycle();
}

function stopMonitoring() {
  monitoring = false; paused = false;
  if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; }
  currentStation = null;
  statusMsg = "Stopped";
  addLog("⏹ Stopped");
  browser.storage.local.set({ monitoring: false });
  updateBadge();
}

// ── Message handler ────────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_STATUS") {
    sendResponse({ monitoring, paused, statusMsg, lastCycleAt, currentStation, log: log.slice(0, 30) });
    return false;
  }
  if (msg.type === "START")   { startMonitoring();   sendResponse({ ok: true }); return false; }
  if (msg.type === "PAUSE")   { pauseMonitoring();   sendResponse({ ok: true }); return false; }
  if (msg.type === "RESUME")  { resumeMonitoring();  sendResponse({ ok: true }); return false; }
  if (msg.type === "STOP")    { stopMonitoring();    sendResponse({ ok: true }); return false; }
  if (msg.type === "RUN_NOW") {
    if (!monitoring) startMonitoring();
    else { clearTimeout(cycleTimer); cycleTimer = null; paused = false; runCycle(); }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "REFRESH_TAB") {
    refreshSiteSummaryTab().then(r => sendResponse(r));
    return true;
  }
  if (msg.type === "SEND_TEST") {
    sendTest().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// ── Restore on startup ──────────────────────────────────────────────────────────
browser.storage.local.get(["monitoring"]).then(stored => {
  if (stored.monitoring) startMonitoring();
});
