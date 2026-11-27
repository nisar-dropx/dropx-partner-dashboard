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

export function parseDatomsEvent(event) {
  const level = extractLevel(event);
  if (!level) return null;

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

  const asset =
    String(
      details.station_name
        ?? details.asset_name
        ?? details.assetName
        ?? event.asset_name
        ?? ""
    ).trim() || "—";
  const roomType =
    String(
      details.rule?.rule_data?.thing_category
        ?? details.room_type
        ?? details.roomType
        ?? details.room_name
        ?? ""
    ).trim() || "—";
  const alertText =
    String(
      details.alert_message
        ?? details.violation_message
        ?? event.message
        ?? event.title
        ?? ""
    ).trim() || "—";

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

function buildTitle(event, level, alertText) {
  const details = event.details ?? {};
  const fromRule = String(
    details.rule_template_name ?? details.view_name ?? event.rule_template_name ?? event.view_name ?? ""
  ).trim();
  if (fromRule && LEVEL_RE.test(fromRule)) return `${fromRule.replace(/\s+/g, " ")} Alert`.replace(/ Alert Alert$/i, " Alert");
  if (/door\s*open/i.test(alertText)) return `Door Open ${level} Alert`;
  if (/temp/i.test(alertText)) return `Temperature ${level} Alert`;
  return `${level} Alert`;
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

/** Returns parsed alert or null if the event should be ignored. */
export function filterDatomsEvent(event) {
  if (!isViolationEvent(event)) return null;
  if (!messageHasLevel(event)) return null;
  return parseDatomsEvent(event);
}

export function formatCaption(alert, { timeZone = "Asia/Kolkata" } = {}) {
  const when = formatDisplayTime(alert.generatedAt, timeZone);
  return [
    `*${alert.title}*`,
    when,
    "",
    `Site: ${alert.siteName}`,
    `Asset: ${alert.asset}`,
    `Room Type: ${alert.roomType}`,
    `Alert: ${alert.alertText}`
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