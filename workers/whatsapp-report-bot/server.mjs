// DropX Report Bot worker: holds one WhatsApp linked-device session, forwards
// report images from portal-enabled groups, and sends what the portal asks.
import http from "node:http";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeWASocket,
  normalizeMessageContent,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import {
  backoffMs,
  bearerMatches,
  classifyContent,
  EventQueue,
  GROUP_JID,
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
const PORTAL_URL = String(process.env.PORTAL_URL || "").trim().replace(/\/+$/, "");
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".report-bot-data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const EVENTS_DIR = path.join(DATA_DIR, "events");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const SENT_FILE = path.join(DATA_DIR, "sent-refs.json");
// Image bytes are a short cache. The small message record is kept longer so the
// image can be downloaded from WhatsApp again when someone opens it later.
const MEDIA_TTL_HOURS = Math.max(Number(process.env.MEDIA_TTL_HOURS || 48), 1);
const MESSAGE_TTL_DAYS = Math.max(Number(process.env.MESSAGE_TTL_DAYS || 30), 1);
const MAX_MEDIA_BYTES = Math.max(Number(process.env.MAX_MEDIA_BYTES || 12 * 1024 * 1024), 1024 * 1024);
// Matches the portal's cut-off for accepting a message as a new submission.
const MAX_MESSAGE_AGE_SECONDS = 6 * 60 * 60;
const DEVICE_NAME =String(process.env.DEVICE_NAME || "DropX Report Bot").slice(0, 40);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const baileysLogger = logger.child({ module: "baileys" }, { level: process.env.BAILEYS_LOG_LEVEL || "warn" });

if (!WORKER_TOKEN || WORKER_TOKEN.length < 20) {
  logger.fatal("WORKER_TOKEN is missing or too short. Create it in Ops Pulse → Report Bot → Connection.");
  process.exit(1);
}
if (!/^https?:\/\//.test(PORTAL_URL)) {
  logger.fatal("PORTAL_URL must be the portal address, for example https://ops.dropxlogistics.com");
  process.exit(1);
}

const queue = new EventQueue(EVENTS_DIR);
const messageCache = new Lru(500); // recent group messages, for quoting replies
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

/** "9198...:12@s.whatsapp.net" and "1234@lid" both reduce to their user part. */
function bareId(value) {
  return String(value ?? "").split("@")[0].split(":")[0];
}

/** Groups may list this account by phone number or by its LID, so match either. */
function myIds(sock) {
  return new Set([sock?.user?.id, sock?.user?.lid].filter(Boolean).map(bareId));
}

function setState(state, error = null) {
  session.state = state;
  session.lastError = error;
  if (state !== "qr") session.qr = null;
  if (state !== "pairing") session.pairingCode = null;
  queue.push({ type: "status", state, me: session.sock?.user ? { id: session.sock.user.id, name: session.sock.user.name ?? null } : null, error }).catch(() => {});
}

async function hasSavedSession() {
  const creds = await readJson(path.join(AUTH_DIR, "creds.json"), null);
  return Boolean(creds?.registered || creds?.me?.id);
}

async function wipeSession() {
  await rm(AUTH_DIR, { recursive: true, force: true });
  await mkdir(AUTH_DIR, { recursive: true });
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
  // Media URLs expire, so download now and let the portal fetch it from us later.
  const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: baileysLogger, reuploadRequest: session.sock.updateMediaMessage });
  if (!buffer?.length || buffer.length > MAX_MEDIA_BYTES) return;
  const ref = newRef();
  await writeFile(path.join(MEDIA_DIR, `${ref}.bin`), buffer);
  await writeFile(path.join(MEDIA_DIR, `${ref}.meta`), JSON.stringify({ mime: media.mime, size: buffer.length }));
  await writeFile(path.join(MEDIA_DIR, `${ref}.msg`), JSON.stringify(msg, BufferJSON.replacer));
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
    media: { ref, mime: media.mime, size: buffer.length }
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
  await mkdir(AUTH_DIR, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const registered = Boolean(authState.creds.registered || authState.creds.me?.id);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined; // fall back to the library's bundled version
  }
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: authState,
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

  sock.ev.on("creds.update", saveCreds);

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
  const sent = await session.sock.sendMessage(body.to, { text: body.text }, quoted ? { quoted } : {});
  await session.sock.sendPresenceUpdate("paused", body.to).catch(() => {});
  const result = { id: sent?.key?.id ?? null };
  if (result.id) botMessageIds.set(result.id, true);
  sentRefs.set(body.client_ref, result);
  await writeJsonAtomic(SENT_FILE, sentRefs.entries()).catch(() => {});
  return result;
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
    if (method === "code" && (await hasSavedSession())) return json(res, 409, { error: "A session is already saved. Unlink first." });
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
  if (req.method === "GET" && url.pathname === "/groups") {
    if (session.state !== "open") return json(res, 503, { error: "WhatsApp is not connected." });
    return json(res, 200, { groups: await refreshGroups() });
  }
  if (req.method === "POST" && url.pathname === "/config") {
    config = normalizeConfig(await readBody(req));
    await writeJsonAtomic(CONFIG_FILE, config);
    return json(res, 200, { ok: true, groups: config.groups.length });
  }
  if (req.method === "POST" && url.pathname === "/send") {
    const body = await readBody(req, 20_000);
    const invalid = validateSend(body, config);
    if (invalid) return json(res, 422, { error: invalid });
    return json(res, 200, await sendToGroup(body));
  }
  const media = url.pathname.match(/^\/media\/([A-Za-z0-9_-]+)$/);
  if (req.method === "GET" && media && MEDIA_REF.test(media[1])) {
    const file = path.join(MEDIA_DIR, `${media[1]}.bin`);
    const meta = await readJson(path.join(MEDIA_DIR, `${media[1]}.meta`), {});
    let bytes = (await stat(file).catch(() => null)) ? await readFile(file) : null;
    if (!bytes) {
      // Cache expired: download it from WhatsApp again using the saved message record.
      const raw = await readFile(path.join(MEDIA_DIR, `${media[1]}.msg`), "utf8").catch(() => null);
      if (!raw) return json(res, 404, { error: "This image is older than the worker keeps (MESSAGE_TTL_DAYS)." });
      if (!session.sock || session.state !== "open") return json(res, 503, { error: "WhatsApp is not connected, so the image cannot be fetched right now." });
      try {
        bytes = await downloadMediaMessage(JSON.parse(raw, BufferJSON.reviver), "buffer", {}, { logger: baileysLogger, reuploadRequest: session.sock.updateMediaMessage });
      } catch (error) {
        logger.warn({ err: error, ref: media[1] }, "re-download from WhatsApp failed");
        return json(res, 404, { error: "WhatsApp no longer has this image (deleted or expired on the sender's phone)." });
      }
      if (!bytes?.length) return json(res, 404, { error: "WhatsApp returned an empty image." });
      await writeFile(file, bytes).catch(() => {});
    }
    res.writeHead(200, { "content-type": typeof meta.mime === "string" ? meta.mime : "application/octet-stream", "content-length": bytes.length, "cache-control": "no-store" });
    return res.end(bytes);
  }
  return json(res, 404, { error: "Not found" });
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

let deliveryFailures = 0;
let lastDelivery = 0;
async function deliverLoop() {
  try {
    const batch = await queue.peek(50);
    // An empty batch every minute is the heartbeat that tells the portal we are alive.
    const heartbeatDue = Date.now() - lastDelivery > 60_000;
    if (batch.length || heartbeatDue) {
      const events = batch.length ? batch.map((item) => item.event) : [{ type: "status", state: session.state, me: session.sock?.user ? { id: session.sock.user.id, name: session.sock.user.name ?? null } : null, error: session.lastError }];
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
    setTimeout(deliverLoop, batch.length === 50 ? 200 : 2_000);
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
      await writeJsonAtomic(CONFIG_FILE, config);
    } else {
      logger.warn({ status: response.status }, "config refresh failed");
    }
  } catch (error) {
    logger.warn({ err: error.message }, "config refresh failed");
  }
  setTimeout(configLoop, 60_000);
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
  server.listen(PORT, () => logger.info({ port: PORT }, "report bot worker listening"));
  deliverLoop();
  configLoop();
  const prune = () => Promise.all([
    pruneOlderThan(MEDIA_DIR, MEDIA_TTL_HOURS * 3600 * 1000, Date.now(), ".bin"),
    pruneOlderThan(MEDIA_DIR, MESSAGE_TTL_DAYS * 86400 * 1000, Date.now(), ".msg"),
    pruneOlderThan(MEDIA_DIR, MESSAGE_TTL_DAYS * 86400 * 1000, Date.now(), ".meta")
  ]).catch(() => {});
  setInterval(prune, 3600 * 1000);
  prune();
  if (await hasSavedSession()) await startSocket({ method: "qr" });

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
