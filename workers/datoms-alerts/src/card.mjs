import { formatDisplayTime } from "./filter.mjs";

const W = 720;
const H = 520;
const CORAL = "#e36a4a";
const INK = "#1f2937";
const MUTED = "#6b7280";
const LINE = "#f0a58a";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapLines(text, maxChars) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return ["—"];
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 4);
}

/**
 * WhatsApp card matching the OpsPulse / Datoms detail layout:
 * title, timestamp, orange rule, then Site / Asset / Room Type / Alert.
 */
export function renderAlertCardSvg(alert) {
  const when = formatDisplayTime(alert.generatedAt);
  const site = String(alert.station || alert.siteName || "—").trim() || "—";
  const asset = String(alert.asset || "—").trim() || "—";
  const roomType = String(alert.roomType || "—").trim() || "—";
  const alertLines = wrapLines(alert.alertText || "—", 52);
  const alertBody = alertLines
    .map((line, i) => {
      const y = 330 + i * 28;
      if (i === 0) {
        return `<text x="360" y="${y}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="22">
    <tspan fill="${MUTED}">Alert : </tspan><tspan fill="${CORAL}" font-weight="700">${esc(line)}</tspan>
  </text>`;
      }
      return `<text x="360" y="${y}" text-anchor="middle" fill="${CORAL}" font-family="Arial,Helvetica,sans-serif" font-size="22" font-weight="700">${esc(line)}</text>`;
    })
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="360" y="78" text-anchor="middle" fill="${INK}" font-family="Arial,Helvetica,sans-serif" font-size="34" font-weight="700">${esc(alert.title || `${alert.level} Alert`)}</text>
  <text x="360" y="118" text-anchor="middle" fill="${MUTED}" font-family="Arial,Helvetica,sans-serif" font-size="20">${esc(when)}</text>
  <line x1="80" y1="148" x2="640" y2="148" stroke="${LINE}" stroke-width="3"/>
  <text x="360" y="200" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="22">
    <tspan fill="${MUTED}">Site : </tspan><tspan fill="${INK}" font-weight="700">${esc(site)}</tspan>
  </text>
  <text x="360" y="242" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="22">
    <tspan fill="${MUTED}">Asset : </tspan><tspan fill="${INK}" font-weight="700">${esc(asset)}</tspan>
  </text>
  <text x="360" y="284" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="22">
    <tspan fill="${MUTED}">Room Type : </tspan><tspan fill="${CORAL}" font-weight="700">${esc(roomType)}</tspan>
  </text>
  ${alertBody}
</svg>`;
}

/**
 * Rasterize the detail card for WhatsApp. Prefers Resvg/sharp (Vercel Node);
 * falls back only if native renderers are unavailable.
 */
export async function renderAlertCardPng(alert) {
  const svg = renderAlertCardSvg(alert);
  const svgBuffer = Buffer.from(svg);

  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: W } });
    return Buffer.from(resvg.render().asPng());
  } catch {
    /* try sharp next */
  }

  try {
    const sharp = (await import("sharp")).default;
    return await sharp(svgBuffer).png().toBuffer();
  } catch (error) {
    throw new Error(`Datoms alert card render failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
