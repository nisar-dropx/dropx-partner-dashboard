import { DatomsClient, DATOMS_OPS_ALERT_JID } from "./datoms.mjs";
import { filterDatomsEvent, formatCaption, isWhatsAppLevel } from "./filter.mjs";
import { renderAlertCardPng, renderAlertCardSvg } from "./card.mjs";
import { STATION_JIDS } from "./stations.mjs";
import { clientRefForAlert } from "./client-ref.mjs";
import { mergeThingRows, normalizeThing } from "./things.mjs";
import {
  datomsLevelMessageType,
  decideDsMessageSend,
  fallbackDsMessagePolicy,
  fetchDsMessagePolicy,
  fetchLastDsMessageSentAt,
  recordDsMessageSendRest
} from "../../ds-message-policy-rest.mjs";

/** Overlap the every-10-minute cron so a slow/failed tick still catches events. */
const POLL_WINDOW_MS = 15 * 60 * 1000;
/** After an outage, catch up once (capped) so historical L1–L3 are not lost forever. */
const CATCHUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Plaintext Datoms password. Prefer DATOMS_PASSWORD_NEW, then DATOMS_PASSWORD; DATOMS_PASSWORD_HASH is a misnamed alias (not a hash). */
function datomsPassword(env) {
  return String(env.DATOMS_PASSWORD_NEW || env.DATOMS_PASSWORD || env.DATOMS_PASSWORD_HASH || "").trim();
}

function datomsEmail(env) {
  return String(env.DATOMS_EMAIL || env.DATOMS_ID || "").trim();
}

export function makeDatomsClient(env, { allowLogin } = {}) {
  const password = datomsPassword(env);
  const email = datomsEmail(env);
  if (!email || !password) {
    throw new Error("DATOMS_EMAIL / DATOMS_PASSWORD missing (plaintext; DATOMS_PASSWORD_NEW / DATOMS_PASSWORD_HASH aliases accepted)");
  }
  const supabaseUrl = env.SUPABASE_URL || env.COMPANY_SUPABASE_URL || "";
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || "";
  const envAllow = String(env.DATOMS_ALLOW_LOGIN ?? "1").trim() !== "0";
  return new DatomsClient({
    email,
    password,
    customerId: env.DATOMS_CUSTOMER_ID || "17428",
    applicationId: env.DATOMS_APPLICATION_ID || "16",
    companyId: env.COMPANY_ID || "43866344-b550-4e8a-9a2d-9d23f3d8a997",
    allowLogin: allowLogin === false ? false : envAllow,
    kv: env.ALERT_DEDUPE ?? null,
    supabase: supabaseUrl && supabaseKey ? { url: supabaseUrl, serviceKey: supabaseKey } : null
  });
}
const DEDUPE_TTL_SEC = 7 * 24 * 60 * 60;
const RECENT_PREFIX = "recent:";

/** In-process KV stand-in when Cloudflare KV is unavailable (Vercel cron). */
function createMemoryKv() {
  const map = new Map();
  return {
    async get(key, type) {
      const value = map.get(key);
      if (value == null) return null;
      if (type === "json") {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value;
    },
    async put(key, value) {
      map.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list({ prefix = "", limit = 100 } = {}) {
      const keys = [...map.keys()]
        .filter((name) => name.startsWith(prefix))
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys };
    }
  };
}

/** Existing alert row, or null. L2/L3 with notified_at null are not "done" — WA may still be due. */
async function supabaseAlertState(env, dedupeKey) {
  const headers = sbHeaders(env);
  if (!headers || !env.COMPANY_ID) return null;
  const qs = new URLSearchParams({
    company_id: `eq.${env.COMPANY_ID}`,
    dedupe_key: `eq.${dedupeKey}`,
    select: "dedupe_key,level,notified_at,station_code,title,site_name,asset_name,room_type,alert_text,generated_at,rule_name",
    limit: "1"
  });
  const res = await fetch(
    `${String(env.SUPABASE_URL || env.COMPANY_SUPABASE_URL || "").replace(/\/$/, "")}/rest/v1/ds_datoms_alerts?${qs}`,
    { headers: { ...headers, Prefer: "return=representation" } }
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function alertFullyHandled(state) {
  if (!state) return false;
  if (state.notified_at) return true;
  // L1 (and other non-WA levels) only need to be stored once.
  return !isWhatsAppLevel(state.level);
}

/** L2/L3 rows that were saved for the hub but never reached the war room. */
async function supabasePendingWhatsAppAlerts(env, limit = 40) {
  const headers = sbHeaders(env);
  if (!headers || !env.COMPANY_ID) return [];
  const qs = new URLSearchParams({
    company_id: `eq.${env.COMPANY_ID}`,
    level: "in.(L2,L3)",
    notified_at: "is.null",
    select: "dedupe_key,level,station_code,title,site_name,asset_name,room_type,alert_text,generated_at,rule_name",
    order: "generated_at.asc",
    limit: String(limit)
  });
  const res = await fetch(
    `${String(env.SUPABASE_URL || env.COMPANY_SUPABASE_URL || "").replace(/\/$/, "")}/rest/v1/ds_datoms_alerts?${qs}`,
    { headers: { ...headers, Prefer: "return=representation" } }
  );
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

function alertFromStoredRow(row) {
  return {
    dedupeKey: row.dedupe_key,
    level: row.level,
    station: row.station_code,
    title: row.title || row.rule_name || `${row.level} Alert`,
    siteName: row.site_name || row.station_code || "—",
    asset: row.asset_name || "—",
    roomType: row.room_type || "—",
    alertText: row.alert_text || "—",
    generatedAt: row.generated_at,
    rule: row.rule_name || row.level
  };
}

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
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY;
  const url = env.SUPABASE_URL || env.COMPANY_SUPABASE_URL;
  if (!key || !url) return null;
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
    caption: meta.caption ?? null,
    payload_json: alert.raw,
    notified_at: meta.notifiedAt ?? null,
    card_svg: meta.svg ?? null
  };
  const base = String(env.SUPABASE_URL || env.COMPANY_SUPABASE_URL).replace(/\/$/, "");
  const url = `${base}/rest/v1/ds_datoms_alerts?on_conflict=company_id,dedupe_key`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(row) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ds_datoms_alerts: ${res.status} ${body.slice(0, 300)}`);
  }
}

async function supabaseMarkAlertNotified(env, dedupeKey, notifiedAt, { caption, svg } = {}) {
  const headers = sbHeaders(env);
  if (!headers || !env.COMPANY_ID) return;
  const base = String(env.SUPABASE_URL || env.COMPANY_SUPABASE_URL).replace(/\/$/, "");
  const qs = new URLSearchParams({
    company_id: `eq.${env.COMPANY_ID}`,
    dedupe_key: `eq.${dedupeKey}`
  });
  const patch = { notified_at: notifiedAt };
  if (caption != null) patch.caption = caption;
  if (svg != null) patch.card_svg = svg;
  await fetch(`${base}/rest/v1/ds_datoms_alerts?${qs}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(patch)
  }).catch(() => null);
}

async function readLastEventsPollAt(env) {
  const headers = sbHeaders(env);
  if (!headers || !env.COMPANY_ID) return 0;
  const base = String(env.SUPABASE_URL || env.COMPANY_SUPABASE_URL).replace(/\/$/, "");
  const qs = new URLSearchParams({
    company_id: `eq.${env.COMPANY_ID}`,
    select: "last_events_poll_at",
    limit: "1"
  });
  const res = await fetch(`${base}/rest/v1/ds_datoms_session?${qs}`, {
    headers: { ...headers, Prefer: "return=representation" }
  });
  if (!res.ok) return 0;
  const rows = await res.json().catch(() => []);
  const iso = rows?.[0]?.last_events_poll_at;
  const ms = iso ? Date.parse(iso) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

async function writeLastEventsPollAt(env, iso) {
  const headers = sbHeaders(env);
  if (!headers || !env.COMPANY_ID) return;
  const base = String(env.SUPABASE_URL || env.COMPANY_SUPABASE_URL).replace(/\/$/, "");
  const qs = new URLSearchParams({ company_id: `eq.${env.COMPANY_ID}` });
  await fetch(`${base}/rest/v1/ds_datoms_session?${qs}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ last_events_poll_at: iso, updated_at: iso })
  }).catch(() => null);
}

function resolvePollWindow(nowMs, lastPollMs, { catchUp = false } = {}) {
  let windowMs = POLL_WINDOW_MS;
  if (catchUp || !lastPollMs || nowMs - lastPollMs > POLL_WINDOW_MS) {
    const gap = catchUp
      ? CATCHUP_WINDOW_MS
      : lastPollMs
        ? nowMs - lastPollMs
        : CATCHUP_WINDOW_MS;
    windowMs = Math.min(Math.max(gap, POLL_WINDOW_MS), CATCHUP_WINDOW_MS);
  }
  return {
    generatedAfter: new Date(nowMs - windowMs).toISOString(),
    generatedBefore: new Date(nowMs).toISOString(),
    windowMs
  };
}

async function supabaseListAlerts(env, limit) {
  const headers = sbHeaders(env);
  if (!headers) return [];
  const base = String(env.SUPABASE_URL || env.COMPANY_SUPABASE_URL).replace(/\/$/, "");
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
  const client_ref = await clientRefForAlert(alert.dedupeKey);
  const res = await fetch(`${base}/send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.REPORT_BOT_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      client_ref,
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

/**
 * Policy + Report Bot delivery for one L2/L3 alert.
 * Returns { sent:true } | { sent:false, reason } | throws on hard send failure.
 */
async function tryNotifyWhatsApp(env, alert, { caption, svg } = {}) {
  if (!isWhatsAppLevel(alert.level)) {
    return { sent: false, reason: "l1_no_whatsapp" };
  }
  const companyId = env.COMPANY_ID || "43866344-b550-4e8a-9a2d-9d23f3d8a997";
  const sbUrl = env.SUPABASE_URL || env.COMPANY_SUPABASE_URL || "";
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || "";
  const messageType = datomsLevelMessageType(alert.level) ?? "datoms_l2";
  let policy = fallbackDsMessagePolicy(messageType);
  const fromDb = await fetchDsMessagePolicy({ url: sbUrl, key: sbKey, companyId, messageType });
  if (fromDb) policy = fromDb;
  let lastSent = null;
  if (sbKey) {
    lastSent = await fetchLastDsMessageSentAt({
      url: sbUrl,
      key: sbKey,
      companyId,
      messageType,
      stationCode: alert.station
    });
  }
  const decision = decideDsMessageSend({ policy, lastSentAtMs: lastSent });
  if (!decision.allowSend) {
    return { sent: false, reason: decision.reason };
  }
  const resolvedCaption = caption ?? formatCaption(alert);
  const resolvedSvg = svg ?? renderAlertCardSvg(alert);
  const pngBytes = renderAlertCardPng(alert);
  const notifiedAt = new Date().toISOString();
  await sendWhatsApp(env, alert, pngBytes, resolvedCaption);
  await supabaseMarkAlertNotified(env, alert.dedupeKey, notifiedAt, {
    caption: resolvedCaption,
    svg: resolvedSvg
  });
  await recordDsMessageSendRest({
    url: sbUrl,
    key: sbKey,
    companyId,
    messageType,
    stationCode: alert.station,
    policyVersion: policy.version,
    dedupeKey: alert.dedupeKey,
    meta: { level: alert.level, title: alert.title }
  });
  return { sent: true, notifiedAt, caption: resolvedCaption, svg: resolvedSvg };
}

/** Text-only ops alert to the allowlisted direct JID — never retries Datoms login. */
async function sendOpsAuthAlert(env, { reason, failCount }) {
  const base = String(env.REPORT_BOT_URL || "").replace(/\/$/, "");
  if (!base || !env.REPORT_BOT_TOKEN) {
    console.error("[datoms-alerts] ops alert skipped: REPORT_BOT_URL / TOKEN missing");
    return { sent: false, error: "report_bot_not_configured" };
  }
  const to = String(env.DATOMS_OPS_ALERT_JID || DATOMS_OPS_ALERT_JID).trim();
  const text = [
    "*Datoms auth alert*",
    `Failures: ${failCount}`,
    "Login attempts stopped to avoid another rate-limit lock.",
    "Session keep-alive will continue if a stored token exists; otherwise wait for the backoff window.",
    "",
    `Detail: ${String(reason || "").slice(0, 400)}`
  ].join("\n");
  const client_ref = await clientRefForAlert(`ops-auth-${Date.now()}-${failCount}`);
  const res = await fetch(`${base}/send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.REPORT_BOT_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ client_ref, to, text })
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("[datoms-alerts] ops WhatsApp alert failed:", res.status, body.slice(0, 200));
    return { sent: false, error: body.slice(0, 200) };
  }
  return { sent: true, to };
}

function isAuthRelatedFailure(message) {
  return /login|auth|session|unauthorized|401|403|429|rate\s*limit|too\s*many|backoff|no_stored_session|DATOMS_EMAIL|password/i
    .test(String(message ?? ""));
}

async function handleAuthFailure(env, client, error) {
  const message = error instanceof Error ? error.message : String(error);
  let failure = error?.datomsFailure || null;
  if (!failure && isAuthRelatedFailure(message)) {
    failure = await client.recordAuthFailure(message).catch(() => ({
      count: 0,
      tripped: false,
      shouldAlert: false,
      reason: message
    }));
  }
  let opsAlert = null;
  if (failure?.shouldAlert) {
    opsAlert = await sendOpsAuthAlert(env, {
      reason: failure.reason || message,
      failCount: failure.count
    });
    if (opsAlert?.sent) await client.markOpsAlerted().catch(() => null);
  }
  return { message, failure, opsAlert };
}

/** Keep the stored Datoms session warm — never logs in. */
export async function runKeepAlive(env) {
  const client = makeDatomsClient(env, { allowLogin: false });
  const result = await client.keepAlive();
  if (result?.kept_alive) return result;
  if (result?.reason && result.reason !== "no_stored_session") {
    const handled = await handleAuthFailure(env, client, new Error(result.reason));
    return { ...result, ...handled };
  }
  return result;
}

export async function runPoll(env, { dryRun = false, allowLogin, catchUp = false } = {}) {
  const client = makeDatomsClient(env, { allowLogin });
  const kv = env.ALERT_DEDUPE || createMemoryKv();
  const now = Date.now();
  const lastPollMs = await readLastEventsPollAt(env);
  const { generatedAfter, generatedBefore, windowMs } = resolvePollWindow(now, lastPollMs, { catchUp });
  let events;
  try {
    events = await client.fetchEvents({ generatedAfter, generatedBefore });
  } catch (error) {
    const handled = await handleAuthFailure(env, client, error);
    const session = await client.sessionStatus().catch(() => null);
    // Soft-fail — do not escalate into more logins.
    return {
      ok: false,
      skipped_login: true,
      error: handled.message,
      failure: handled.failure,
      ops_alert: handled.opsAlert,
      session,
      window: { generatedAfter, generatedBefore, windowMs },
      fetched: 0,
      processed: 0,
      stored: 0,
      notified: 0,
      alerts: [],
      skipped_count: 0,
      errors: [{ error: handled.message }]
    };
  }

  const processed = [];
  const skipped = [];
  const errors = [];
  let stored = 0;
  let notified = 0;
  let waRetried = 0;

  // Hub store-first used to mark L2/L3 as "done" before WA succeeded. Drain those.
  if (!dryRun) {
    const pending = await supabasePendingWhatsAppAlerts(env);
    for (const row of pending) {
      const alert = alertFromStoredRow(row);
      const kvHit = await kv.get(alert.dedupeKey);
      if (kvHit && String(kvHit) !== "stored") {
        skipped.push({ reason: "dedupe", key: alert.dedupeKey });
        continue;
      }
      try {
        const result = await tryNotifyWhatsApp(env, alert);
        if (!result.sent) {
          skipped.push({ reason: result.reason || "wa_pending", key: alert.dedupeKey, station: alert.station });
          continue;
        }
        await kv.put(alert.dedupeKey, result.notifiedAt, { expirationTtl: DEDUPE_TTL_SEC });
        await storeRecent(kv, alert, { notifiedAt: result.notifiedAt });
        notified += 1;
        waRetried += 1;
        processed.push({
          dedupe_key: alert.dedupeKey,
          station: alert.station,
          level: alert.level,
          title: alert.title,
          retry: true
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[datoms-alerts] pending WA retry failed:", alert.dedupeKey, message);
        errors.push({ dedupe_key: alert.dedupeKey, station: alert.station, error: message });
      }
    }
  }

  for (const event of events) {
    const alert = filterDatomsEvent(event);
    if (!alert) {
      skipped.push({ reason: "filter", id: event?.entity_id ?? event?.id });
      continue;
    }
    const existing = await supabaseAlertState(env, alert.dedupeKey);
    const kvHit = await kv.get(alert.dedupeKey);
    if ((kvHit && String(kvHit) !== "stored") || alertFullyHandled(existing)) {
      skipped.push({ reason: "dedupe", key: alert.dedupeKey });
      continue;
    }

    const caption = formatCaption(alert);
    const svg = renderAlertCardSvg(alert);

    if (dryRun) {
      processed.push({ alert, dryRun: true });
      continue;
    }

    const alreadyStored = Boolean(existing);
    if (!alreadyStored) {
      // Persist first so OpsPulse shows the alert even when WA is muted/failed.
      // Do not KV-dedupe yet for L2/L3 — a failed send must be retryable next poll.
      try {
        await supabaseUpsertAlert(env, alert, { caption, svg, notifiedAt: null });
        stored += 1;
        await storeRecent(kv, alert, { notifiedAt: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[datoms-alerts] supabase upsert failed:", alert.dedupeKey, message);
        errors.push({ dedupe_key: alert.dedupeKey, station: alert.station, error: message });
        continue;
      }
    }

    processed.push({
      dedupe_key: alert.dedupeKey,
      station: alert.station,
      level: alert.level,
      title: alert.title
    });

    if (!isWhatsAppLevel(alert.level)) {
      await kv.put(alert.dedupeKey, "l1", { expirationTtl: DEDUPE_TTL_SEC });
      skipped.push({ reason: "l1_no_whatsapp", key: alert.dedupeKey, station: alert.station });
      continue;
    }

    try {
      const result = await tryNotifyWhatsApp(env, alert, { caption, svg });
      if (!result.sent) {
        skipped.push({ reason: result.reason || "wa_pending", key: alert.dedupeKey, station: alert.station });
        continue;
      }
      await kv.put(alert.dedupeKey, result.notifiedAt, { expirationTtl: DEDUPE_TTL_SEC });
      await storeRecent(kv, alert, { notifiedAt: result.notifiedAt });
      notified += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[datoms-alerts] alert send failed:", alert.dedupeKey, message);
      errors.push({ dedupe_key: alert.dedupeKey, station: alert.station, error: message });
    }
  }

  const pollAt = new Date(now).toISOString();
  if (!dryRun) await writeLastEventsPollAt(env, pollAt);

  return {
    ok: true,
    window: { generatedAfter, generatedBefore, windowMs },
    fetched: events.length,
    processed: processed.length,
    stored,
    notified,
    wa_retried: waRetried,
    alerts: processed,
    skipped_count: skipped.length,
    errors
  };
}

async function writeSessionPollStamp(env, column, iso) {
  const headers = sbHeaders(env);
  if (!headers || !env.COMPANY_ID) return;
  const base = String(env.SUPABASE_URL || env.COMPANY_SUPABASE_URL).replace(/\/$/, "");
  const qs = new URLSearchParams({ company_id: `eq.${env.COMPANY_ID}` });
  await fetch(`${base}/rest/v1/ds_datoms_session?${qs}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ [column]: iso, updated_at: iso })
  }).catch(() => null);
}

async function upsertThingSnapshot(env, thing, observedAt) {
  const headers = sbHeaders(env);
  if (!headers || !env.COMPANY_ID) return;
  const base = String(env.SUPABASE_URL || env.COMPANY_SUPABASE_URL).replace(/\/$/, "");
  const row = {
    company_id: env.COMPANY_ID,
    thing_id: thing.thingId,
    station_code: thing.stationCode,
    name: thing.name,
    category: thing.category,
    site_name: thing.siteName,
    online: thing.status?.online ?? null,
    metrics_json: thing.metrics || {},
    status_json: thing.status || {},
    raw_json: thing.raw || {},
    observed_at: observedAt,
    updated_at: observedAt
  };
  const res = await fetch(`${base}/rest/v1/ds_datoms_things_snapshot?on_conflict=company_id,thing_id`, {
    method: "POST",
    headers,
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ds_datoms_things_snapshot: ${res.status} ${body.slice(0, 200)}`);
  }
}

/** Snapshot Panel/List assets — session reuse only by default. */
export async function runThingsSnapshot(env, { allowLogin = false } = {}) {
  const client = makeDatomsClient(env, { allowLogin });
  const observedAt = new Date().toISOString();
  let list = [];
  let data = [];
  const fetchErrors = [];
  try {
    list = await client.fetchThingsList();
  } catch (error) {
    const handled = await handleAuthFailure(env, client, error);
    return {
      ok: false,
      error: handled.message,
      failure: handled.failure,
      ops_alert: handled.opsAlert,
      upserted: 0
    };
  }
  // Enrich with latest raw readings when list params are sparse. List already
  // carries parameters[] for most assets — keep cards if things/data fails.
  // Datoms caps raw things/data at 15 thing ids per request.
  try {
    const thingIds = [
      ...new Set(
        list
          .map((row) => Number(row?.id ?? row?.thing_id))
          .filter((id) => Number.isFinite(id))
      )
    ];
    const chunks = [];
    for (let i = 0; i < thingIds.length; i += 15) chunks.push(thingIds.slice(i, i + 15));
    for (const chunk of chunks) {
      try {
        const rows = await client.fetchThingsData({ thingIds: chunk });
        data.push(...rows);
      } catch (error) {
        fetchErrors.push({
          kind: "things_data",
          error: error instanceof Error ? error.message : String(error),
          chunk_size: chunk.length
        });
      }
    }
  } catch (error) {
    fetchErrors.push({
      kind: "things_data",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const merged = mergeThingRows(list, data);
  let upserted = 0;
  const skipped = [];
  const errors = [...fetchErrors];
  for (const row of merged) {
    const thing = normalizeThing(row);
    if (!thing) {
      skipped.push({ reason: "filter", id: row?.id ?? row?.thing_id });
      continue;
    }
    try {
      await upsertThingSnapshot(env, thing, observedAt);
      upserted += 1;
    } catch (error) {
      errors.push({
        thing_id: thing.thingId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  await writeSessionPollStamp(env, "last_things_poll_at", observedAt);
  return {
    ok: true,
    listed: list.length,
    data_rows: data.length,
    merged: merged.length,
    upserted,
    skipped_count: skipped.length,
    errors,
    observed_at: observedAt
  };
}

async function upsertReportCache(env, { reportKey, stationCode, title, kind, payload }, observedAt) {
  const headers = sbHeaders(env);
  if (!headers || !env.COMPANY_ID) return;
  const base = String(env.SUPABASE_URL || env.COMPANY_SUPABASE_URL).replace(/\/$/, "");
  const row = {
    company_id: env.COMPANY_ID,
    report_key: reportKey,
    station_code: stationCode || null,
    title: title || reportKey,
    kind: kind || "table",
    payload_json: payload || {},
    observed_at: observedAt,
    updated_at: observedAt
  };
  const res = await fetch(`${base}/rest/v1/ds_datoms_report_cache?on_conflict=company_id,report_key`, {
    method: "POST",
    headers,
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ds_datoms_report_cache: ${res.status} ${body.slice(0, 200)}`);
  }
}

/** Cache gravity table/graph summaries for Reports tab — session reuse only. */
export async function runReportsSnapshot(env, { allowLogin = false } = {}) {
  const client = makeDatomsClient(env, { allowLogin });
  const observedAt = new Date().toISOString();
  const errors = [];
  let stored = 0;
  let thingIds = [];
  try {
    const list = await client.fetchThingsList();
    thingIds = [
      ...new Set(
        list
          .map((row) => {
            const thing = normalizeThing(row);
            return thing ? Number(thing.thingId) : NaN;
          })
          .filter((id) => Number.isFinite(id))
      )
    ].slice(0, 24);
  } catch (error) {
    const handled = await handleAuthFailure(env, client, error);
    return {
      ok: false,
      error: handled.message,
      failure: handled.failure,
      ops_alert: handled.opsAlert,
      stored: 0
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const from = now - 24 * 3600;
  const tableBody = {
    columns: [
      { dataIndex: "start_time_seconds", colPathExp: "start_time" },
      { dataIndex: "end_time_seconds", colPathExp: "end_time" }
    ],
    apiType: "sessions",
    timezone: "Asia/Calcutta",
    apiConfig: {
      api_query: {
        page: 1,
        limit: 25,
        sort_by: "",
        filter: {
          start_time: { between: [from, now] },
          "asset::status.active": { eq: 1 }
        }
      }
    }
  };
  const graphBody = thingIds.length
    ? {
        series: [
          {
            data: [],
            unit: true,
            api_type: "data",
            data_key: "stackedColumnChart",
            apiConfig: {
              aggregation_period: 3600,
              data_type: "aggregate",
              summarize: [],
              parameters: ["mt_energy"],
              data_source: "new",
              parameter_attributes: ["sum"],
              things: thingIds.slice(0, 8),
              from_time: from,
              upto_time: now
            },
            lineWidth: 1,
            dataSource: "new",
            keyPathExp: "time",
            valPathExp: "parameter_values.mt_energy.sum",
            dataPathExp: "result.data"
          }
        ]
      }
    : null;

  const [table, graph] = await Promise.all([
    client.fetchTableData(tableBody).catch((error) => {
      errors.push({ kind: "table", error: error instanceof Error ? error.message : String(error) });
      return null;
    }),
    graphBody
      ? client.fetchGraphData(graphBody).catch((error) => {
          errors.push({ kind: "graph", error: error instanceof Error ? error.message : String(error) });
          return null;
        })
      : Promise.resolve(null)
  ]);

  if (table != null) {
    await upsertReportCache(
      env,
      {
        reportKey: "gravity:sessions",
        title: "Asset sessions (24h)",
        kind: "table",
        payload: table
      },
      observedAt
    );
    stored += 1;
  }
  if (graph != null) {
    await upsertReportCache(
      env,
      {
        reportKey: "gravity:energy-24h",
        title: "Active energy (hourly, 24h)",
        kind: "graph",
        payload: { things: thingIds.slice(0, 8), series: graph }
      },
      observedAt
    );
    stored += 1;
  }

  await writeSessionPollStamp(env, "last_reports_poll_at", observedAt);
  return {
    ok: true,
    stored,
    thing_ids: thingIds.length,
    errors,
    observed_at: observedAt
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      let session = null;
      try {
        if (datomsEmail(env) && datomsPassword(env)) {
          session = await makeDatomsClient(env).sessionStatus();
        }
      } catch {
        session = { error: "unable to read session status" };
      }
      return json({
        ok: true,
        service: "dropx-datoms-alerts",
        has_kv: Boolean(env.ALERT_DEDUPE),
        has_supabase: Boolean((env.SUPABASE_URL || env.COMPANY_SUPABASE_URL) && (env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY)),
        has_report_bot: Boolean(env.REPORT_BOT_URL && env.REPORT_BOT_TOKEN),
        has_datoms_password: Boolean(datomsPassword(env)),
        // Schedule owned by OpsPulse Vercel cron (bom1 / India egress). CF cron disabled.
        poll_cron: "vercel:/api/cron/datoms-alerts */10",
        session
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
      // Default session-reuse only — require allow_login=1 explicitly to hit /accounts/login.
      const allowLogin = url.searchParams.get("allow_login") === "1";
      try {
        const result = await runPoll(env, { dryRun, allowLogin });
        return json(result);
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    if (req.method === "POST" && url.pathname === "/things/snapshot") {
      if (!adminOk(req, env)) return json({ error: "Unauthorized" }, 401);
      try {
        return json(await runThingsSnapshot(env, { allowLogin: false }));
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    if (req.method === "POST" && url.pathname === "/reports/snapshot") {
      if (!adminOk(req, env)) return json({ error: "Unauthorized" }, 401);
      try {
        return json(await runReportsSnapshot(env, { allowLogin: false }));
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    if (req.method === "POST" && url.pathname === "/session/keepalive") {
      if (!adminOk(req, env)) return json({ error: "Unauthorized" }, 401);
      try {
        return json(await runKeepAlive(env));
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    // Arm the 25h login backoff (Datoms account lock window) without deleting a good session.
    if (req.method === "POST" && url.pathname === "/session/backoff") {
      if (!adminOk(req, env)) return json({ error: "Unauthorized" }, 401);
      try {
        const client = makeDatomsClient(env, { allowLogin: false });
        await client.writeLoginBackoff("manual 25h backoff after Datoms account lock", 25 * 60 * 60);
        return json({ ok: true, session: await client.sessionStatus() });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    // Clear login backoff / force drop KV session after password change or rate-limit lockout.
    if (req.method === "POST" && url.pathname === "/session/reset") {
      if (!adminOk(req, env)) return json({ error: "Unauthorized" }, 401);
      try {
        const client = makeDatomsClient(env, { allowLogin: false });
        await client.clearSession();
        await client.clearLoginBackoff();
        return json({ ok: true, cleared: true });
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