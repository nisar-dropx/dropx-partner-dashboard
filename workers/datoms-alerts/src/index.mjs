import { DatomsClient } from "./datoms.mjs";
import { filterDatomsEvent, formatCaption } from "./filter.mjs";
import { renderAlertCardPng, renderAlertCardSvg } from "./card.mjs";
import { STATION_JIDS } from "./stations.mjs";

const POLL_WINDOW_MS = 3 * 60 * 1000;
const DEDUPE_TTL_SEC = 7 * 24 * 60 * 60;
const RECENT_PREFIX = "recent:";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra }
  });
}

function adminOk(req, env) {
  const key = env.ADMIN_KEY;
  if (!key) return false;
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${key}`) return true;
  return req.headers.get("x-admin-key") === key;
}

function sbHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !env.SUPABASE_URL) return null;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal"
  };
}

async function supabaseUpsertAlert(env, alert, meta) {
  const headers = sbHeaders(env);
  if (!headers) return;
  const row = {
    company_id: env.COMPANY_ID,
    dedupe_key: alert.dedupeKey,
    station_code: alert.station,
    entity_id: alert.entityId,
    generated_at: alert.generatedAt,
    rule_name: alert.rule,
    level: alert.level,
    title: alert.title,
    site_name: alert.siteName,
    asset_name: alert.asset,
    room_type: alert.roomType,
    alert_text: alert.alertText,
    caption: meta.caption,
    payload_json: alert.raw,
    notified_at: meta.notifiedAt,
    card_svg: meta.svg
  };
  const url = `${String(env.SUPABASE_URL).replace(/\/$/, "")}/rest/v1/ds_datoms_alerts?on_conflict=company_id,dedupe_key`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(row) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ds_datoms_alerts: ${res.status} ${body.slice(0, 300)}`);
  }
}

async function supabaseListAlerts(env, limit) {
  const headers = sbHeaders(env);
  if (!headers) return [];
  const base = String(env.SUPABASE_URL).replace(/\/$/, "");
  const qs = new URLSearchParams({
    company_id: `eq.${env.COMPANY_ID}`,
    select: "dedupe_key,station_code,level,title,generated_at,site_name,asset_name,room_type,alert_text,notified_at",
    order: "generated_at.desc",
    limit: String(limit)
  });
  const res = await fetch(`${base}/rest/v1/ds_datoms_alerts?${qs}`, { headers: { ...headers, Prefer: "return=representation" } });
  if (!res.ok) return [];
  return res.json();
}

async function kvListRecent(kv, limit) {
  const listed = await kv.list({ prefix: RECENT_PREFIX, limit: Math.min(limit, 100) });
  const items = [];
  for (const key of listed.keys.slice(0, limit)) {
    const raw = await kv.get(key.name, "json");
    if (raw) items.push(raw);
  }
  items.sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)));
  return items.slice(0, limit);
}

async function storeRecent(kv, alert, meta) {
  await kv.put(`${RECENT_PREFIX}${alert.dedupeKey}`, JSON.stringify({
    dedupe_key: alert.dedupeKey,
    station_code: alert.station,
    level: alert.level,
    title: alert.title,
    generated_at: alert.generatedAt,
    site_name: alert.siteName,
    asset_name: alert.asset,
    room_type: alert.roomType,
    alert_text: alert.alertText,
    notified_at: meta.notifiedAt
  }), { expirationTtl: DEDUPE_TTL_SEC });
}

async function sendWhatsApp(env, alert, pngBytes, caption) {
  const to = STATION_JIDS[alert.station];
  if (!to) throw new Error(`No JID for station ${alert.station}`);
  const base = String(env.REPORT_BOT_URL || "").replace(/\/$/, "");
  if (!base || !env.REPORT_BOT_TOKEN) throw new Error("REPORT_BOT_URL / REPORT_BOT_TOKEN not set");

  const image_base64 = Buffer.from(pngBytes).toString("base64");
  const res = await fetch(`${base}/send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.REPORT_BOT_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      client_ref: `datoms_${alert.dedupeKey}`.slice(0, 120),
      to,
      image_base64,
      mime: "image/png",
      caption
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Report bot send: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json().catch(() => ({ ok: true }));
}

export async function runPoll(env, { dryRun = false } = {}) {
  if (!env.DATOMS_EMAIL || !env.DATOMS_PASSWORD) {
    throw new Error("DATOMS_EMAIL / DATOMS_PASSWORD missing");
  }
  const client = new DatomsClient({
    email: env.DATOMS_EMAIL,
    password: env.DATOMS_PASSWORD,
    customerId: env.DATOMS_CUSTOMER_ID || "17428",
    applicationId: env.DATOMS_APPLICATION_ID || "16"
  });
  const now = Date.now();
  const generatedAfter = new Date(now - POLL_WINDOW_MS).toISOString();
  const generatedBefore = new Date(now).toISOString();
  const events = await client.fetchEvents({ generatedAfter, generatedBefore });

  const processed = [];
  const skipped = [];

  for (const event of events) {
    const alert = filterDatomsEvent(event);
    if (!alert) {
      skipped.push({ reason: "filter", id: event?.entity_id ?? event?.id });
      continue;
    }
    const dedupeHit = await env.ALERT_DEDUPE.get(alert.dedupeKey);
    if (dedupeHit) {
      skipped.push({ reason: "dedupe", key: alert.dedupeKey });
      continue;
    }

    const caption = formatCaption(alert);
    const svg = renderAlertCardSvg(alert);
    const pngBytes = renderAlertCardPng(alert);
    const notifiedAt = new Date().toISOString();

    if (dryRun) {
      processed.push({ alert, dryRun: true });
      continue;
    }

    // Send first so a WhatsApp failure does not permanently bury the alert in KV.
    await sendWhatsApp(env, alert, pngBytes, caption);
    await env.ALERT_DEDUPE.put(alert.dedupeKey, notifiedAt, { expirationTtl: DEDUPE_TTL_SEC });
    await storeRecent(env.ALERT_DEDUPE, alert, { notifiedAt });
    try {
      await supabaseUpsertAlert(env, alert, { caption, svg, notifiedAt });
    } catch (error) {
      console.error("[datoms-alerts] supabase upsert failed:", error?.message || error);
    }
    processed.push({
      dedupe_key: alert.dedupeKey,
      station: alert.station,
      level: alert.level,
      title: alert.title
    });
  }

  return {
    ok: true,
    window: { generatedAfter, generatedBefore },
    fetched: events.length,
    processed: processed.length,
    alerts: processed,
    skipped_count: skipped.length
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "dropx-datoms-alerts",
        has_kv: Boolean(env.ALERT_DEDUPE),
        has_supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
        has_report_bot: Boolean(env.REPORT_BOT_URL && env.REPORT_BOT_TOKEN)
      });
    }

    if (req.method === "GET" && url.pathname === "/alerts") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50) || 50, 200);
      let alerts = await kvListRecent(env.ALERT_DEDUPE, limit);
      if (!alerts.length) alerts = await supabaseListAlerts(env, limit);
      return json({ ok: true, count: alerts.length, alerts });
    }

    if (req.method === "POST" && url.pathname === "/run") {
      if (!adminOk(req, env)) return json({ error: "Unauthorized" }, 401);
      const dryRun = url.searchParams.get("dry_run") === "1";
      try {
        const result = await runPoll(env, { dryRun });
        return json(result);
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runPoll(env).catch((error) => {
        console.error("[datoms-alerts] scheduled poll failed:", error?.message || error);
      })
    );
  }
};