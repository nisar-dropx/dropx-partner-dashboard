import { PNG } from "pngjs/browser.js";
import { formatDisplayTime } from "./filter.mjs";

const W = 720;
const H = 400;
const ORANGE = { r: 234, g: 88, b: 12 };
const WHITE = { r: 255, g: 255, b: 255 };
const RED = { r: 185, g: 28, b: 28 };
const SLATE = { r: 51, g: 65, b: 85 };

/** 5×7 pixel font for banner station code + level (A–Z, 0–9). */
const GLYPHS = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  "2": [0x1e, 0x01, 0x01, 0x1e, 0x10, 0x10, 0x1f],
  "3": [0x1e, 0x01, 0x01, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0e],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  "5": [0x1f, 0x10, 0x10, 0x1e, 0x01, 0x01, 0x1e]
};

export function renderAlertCardSvg(alert) {
  const when = formatDisplayTime(alert.generatedAt);
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="520" viewBox="0 0 720 520">
  <rect width="720" height="72" fill="#ea580c"/>
  <text x="24" y="48" fill="#fff" font-family="Arial,Helvetica,sans-serif" font-size="28" font-weight="700">DATOMS</text>
  <rect y="72" width="720" height="448" fill="#ffffff"/>
  <text x="24" y="120" fill="#0f172a" font-family="Arial,Helvetica,sans-serif" font-size="22" font-weight="700">${esc(alert.title)}</text>
  <text x="24" y="152" fill="#64748b" font-family="Arial,Helvetica,sans-serif" font-size="15">${esc(when)}</text>
  <text x="24" y="200" fill="#dc2626" font-family="Arial,Helvetica,sans-serif" font-size="16"><tspan font-weight="600">Site:</tspan> ${esc(alert.siteName)}</text>
  <text x="24" y="232" fill="#dc2626" font-family="Arial,Helvetica,sans-serif" font-size="16"><tspan font-weight="600">Asset:</tspan> ${esc(alert.asset)}</text>
  <text x="24" y="264" fill="#dc2626" font-family="Arial,Helvetica,sans-serif" font-size="16"><tspan font-weight="600">Room Type:</tspan> ${esc(alert.roomType)}</text>
  <text x="24" y="308" fill="#dc2626" font-family="Arial,Helvetica,sans-serif" font-size="16"><tspan font-weight="600">Alert:</tspan> ${esc(alert.alertText)}</text>
  <rect x="560" y="92" width="136" height="136" rx="12" fill="${alert.level === "L3" ? "#7f1d1d" : "#ea580c"}"/>
  <text x="628" y="178" text-anchor="middle" fill="#fff" font-family="Arial,Helvetica,sans-serif" font-size="52" font-weight="700">${esc(alert.level)}</text>
</svg>`;
}

/**
 * Branded banner for WhatsApp: orange header, large level badge, station code.
 * Full alert copy lives in the message caption.
 */
export function renderAlertCardPng(alert) {
  const png = new PNG({ width: W, height: H, filterType: -1 });
  fill(png, WHITE);
  fillRect(png, 0, 0, W, 64, ORANGE);

  const badgeColor = alert.level === "L3" ? { r: 127, g: 29, b: 29 } : ORANGE;
  fillRect(png, 520, 90, 160, 160, badgeColor);
  drawText(png, alert.level, 545, 115, WHITE, 5);

  drawText(png, alert.station, 48, 120, SLATE, 6);
  drawText(png, "DATOMS", 48, 24, WHITE, 4);

  fillRect(png, 48, 200, W - 96, 3, { r: 226, g: 232, b: 240 });
  drawText(png, alert.level, 48, 240, badgeColor, 8);

  const chunks = PNG.sync.write(png);
  return Buffer.from(chunks);
}

function fill(png, color) {
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      setPx(png, x, y, color);
    }
  }
}

function fillRect(png, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h && y < png.height; y++) {
    for (let x = x0; x < x0 + w && x < png.width; x++) {
      if (x >= 0 && y >= 0) setPx(png, x, y, color);
    }
  }
}

function setPx(png, x, y, { r, g, b }) {
  const i = (png.width * y + x) << 2;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = 255;
}

function drawText(png, text, x, y, color, scale) {
  let cx = x;
  for (const ch of String(text).toUpperCase()) {
    const rows = GLYPHS[ch] || GLYPHS[" "];
    for (let row = 0; row < rows.length; row++) {
      const bits = rows[row];
      for (let col = 0; col < 5; col++) {
        if (bits & (1 << (4 - col))) {
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              setPx(png, cx + col * scale + sx, y + row * scale + sy, color);
            }
          }
        }
      }
    }
    cx += 6 * scale;
  }
}