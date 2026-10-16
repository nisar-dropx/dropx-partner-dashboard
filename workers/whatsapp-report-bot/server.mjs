// DropX Report Bot worker: holds one WhatsApp linked-device session, forwards
// report images from portal-enabled groups, and sends what the portal asks.
// It keeps nothing important on its own disk: the WhatsApp login and message records
// live in the portal, so the worker can be redeployed or moved without re-linking.
import http from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  normalizeMessageContent
} from "@whiskeysockets/baileys";
import { clearRemoteSession, hasRemoteSession, useRemoteAuthState } from "./auth-state.mjs";
import {
  backoffMs,
  bearerMatches,
  classifyContent,
  EventQueue,
  GROUP_JID,
  ChatLog,
  chatEntry,
  cleanMentions,
  Lru,
  MEDIA_REF,
  messageSeconds,
  newRef,
  normalizeConfig,
  pruneOlderThan,
  readJson,
  validateSend,
  writeJsonAtomic
} from "./lib.mjs";

const PORT = Number(process.env.PORT || 8090);
const WORKER_TOKEN = String(process.env.WORKER_TOKEN || "").trim();
const PORTAL_URL = String(process.env.PORTAL_URL || "https://ops.dropxlogistics.com").trim().replace(/\/+$/, "");
// Hosts publish the service's own address; the worker reports it so nobody copies it by hand.
const PUBLIC_URL = (() => {
  const explicit = String(process.env.WORKER_PUBLIC_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "");
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  return null;
})();
// Only a cache: losing it costs a re-download from WhatsApp, never data.
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), "dropx-report-bot");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const EVENTS_DIR = path.join(DATA_DIR, "events");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const SENT_FILE = path.join(DATA_DIR, "sent-refs.json");
const MEDIA_TTL_HOURS = Math.max(Number(process.env.MEDIA_TTL_HOURS || 48), 1);
const MAX_MEDIA_BYTES = Math.max(Number(process.env.MAX_MEDIA_BYTES || 12 * 1024 * 1024), 1024 * 1024);
// Matches the portal's cut-off for accepting a message as a new submission.
const MAX_MESSAGE_AGE_SECONDS = 6 * 60 * 60;
// Vercel rejects request bodies over 4.5 MB; stay well under it per event batch.
const MAX_BATCH_BYTES = 3 * 1024 * 1024;
const MAX_RECORD_BYTES = 100_000;
const DEVICE_NAME = String(process.env.DEVICE_NAME || "DropX Report Bot").slice(0, 40);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const baileysLogger = logger.child({ module: "baileys" }, { level: process.env.BAILEYS_LOG_LEVEL || "warn" });

if (!WORKER_TOKEN || WORKER_TOKEN.length < 20) {
  logger.fatal("WORKER_TOKEN is missing or too short. Copy it from Ops Pulse → Settings → Report Bot setup.");
  process.exit(1);
}
if (!/^https?:\/\//.test(PORTAL_URL)) {
  logger.fatal("PORTAL_URL must be the portal address, for example https://ops.dropxlogistics.com");
  process.exit(1);
}

const queue = new EventQueue(EVENTS_DIR);
const messageCache = new Lru(500); // recent group messages, for quoting replies
// Live chat view for the portal: recent messages of enabled groups, memory only.
const chatLog = new ChatLog(300);
const botMessageIds = new Lru(2000); // ids the bot itself sent, never forwarded back
let sentRefs = new Lru(1000); // client_ref -> result, so a retried /send never posts twice
let config = normalizeConfig(null);

const session = {
  sock: null,
  state: "idle",
  qr: null,
  pairingCode: null,
  pairingPhone: null,
  lastError: null,
  manualStop: false,
  reconnectFailures: 0,
  reconnectTimer: null,
  groups: new Map() // id -> { subject, size, announce }
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(Object.assign(new Error("Request body too large."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error("Body must be JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function portalFetch(pathname, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(`${PORTAL_URL}${pathname}`, {
      ...init,
      headers: { authorization: `Bearer ${WORKER_TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The WhatsApp login store in the portal. Throws on failure so a key is never assumed saved. */
async function authCall(body) {
  const response = await portalFetch("/api/report-bot/worker/auth", { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Portal session store returned HTTP ${response.status}`);
  return response.json();
}

/** "9198...:12@s.whatsapp.net" and "1234@lid" both reduce to their user part. */
function bareId(value) {
  return String(value ?? "").split("@")[0].split(":")[0];
}

/** Groups may list this account by phone number or by its LID, so match either. */
function myIds(sock) {
  return new Set([sock?.user?.id, sock?.user?.lid].filter(Boolean).map(bareId));
}

function statusEvent() {
  return {
    type: "status",
    state: session.state,
    me: session.sock?.user ? { id: session.sock.user.id, name: session.sock.user.name ?? null } : null,
    error: session.lastError,
    public_url: PUBLIC_URL
  };
}

function setState(state, error = null) {
  session.state = state;
  session.lastError = error;
  if (state !== "qr") session.qr = null;
  if (state !== "pairing") session.pairingCode = null;
  queue.push(statusEvent()).catch(() => {});
}

async function wipeSession() {
  await clearRemoteSession(authCall).catch((error) => logger.error({ err: error }, "could not clear the saved session"));
  session.groups.clear();
}

function closeSocket() {
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
  const sock = session.sock;
  session.sock = null;
  if (sock) {
    sock.ev.removeAllListeners();
    try {
      sock.end(undefined);
    } catch {
      // already closed
    }
  }
}

async function refreshGroups() {
  if (!session.sock || session.state !== "open") return [];
  const all = await session.sock.groupFetchAllParticipating();
  session.groups.clear();
  for (const group of Object.values(all)) {
    session.groups.set(group.id, { subject: group.subject ?? "", size: Array.isArray(group.participants) ? group.participants.length : 0, announce: Boolean(group.announce) });
  }
  return [...session.groups.entries()].map(([id, group]) => ({ id, ...group }));
}

async function forwardMessage(msg) {
  const groupId = msg.key?.remoteJid;
  if (!groupId || !GROUP_JID.test(groupId) || !config.groups.includes(groupId)) return;
  const messageId = msg.key.id;
  if (!messageId || botMessageIds.has(messageId)) return;
  if (msg.key.fromMe && !config.include_own_messages) return;
  // History replayed after a re-link is not a fresh report; the portal would drop it
  // anyway, so don't spend bandwidth downloading its images.
  if (Date.now() / 1000 - messageSeconds(msg.messageTimestamp) > MAX_MESSAGE_AGE_SECONDS) return;
  messageCache.set(messageId, msg);
  const content = normalizeMessageContent(msg.message);
  const media = classifyContent(content);
  if (!media) return; // text, stickers, video, voice: the portal only checks images
  if (media.size && media.size > MAX_MEDIA_BYTES) {
    logger.info({ groupId, messageId, size: media.size }, "skipping oversized image");
    return;
  }
  // Download now while WhatsApp's link is fresh; the bytes are only a local cache.
  const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: baileysLogger, reuploadRequest: session.sock.updateMediaMessage });
  if (!buffer?.length || buffer.length > MAX_MEDIA_BYTES) return;
  const ref = newRef();
  await writeFile(path.join(MEDIA_DIR, `${ref}.bin`), buffer);
  // The message record (a few KB) lets any worker download this image again later.
  const record = JSON.stringify({ key: msg.key, message: msg.message, messageTimestamp: msg.messageTimestamp }, BufferJSON.replacer);
  await queue.push({
    type: "message",
    group_id: groupId,
    group_name: session.groups.get(groupId)?.subject ?? null,
    message_id: messageId,
    sender_jid: msg.key.participant || msg.participant || null,
    sender_name: msg.pushName || null,
    from_me: Boolean(msg.key.fromMe),
    sent_by_bot: false,
    timestamp: messageSeconds(msg.messageTimestamp),
    kind: media.kind,
    caption: media.caption,
    media: { ref, mime: media.mime, size: buffer.length },
    message_record: record.length <= MAX_RECORD_BYTES ? record : null
  });
}

function scheduleReconnect() {
  if (session.manualStop || session.reconnectTimer) return;
  const delay = backoffMs(session.reconnectFailures++);
  logger.info({ delay }, "reconnecting");
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    startSocket({ method: "qr" }).catch((error) => {
      logger.error({ err: error }, "reconnect failed");
      scheduleReconnect();
    });
  }, delay);
}

async function startSocket({ method, phone = null }) {
  closeSocket();
  session.manualStop = false;
  session.pairingPhone = method === "code" ? phone : null;
  const { state: authState, saveCreds, registered } = await useRemoteAuthState(authCall);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined; // fall back to the library's bundled version
  }
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    // Cache keys in memory so every message doesn't round-trip to the portal.
    auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, baileysLogger) },
    logger: baileysLogger,
    browser: Browsers.ubuntu(DEVICE_NAME),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async (key) => messageCache.get(key.id)?.message ?? undefined
  });
  session.sock = sock;
  setState("connecting");
  logger.info({ registered }, "starting whatsapp socket");
  let pairingRequested = false;

  sock.ev.on("creds.update", () => saveCreds().catch((error) => logger.error({ err: error }, "could not save credentials")));

  sock.ev.on("connection.update", async (update) => {
    if (session.sock !== sock) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      if (session.pairingPhone && !pairingRequested) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(session.pairingPhone);
          setState("pairing");
          session.pairingCode = code?.match(/.{1,4}/g)?.join("-") ?? code;
        } catch (error) {
          logger.error({ err: error }, "pairing code request failed");
          setState("idle", "Could not get a pairing code. Check the number, or use the QR code.");
          closeSocket();
        }
      } else if (!session.pairingPhone) {
        setState("qr");
        session.qr = qr;
      }
    }
    if (connection === "open") {
      session.reconnectFailures = 0;
      session.pairingPhone = null;
      setState("open");
      refreshGroups().catch((error) => logger.warn({ err: error }, "group refresh failed"));
      logger.info({ me: sock.user?.id }, "whatsapp connected");
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const wasRegistered = Boolean(sock.authState?.creds?.registered || sock.authState?.creds?.me?.id);
      session.sock = null;
      if (code === DisconnectReason.loggedOut) {
        await wipeSession();
        setState("logged_out", "WhatsApp unlinked this device. Link again from the portal.");
      } else if (code === DisconnectReason.connectionReplaced) {
        setState("closed", "This WhatsApp session was opened by another worker. Only one worker may run per number.");
      } else if (code === DisconnectReason.restartRequired) {
        // Normal right after linking: WhatsApp asks for a fresh connection.
        startSocket({ method: "qr" }).catch(() => scheduleReconnect());
      } else if (!wasRegistered) {
        setState("idle", "Linking timed out. Click Link again in the portal.");
      } else if (!session.manualStop) {
        setState("closed", lastDisconnect?.error?.message ?? "Connection lost.");
        scheduleReconnect();
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages ?? []) {
      const groupId = msg?.key?.remoteJid;
      if (groupId && config.groups.includes(groupId)) {
        chatLog.add(groupId, chatEntry(msg, { normalize: normalizeMessageContent, isBot: (id) => botMessageIds.has(id) }));
      }
      try {
        await forwardMessage(msg);
      } catch (error) {
        logger.warn({ err: error, id: msg?.key?.id }, "could not forward message");
      }
    }
  });

  sock.ev.on("groups.update", (updates) => {
    for (const update of updates ?? []) {
      if (!update.id || !GROUP_JID.test(update.id)) continue;
      const known = session.groups.get(update.id) ?? { subject: "", size: 0, announce: false };
      session.groups.set(update.id, { ...known, ...(update.subject ? { subject: update.subject } : {}), ...(update.announce !== undefined ? { announce: Boolean(update.announce) } : {}) });
      if (config.groups.includes(update.id)) queue.push({ type: "group_updated", group_id: update.id, group_name: session.groups.get(update.id).subject }).catch(() => {});
    }
  });

  sock.ev.on("group-participants.update", ({ id, participants, action }) => {
    const mine = myIds(sock);
    const removedMe = action === "remove" && (participants ?? []).some((participant) => mine.has(bareId(participant?.id ?? participant)));
    if (removedMe) {
      session.groups.delete(id);
      queue.push({ type: "group_left", group_id: id }).catch(() => {});
    }
  });
}

async function sendToGroup(body) {
  const cached = sentRefs.get(body.client_ref);
  if (cached) return cached;
  if (!session.sock || session.state !== "open") throw Object.assign(new Error("WhatsApp is not connected."), { status: 503 });
  if (!session.groups.has(body.to)) await refreshGroups();
  const group = session.groups.get(body.to);
  if (!group) throw Object.assign(new Error("The linked number is not a member of this group."), { status: 422 });
  if (group.announce) {
    // Only admins can post; WhatsApp would reject a non-admin silently.
    const metadata = await session.sock.groupMetadata(body.to);
    const mine = myIds(session.sock);
    const admin = metadata.participants?.some((participant) => participant.admin && [participant.id, participant.lid, participant.phoneNumber].some((value) => value && mine.has(bareId(value))));
    if (!admin) throw Object.assign(new Error("Only admins can send messages in this group. Make the bot number an admin."), { status: 422 });
  }
  const quotedId = body.quoted?.id && typeof body.quoted.id === "string" ? body.quoted.id : null;
  const quoted = quotedId
    ? messageCache.get(quotedId) ?? { key: { remoteJid: body.to, id: quotedId, fromMe: false, participant: body.quoted.participant || undefined }, message: { conversation: "" } }
    : undefined;
  await session.sock.sendPresenceUpdate("composing", body.to).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500 + Math.floor(Math.random() * 1500)));
  const mentions = cleanMentions(body.mentions);
  const sent = await session.sock.sendMessage(body.to, { text: body.text, ...(mentions.length ? { mentions } : {}) }, quoted ? { quoted } : {});
  await session.sock.sendPresenceUpdate("paused", body.to).catch(() => {});
  const result = { id: sent?.key?.id ?? null };
  if (result.id) {
    botMessageIds.set(result.id, true);
    const quotedEntry = quotedId ? chatLog.list(body.to).find((entry) => entry.id === quotedId) : null;
    chatLog.add(body.to, {
      id: result.id, from: null, name: null, from_me: true, bot: true, ts: Math.floor(Date.now() / 1000), type: "text", text: body.text,
      quoted: quotedId ? { id: quotedId, from: body.quoted?.participant ?? null, type: quotedEntry?.type ?? "image", text: quotedEntry?.text ?? null } : null,
      mentions
    });
  }
  sentRefs.set(body.client_ref, result);
  await writeJsonAtomic(SENT_FILE, sentRefs.entries()).catch(() => {});
  return result;
}

/** Image bytes: from the local cache, otherwise downloaded from WhatsApp using the saved record. */
async function mediaBytes(ref, record) {
  const file = path.join(MEDIA_DIR, `${ref}.bin`);
  if (await stat(file).catch(() => null)) return { status: 200, bytes: await readFile(file) };
  if (typeof record !== "string" || !record) return { status: 404, error: "This image was received before the portal kept message records." };
  if (!session.sock || session.state !== "open") return { status: 503, error: "WhatsApp is not connected, so the image cannot be fetched right now." };
  let message;
  try {
    message = JSON.parse(record, BufferJSON.reviver);
  } catch {
    return { status: 404, error: "The saved message record is unreadable." };
  }
  try {
    const bytes = await downloadMediaMessage(message, "buffer", {}, { logger: baileysLogger, reuploadRequest: session.sock.updateMediaMessage });
    if (!bytes?.length) return { status: 404, error: "WhatsApp returned an empty image." };
    await writeFile(file, bytes).catch(() => {});
    return { status: 200, bytes };
  } catch (error) {
    logger.warn({ err: error, ref }, "download from WhatsApp failed");
    return { status: 404, error: "WhatsApp no longer has this image (deleted or expired on the sender's phone)." };
  }
}

async function handle(req, res) {
  const url = new URL(req.url, "http://worker");
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, state: session.state });
  if (!bearerMatches(req.headers.authorization, WORKER_TOKEN)) return json(res, 401, { error: "Unauthorized" });

  if (req.method === "GET" && url.pathname === "/session") {
    return json(res, 200, {
      state: session.state,
      qr: session.state === "qr" ? session.qr : null,
      pairing_code: session.state === "pairing" ? session.pairingCode : null,
      me: session.sock?.user ? { id: session.sock.user.id, name: session.sock.user.name ?? null } : null,
      last_error: session.lastError
    });
  }
  if (req.method === "POST" && url.pathname === "/session/connect") {
    const body = await readBody(req);
    if (session.state === "open") return json(res, 409, { error: "Already connected. Unlink first to switch numbers." });
    const method = body.method === "code" ? "code" : "qr";
    const phone = String(body.phone ?? "").replace(/\D/g, "");
    if (method === "code" && (phone.length < 10 || phone.length > 15)) return json(res, 400, { error: "Phone number must be 10 to 15 digits with country code." });
    if (method === "code" && (await hasRemoteSession(authCall))) return json(res, 409, { error: "A session is already saved. Unlink first." });
    await startSocket({ method, phone: method === "code" ? phone : null });
    return json(res, 202, { ok: true, state: session.state });
  }
  if (req.method === "POST" && url.pathname === "/session/logout") {
    session.manualStop = true;
    const sock = session.sock;
    // Try even while reconnecting, so the phone's Linked devices list is cleaned up too.
    if (sock) await Promise.race([sock.logout().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
    closeSocket();
    await wipeSession();
    setState("logged_out", null);
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/chats") {
    const group = url.searchParams.get("group") ?? "";
    if (!GROUP_JID.test(group) || !config.groups.includes(group)) return json(res, 404, { error: "This group is not enabled in the portal." });
    const after = Number(url.searchParams.get("after") || 0);
    return json(res, 200, {
      messages: chatLog.list(group, Number.isFinite(after) ? after : 0),
      names: Object.fromEntries(chatLog.names),
      since: chatLog.startedAt,
      connected: session.state === "open",
      subject: session.groups.get(group)?.subject ?? null,
      size: session.groups.get(group)?.size ?? null
    });
  }
  if (req.method === "GET" && url.pathname === "/groups") {
    if (session.state !== "open") return json(res, 503, { error: "WhatsApp is not connected." });
    return json(res, 200, { groups: await refreshGroups() });
  }
  if (req.method === "POST" && url.pathname === "/config") {
    config = normalizeConfig(await readBody(req));
    chatLog.forget(config.groups); // a group turned off in the portal stops being visible at once
    await writeJsonAtomic(CONFIG_FILE, config).catch(() => {});
    return json(res, 200, { ok: true, groups: config.groups.length });
  }
  if (req.method === "POST" && url.pathname === "/send") {
    const body = await readBody(req, 20_000);
    const invalid = validateSend(body, config);
    if (invalid) return json(res, 422, { error: invalid });
    return json(res, 200, await sendToGroup(body));
  }
  if (req.method === "POST" && url.pathname === "/media") {
    // The record arrives JSON-encoded inside this body, where escaping can triple its size.
    const body = await readBody(req, MAX_RECORD_BYTES * 3 + 1000);
    if (typeof body.ref !== "string" || !MEDIA_REF.test(body.ref)) return json(res, 400, { error: "Invalid media reference." });
    const result = await mediaBytes(body.ref, body.record);
    if (result.status !== 200) return json(res, result.status, { error: result.error });
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": result.bytes.length, "cache-control": "no-store" });
    return res.end(result.bytes);
  }
  return json(res, 404, { error: "Not found" });
}

let deliveryFailures = 0;
let lastDelivery = 0;
async function deliverLoop() {
  try {
    const peeked = await queue.peek(50);
    // Keep each request under the portal's body limit; always send at least one event.
    const batch = [];
    let bytes = 0;
    for (const item of peeked) {
      const size = Buffer.byteLength(JSON.stringify(item.event));
      if (batch.length && bytes + size > MAX_BATCH_BYTES) break;
      batch.push(item);
      bytes += size;
    }
    // An empty batch every minute is the heartbeat that tells the portal we are alive.
    const heartbeatDue = Date.now() - lastDelivery > 60_000;
    if (batch.length || heartbeatDue) {
      const events = batch.length ? batch.map((item) => item.event) : [statusEvent()];
      const response = await portalFetch("/api/report-bot/worker/events", { method: "POST", body: JSON.stringify({ events }) });
      if (response.ok || response.status === 400) {
        if (response.status === 400) logger.error({ body: await response.text() }, "portal rejected an event batch; dropping it");
        await queue.remove(batch.map((item) => item.name));
        deliveryFailures = 0;
        lastDelivery = Date.now();
      } else {
        throw new Error(`Portal returned HTTP ${response.status}`);
      }
    }
    setTimeout(deliverLoop, batch.length < peeked.length || peeked.length === 50 ? 200 : 2_000);
  } catch (error) {
    const delay = backoffMs(deliveryFailures++);
    logger.warn({ err: error.message, delay }, "event delivery failed");
    setTimeout(deliverLoop, delay);
  }
}

async function configLoop() {
  try {
    const response = await portalFetch("/api/report-bot/worker/config");
    if (response.ok) {
      config = normalizeConfig(await response.json());
      chatLog.forget(config.groups);
      await writeJsonAtomic(CONFIG_FILE, config).catch(() => {});
    } else {
      logger.warn({ status: response.status }, response.status === 401 ? "the portal rejected WORKER_TOKEN; copy it again from Report Bot setup" : "config refresh failed");
    }
  } catch (error) {
    logger.warn({ err: error.message }, "config refresh failed");
  }
  setTimeout(configLoop, 60_000);
}

/** Reconnect a saved WhatsApp login on boot, retrying while the portal is unreachable. */
async function resumeSavedSession(attempt = 0) {
  try {
    if (await hasRemoteSession(authCall)) await startSocket({ method: "qr" });
  } catch (error) {
    const delay = backoffMs(attempt);
    logger.warn({ err: error.message, delay }, "could not check the saved session; retrying");
    setTimeout(() => resumeSavedSession(attempt + 1), delay);
  }
}

async function main() {
  await mkdir(MEDIA_DIR, { recursive: true });
  await queue.init();
  config = normalizeConfig(await readJson(CONFIG_FILE, null));
  sentRefs = new Lru(1000);
  for (const [key, value] of await readJson(SENT_FILE, [])) sentRefs.set(key, value);
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error({ err: error }, "request failed");
      if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : "Worker error" });
    });
  });
  server.listen(PORT, () => logger.info({ port: PORT, portal: PORTAL_URL, publicUrl: PUBLIC_URL }, "report bot worker listening"));
  deliverLoop();
  configLoop();
  const prune = () => pruneOlderThan(MEDIA_DIR, MEDIA_TTL_HOURS * 3600 * 1000, Date.now(), ".bin").catch(() => {});
  setInterval(prune, 3600 * 1000);
  prune();
  resumeSavedSession();

  const shutdown = () => {
    session.manualStop = true;
    closeSocket(); // keep the saved session; this is a restart, not an unlink
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  logger.fatal({ err: error }, "worker failed to start");
  process.exit(1);
});
