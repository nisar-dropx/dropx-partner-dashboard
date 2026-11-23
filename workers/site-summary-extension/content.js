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

      // For "No Idle Associates" rows, there's no <a> — fall back to cell text
      const assocCell = tr.querySelector("td.associateId");
      const associateText = assocEl
        ? assocEl.textContent.trim()
        : (assocCell ? assocCell.textContent.trim() : "Unassigned");

      rows.push({
        oid:      oidEl    ? oidEl.textContent.trim()   : "—",
        items:    itemsEl  ? itemsEl.textContent.trim()  : "—",
        pct:      pctEl    ? pctEl.textContent.trim()    : "—",
        associate: associateText || "Unassigned",
        elapsedText,
        elapsedS,
        slaText,
        slaS,
        red: isRed(elapsedEl),
      });
    }
    return rows;
  }

  // Read the "Attention! You have N orders pending acceptance" banner count.
  // kat-alert renders its slot content as a direct text node child (light DOM),
  // so textContent works. Also try innerText as fallback.
  function readPendingAcceptanceCount() {
    for (const el of document.querySelectorAll("kat-alert")) {
      const text = (el.innerText || el.textContent || "").trim();
      const m = text.match(/you have (\d+) orders? pending acceptance/i);
      if (m) return parseInt(m[1], 10);
    }
    // Also check the slot content directly — text node children of kat-alert
    for (const el of document.querySelectorAll("kat-alert")) {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const m = node.textContent.match(/you have (\d+) orders? pending acceptance/i);
          if (m) return parseInt(m[1], 10);
        }
      }
    }
    return null;
  }

  function readSiteSummary() {
    const rows = readRows();
    const bannerCount = readPendingAcceptanceCount();
    return {
      storeId: getStoreId(),
      onSiteSummary: isOnSiteSummary(),
      rows,
      bannerPendingCount: bannerCount,
      readAt: Date.now(),
    };
  }

  // ── Station switcher ─────────────────────────────────────────────────────────
  // kat-option elements live inside kat-dropdown's shadow DOM. Content scripts
  // cannot pierce shadow roots with querySelector, but can access the listbox
  // slot's assignedElements() to get the actual kat-option nodes, then click them.

  function findKatOption(storeId) {
    const dd = document.querySelector('kat-dropdown[data-testid="site-selection"]');
    if (!dd || !dd.shadowRoot) return null;
    // The listbox slot inside the shadow root holds all kat-option elements
    const slot = dd.shadowRoot.querySelector('slot[role="listbox"]');
    if (!slot) return null;
    const nodes = slot.assignedElements ? slot.assignedElements({ flatten: true }) : slot.assignedNodes({ flatten: true });
    for (const node of nodes) {
      if (node.nodeType !== 1) continue; // skip text nodes
      if (node.getAttribute("value") === storeId) return node;
      // Options may be wrapped in a container — check children too
      const child = node.querySelector && node.querySelector(`[value="${storeId}"]`);
      if (child) return child;
    }
    return null;
  }

  function switchStation(storeId, timeoutMs, callback) {
    const start = Date.now();

    function attempt() {
      const dd = document.querySelector('kat-dropdown[data-testid="site-selection"]');
      if (!dd) {
        if (Date.now() - start > timeoutMs) { callback({ ok: false, reason: "no_dropdown" }); return; }
        setTimeout(attempt, 300);
        return;
      }
      if (dd.getAttribute("value") === storeId) { callback({ ok: true }); return; }

      const option = findKatOption(storeId);
      if (!option) {
        if (Date.now() - start > timeoutMs) { callback({ ok: false, reason: "no_option" }); return; }
        setTimeout(attempt, 300);
        return;
      }

      // Click the kat-option — Katal's handler fires → React onChange → store switches
      option.click();
      pollConfirm();
    }

    function pollConfirm() {
      const dd = document.querySelector('kat-dropdown[data-testid="site-selection"]');
      const current = dd ? dd.getAttribute("value") : null;
      if (current === storeId) { callback({ ok: true }); return; }
      if (Date.now() - start > timeoutMs) {
        // One final retry before giving up
        const opt = findKatOption(storeId);
        if (opt) opt.click();
        setTimeout(() => {
          const cur = document.querySelector('kat-dropdown[data-testid="site-selection"]')?.getAttribute("value");
          callback(cur === storeId ? { ok: true } : { ok: false, reason: "timeout" });
        }, 500);
        return;
      }
      setTimeout(pollConfirm, 300);
    }

    attempt();
  }

  function waitForStoreSwitch(storeId, timeoutMs, _snapshotOid, callback) {
    switchStation(storeId, timeoutMs, (r) => callback(r.ok));
  }

  // ── Message handler ──────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "READ_SITE_SUMMARY") {
      sendResponse(readSiteSummary());
      return false;
    }
    if (msg.type === "SWITCH_STATION") {
      switchStation(msg.storeId, 15000, (r) => sendResponse(r));
      return true; // async
    }
    if (msg.type === "WAIT_FOR_STORE") {
      waitForStoreSwitch(msg.storeId, msg.timeoutMs || 20000, msg.snapshotOid || null, (matched) => {
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
