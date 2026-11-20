"use strict";

const dot         = document.getElementById("dot");
const statusText  = document.getElementById("status-text");
const stationChip = document.getElementById("station-chip");
const logEl       = document.getElementById("log");
const toast       = document.getElementById("toast");

const btnStart   = document.getElementById("btn-start");
const btnPause   = document.getElementById("btn-pause");
const btnRunnow  = document.getElementById("btn-runnow");
const btnStop    = document.getElementById("btn-stop");
const btnRefresh = document.getElementById("btn-refresh");
const btnTest    = document.getElementById("btn-test");

function showToast(msg, ms = 2000) {
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), ms);
}

function renderLog(lines) {
  logEl.innerHTML = lines.map(line => {
    let cls = "";
    if (line.startsWith("✅")) cls = "ok";
    else if (line.startsWith("❌")) cls = "err";
    else if (line.startsWith("⚠")) cls = "warn";
    else if (line.includes("── cycle")) cls = "sep";
    return `<div class="log-line ${cls}">${escHtml(line)}</div>`;
  }).join("");
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function applyStatus({ monitoring, paused, statusMsg, currentStation, log }) {
  // Dot state
  dot.className = "dot";
  if (monitoring && !paused && currentStation) dot.classList.add("run");
  else if (monitoring && !paused) dot.classList.add("on");
  else if (monitoring && paused) dot.classList.add("pause");

  statusText.textContent = statusMsg || "—";

  if (currentStation) {
    stationChip.textContent = currentStation;
    stationChip.style.display = "";
  } else {
    stationChip.style.display = "none";
  }

  // Button states
  btnStart.disabled  = monitoring && !paused;
  btnPause.disabled  = !monitoring;
  btnPause.textContent = (monitoring && paused) ? "▶ Resume" : "⏸ Pause";
  btnRunnow.disabled = false;
  btnStop.disabled   = !monitoring;
  btnRefresh.disabled = false;
  btnTest.disabled   = false;

  if (log) renderLog(log);
}

async function getStatus() {
  try {
    const bg = await browser.runtime.sendMessage({ type: "GET_STATUS" });
    applyStatus(bg);
  } catch {}
}

// Poll status every 1.5s while popup is open
getStatus();
const pollTimer = setInterval(getStatus, 1500);
window.addEventListener("unload", () => clearInterval(pollTimer));

// ── Buttons ────────────────────────────────────────────────────────────────────

btnStart.addEventListener("click", async () => {
  btnStart.disabled = true;
  await browser.runtime.sendMessage({ type: "START" });
  showToast("Monitoring started");
  getStatus();
});

btnPause.addEventListener("click", async () => {
  const bg = await browser.runtime.sendMessage({ type: "GET_STATUS" });
  if (bg.paused) {
    await browser.runtime.sendMessage({ type: "RESUME" });
    showToast("Resumed");
  } else {
    await browser.runtime.sendMessage({ type: "PAUSE" });
    showToast("Paused — cycle will finish then hold");
  }
  getStatus();
});

btnRunnow.addEventListener("click", async () => {
  btnRunnow.disabled = true;
  await browser.runtime.sendMessage({ type: "RUN_NOW" });
  showToast("Cycle started");
  setTimeout(getStatus, 300);
  setTimeout(() => { btnRunnow.disabled = false; }, 2000);
});

btnStop.addEventListener("click", async () => {
  btnStop.disabled = true;
  await browser.runtime.sendMessage({ type: "STOP" });
  showToast("Monitoring stopped");
  getStatus();
});

btnRefresh.addEventListener("click", async () => {
  btnRefresh.disabled = true;
  btnRefresh.textContent = "Refreshing…";
  await browser.runtime.sendMessage({ type: "REFRESH_TAB" });
  showToast("Page refreshed");
  setTimeout(() => { btnRefresh.textContent = "⟳ Refresh Page"; btnRefresh.disabled = false; }, 2000);
});

btnTest.addEventListener("click", async () => {
  btnTest.disabled = true;
  btnTest.textContent = "Sending…";
  try {
    const r = await browser.runtime.sendMessage({ type: "SEND_TEST" });
    showToast(r.ok ? "✅ Test sent to Dark Store Testing!" : `❌ ${r.error}`);
  } catch (e) {
    showToast(`❌ ${e.message}`);
  }
  setTimeout(() => { btnTest.textContent = "🔔 Send Test"; btnTest.disabled = false; }, 3000);
  getStatus();
});
