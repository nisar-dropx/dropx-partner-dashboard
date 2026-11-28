import { ALLOWED_STATIONS, extractStationCode } from "./stations.mjs";

const LEVEL_RE = /\bL([123])\b/i;
const WA_LEVEL_RE = /\bL([23])\b/i;

export function isViolationEvent(event) {
  if (!event || typeof event !== "object") return false;
  const type = event.type ?? event.event_type;
  if (type === 0 || type === "0") return true;
  const tags = event.tags ?? event.tag_list ?? [];
  const tagArr = Array.isArray(tags) ? tags : String(tags).split(/[,;]/);
  return tagArr.some((t) => String(t).trim().toLowerCase() === "violation");
}

function ruleParts(event) {
  const details = event?.details ?? {};
  return [
    details.rule_template_name,
    details.view_name,
    event?.rule_template_name,
    event?.view_name,
    event?.message,
    event?.title,
    details.rule_name,
    details.message,
    details.alert_message,
    details.violation_message
  ];
}

/** True when any L1/L2/L3 marker is present (OpsPulse stores all three). */
export function messageHasLevel(event) {
  return ruleParts(event).some((p) => LEVEL_RE.test(String(p ?? "")));
}

/** @deprecated Prefer messageHasLevel — kept for existing tests/imports. */
export function messageHasL2L3(event) {
  return ruleParts(event).some((p) => WA_LEVEL_RE.test(String(p ?? "")));
}

export function isWhatsAppLevel(level) {
  return level === "L2" || level === "L3";
}

export function extractLevel(event) {
  for (const p of ruleParts(event)) {
    const m = String(p ?? "").match(LEVEL_RE);
    if (m) return `L${m[1]}`;
  }
  return null;
}

/** Non-L Datoms notifications (cycle end, DG off, etc.) still land in Alerts as L1 info. */
export function extractLevelOrInfo(event) {
  return extractLevel(event) || "L1";
}

export function parseDatomsEvent(event) {
  const level = extractLevelOrInfo(event);

  const details = event.details ?? {};
  const siteName =
    String(details.site_name ?? details.siteName ?? event.site_name ?? "").trim()
    || null;
  const station =
    extractStationCode(
      siteName,
      details.station_name,
      event.station_name,
      event.message,
      details.message
    );

  if (!station || !ALLOWED_STATIONS.has(station)) return null;

  const rawAlertText =
    String(
      details.alert_message
        ?? details.violation_message
        ?? event.message
        ?? event.title
        ?? ""
    ).trim();
  const parsed = splitAssetAlertMessage(rawAlertText);

  const asset =
    String(
      details.station_name
        ?? details.asset_name
        ?? details.assetName
        ?? event.asset_name
        ?? parsed.asset
        ?? ""
    ).trim() || "—";
  const roomType =
    String(
      details.rule?.rule_data?.thing_category
        ?? details.room_type
        ?? details.roomType
        ?? details.room_name
        ?? parsed.roomType
        ?? ""
    ).trim() || "—";
  const alertText = String(parsed.alertText || rawAlertText || "—").trim() || "—";

  const rule =
    String(
      details.rule_template_name
        ?? details.view_name
        ?? event.rule_template_name
        ?? event.view_name
        ?? details.rule_name
        ?? level
    ).trim();

  const title = buildTitle(event, level, alertText);
  const generatedAt = normalizeIso(event.generated_at ?? event.generatedAt ?? event.created_at);
  const entityId = String(event.entity_id ?? event.entityId ?? event.id ?? "").trim() || "unknown";

  return {
    entityId,
    generatedAt,
    rule,
    level,
    station,
    siteName: siteName || station,
    asset,
    roomType,
    alertText,
    title,
    dedupeKey: `${entityId}:${generatedAt}:${rule}`,
    raw: event
  };
}

/**
 * Datoms often packs "TTA5 Freezer room w/DS : Door Open L2 for more than 20 Minutes".
 * Pull asset / room / short alert text from that pattern when structured fields are blank.
 */
export function splitAssetAlertMessage(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { asset: null, roomType: null, alertText: null };
  const m = text.match(/^(.+?)\s*:\s*(.+)$/);
  if (!m) return { asset: null, roomType: null, alertText: text };
  const asset = m[1].trim();
  let alertText = m[2].trim();
  // Card copy prefers "Door open for more than 30 Minutes" over repeating the L-level.
  alertText = alertText
    .replace(/\b(Door Open|Temperature Greater Than Threshold)\s+L[123]\b/gi, (_, kind) => kind)
    .replace(/\s+/g, " ")
    .trim();
  return { asset, roomType: inferRoomType(asset), alertText };
}

function inferRoomType(asset) {
  const text = String(asset ?? "");
  const m = text.match(/\b(chiller|freezer|cold|ambient|dry)\s*rooms?\b/i);
  if (!m) return null;
  return m[0]
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function buildTitle(event, level, alertText) {
  const details = event.details ?? {};
  const fromRule = String(
    details.rule_template_name ?? details.view_name ?? event.rule_template_name ?? event.view_name ?? ""
  ).trim();
  if (fromRule) {
    const cleaned = fromRule.replace(/\s+/g, " ").replace(/ Alert$/i, "");
    return LEVEL_RE.test(cleaned) ? `${cleaned} Alert` : cleaned;
  }
  if (/door\s*open/i.test(alertText)) return `Door Open ${level} Alert`;
  if (/temp/i.test(alertText)) return `Temperature ${level} Alert`;
  const short = String(alertText || "").replace(/\s+/g, " ").trim().slice(0, 72);
  return short || `${level} Alert`;
}

function normalizeIso(value) {
  if (value == null || value === "") return new Date().toISOString();
  if (typeof value === "number") {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Returns parsed alert or null if the event should be ignored.
 * Stores every Datoms Violation notification for allowlisted stations
 * (L1/L2/L3 plus cycle/DG/info notifications mapped to L1).
 */
export function filterDatomsEvent(event) {
  if (!isViolationEvent(event)) return null;
  return parseDatomsEvent(event);
}

export function formatCaption(alert, { timeZone = "Asia/Kolkata" } = {}) {
  const when = formatDisplayTime(alert.generatedAt, timeZone);
  const site = alert.station || alert.siteName || "—";
  return [
    `*${alert.title}*`,
    when,
    "",
    `Site: ${site}`,
    `Asset: ${alert.asset || "—"}`,
    `Room Type: ${alert.roomType || "—"}`,
    `Alert: ${alert.alertText || "—"}`
  ].join("\n");
}

export function formatDisplayTime(iso, timeZone = "Asia/Kolkata") {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d).replace(",", ",");
}