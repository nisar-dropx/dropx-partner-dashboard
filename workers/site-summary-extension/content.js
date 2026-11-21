// Content script — runs on eu.store-management.f3.amazon.dev
// Reads the Site Summary DOM and responds to background requests.

(function () {
  "use strict";

  if (typeof browser === "undefined") {
    console.error("DropX Monitor: not running in Firefox — extension not loaded");
    return;
  }

  // ── DOM readers ─────────────────────────────────────────────────────────────

  function getStoreId() {
    // kat-dropdown value attribute holds the current storeId UUID
    const dd = document.querySelector('kat-dropdown[data-testid="site-selection"]');
    return dd ? dd.getAttribute("value") : null;
  }

  function isOnSiteSummary() {
    return window.location.pathname.startsWith("/siteSummary")
      || !!document.querySelector('table.kat-table td.procurementListCreatedTime');
  }

  function parseClockToSeconds(text) {
    if (!text) return null;
    const t = text.trim();
    // mm:ss  or  hh:mm:ss
    const parts = t.split(":").map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function isRed(el) {
    if (!el) return false;
    const style = el.getAttribute("style") || "";
    // Inline style: color: rgb(173, 10, 48)  or  color: rgb(220, 38, 38) etc.
    const m = style.match(/color:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return false;
    const r = +m[1], g = +m[2], b = +m[3];
    // Red = high R, low G, low B
    return r > 150 && g < 60 && b < 80;
  }

  function readRows() {
    const rows = [];
    const tbody = document.querySelector('table.kat-table tbody');
    if (!tbody) return rows;

    for (const tr of tbody.querySelectorAll("tr")) {
      const oidEl       = tr.querySelector("td.orderId a");
      const itemsEl     = tr.querySelector("td.totalItems");
      const pctEl       = tr.querySelector("td.percentageCompleted");
      const assocEl     = tr.querySelector("td.associateId a");
      const acceptCell  = tr.querySelector("td.procurementListCreatedTime");

      if (!acceptCell) continue;

      const elapsedEl = acceptCell.querySelector("span.elapsedTime");
      const elapsedText = elapsedEl ? elapsedEl.textContent.trim() : null;
      const elapsedS    = parseClockToSeconds(elapsedText);

      // SLA text e.g. "/ 00:15"
      const slaEl   = acceptCell.querySelector("span:not(.elapsedTime)");
      const slaText = slaEl ? slaEl.textContent.replace("/", "").trim() : "00:15";
      const slaS    = parseClockToSeconds(slaText) ?? 15;

      rows.push({
        oid:      oidEl    ? oidEl.textContent.trim()   : "—",
        items:    itemsEl  ? itemsEl.textContent.trim()  : "—",
        pct:      pctEl    ? pctEl.textContent.trim()    : "—",
        associate: assocEl ? assocEl.textContent.trim()  : "Unassigned",
        elapsedText,
        elapsedS,
        slaText,
        slaS,
        red: isRed(elapsedEl),
      });
    }
    return rows;
  }

  function readSiteSummary() {
    return {
      storeId: getStoreId(),
      onSiteSummary: isOnSiteSummary(),
      rows: readRows(),
      readAt: Date.now(),
    };
  }

  // ── Station switcher ─────────────────────────────────────────────────────────
  // The kat-dropdown is a custom web component. We set its value and dispatch a
  // change event to trigger the React state update.

  function switchToStore(storeId) {
    const dd = document.querySelector('kat-dropdown[data-testid="site-selection"]');
    if (!dd) return false;

    // If already on the right store, just click refresh to get fresh data
    if (dd.getAttribute("value") === storeId) {
      clickRefresh();
      return true;
    }

    // Set value on the web component
    dd.value = storeId;
    dd.setAttribute("value", storeId);
    // Fire all event types the component or React may listen to
    dd.dispatchEvent(new Event("input",  { bubbles: true }));
    dd.dispatchEvent(new Event("change", { bubbles: true }));
    dd.dispatchEvent(new CustomEvent("kat-change", { bubbles: true, detail: { value: storeId } }));

    // After a short delay, also click the refresh button to force data reload
    setTimeout(clickRefresh, 2000);
    return true;
  }

  function clickRefresh() {
    // The refresh button is inside the kat-popover trigger slot
    const btn = document.querySelector('button[slot="trigger"].sc-bQdRvg, .sc-iJminA button, button kat-icon[name="refresh"]');
    const refreshBtn = btn || document.querySelector('kat-icon[name="refresh"]')?.closest('button');
    if (refreshBtn) refreshBtn.click();
  }

  // Poll until the dropdown value matches storeId OR timeout, then report readiness
  function waitForStoreSwitch(storeId, timeoutMs, callback) {
    const start = Date.now();
    function check() {
      const dd = document.querySelector('kat-dropdown[data-testid="site-selection"]');
      const current = dd ? dd.getAttribute("value") : null;
      if (current === storeId) { callback(true); return; }
      if (Date.now() - start > timeoutMs) { callback(false); return; }
      setTimeout(check, 500);
    }
    check();
  }

  // ── Message handler ──────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "READ_SITE_SUMMARY") {
      sendResponse(readSiteSummary());
      return false;
    }
    if (msg.type === "SWITCH_STATION") {
      const ok = switchToStore(msg.storeId);
      sendResponse({ ok });
      return false;
    }
    if (msg.type === "WAIT_FOR_STORE") {
      // Polls until dropdown shows the expected storeId or times out
      waitForStoreSwitch(msg.storeId, msg.timeoutMs || 15000, (matched) => {
        sendResponse({ matched, storeId: getStoreId() });
      });
      return true; // async
    }
    if (msg.type === "PING") {
      sendResponse({ alive: true, onSiteSummary: isOnSiteSummary() });
      return false;
    }
  });
})();
