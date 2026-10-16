// Pure helpers for the Report Bot worker. No WhatsApp or network code here, so it is unit-testable.
import crypto from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const GROUP_JID = /^[0-9-]+@g\.us$/;
export const MEDIA_REF = /^[A-Za-z0-9_-]{8,128}$/;

/** Constant-time bearer check. An unset secret never authorises anything. */
export function bearerMatches(header, secret) {
  if (!secret || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function newRef() {
  return crypto.randomBytes(18).toString("base64url");
}

/** Insertion-ordered map that forgets the oldest entries past `max`. */
export class Lru {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    return this.map.get(key);
  }
  has(key) {
    return this.map.has(key);
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return this;
  }
  entries() {
    return [...this.map.entries()];
  }
}

/**
 * Picks what the portal cares about from an already-unwrapped message
 * (ephemeral / view-once / document-with-caption wrappers removed).
 * Returns null for anything that is not an image or an image-like document.
 */
export function classifyContent(content) {
  if (!content || typeof content !== "object") return null;
  if (content.imageMessage) {
    const image = content.imageMessage;
    return { kind: "image", node: "imageMessage", mime: image.mimetype || "image/jpeg", caption: image.caption || null, size: Number(image.fileLength ?? 0) || null };
  }
  if (content.documentMessage) {
    const document = content.documentMessage;
    const mime = String(document.mimetype || "").toLowerCase();
    if (!mime.startsWith("image/")) return null;
    return { kind: "document", node: "documentMessage", mime, caption: document.caption || document.fileName || null, size: Number(document.fileLength ?? 0) || null };
  }
  return null;
}

/** WhatsApp timestamps are seconds, sometimes a protobuf Long. */
export function messageSeconds(value) {
  if (value === null || value === undefined) return Math.floor(Date.now() / 1000);
  if (typeof value === "number") return value;
  if (typeof value === "object" && typeof value.toNumber === "function") return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Math.floor(Date.now() / 1000);
}

export function backoffMs(failures) {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, Math.min(failures, 5)));
}

/**
 * Durable event queue: one JSON file per event so a crash or restart never
 * loses a message the portal has not acknowledged.
 */
export class EventQueue {
  constructor(directory) {
    this.directory = directory;
    this.sequence = 0;
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
  }
  async push(event) {
    const name = `${Date.now().toString().padStart(15, "0")}-${String(this.sequence++).padStart(6, "0")}-${newRef()}.json`;
    const temp = path.join(this.directory, `${name}.tmp`);
    await writeFile(temp, JSON.stringify(event));
    await rename(temp, path.join(this.directory, name));
  }
  async peek(limit) {
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort().slice(0, limit);
    const items = [];
    for (const name of names) {
      try {
        items.push({ name, event: JSON.parse(await readFile(path.join(this.directory, name), "utf8")) });
      } catch {
        // A corrupt file would block the queue forever; drop it.
        await rm(path.join(this.directory, name), { force: true });
      }
    }
    return items;
  }
  async remove(names) {
    await Promise.all(names.map((name) => rm(path.join(this.directory, name), { force: true })));
  }
  async size() {
    return (await readdir(this.directory)).filter((name) => name.endsWith(".json")).length;
  }
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, file);
}

/** Deletes files in `directory` older than `maxAgeMs` (optionally only names ending in `suffix`); returns how many. */
export async function pruneOlderThan(directory, maxAgeMs, now = Date.now(), suffix = "") {
  let removed = 0;
  for (const name of await readdir(directory).catch(() => [])) {
    if (suffix && !name.endsWith(suffix)) continue;
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs > maxAgeMs) {
      await rm(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}

const CONTENT_TYPES = [
  ["conversation", "text"],
  ["extendedTextMessage", "text"],
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["documentMessage", "document"],
  ["audioMessage", "audio"],
  ["stickerMessage", "sticker"],
  ["locationMessage", "location"],
  ["contactMessage", "contact"],
  ["pollCreationMessage", "poll"],
  ["pollCreationMessageV3", "poll"]
];

/** What a (normalised) message is, for the chat view. null for reactions, edits and protocol noise. */
export function chatContent(content) {
  if (!content || typeof content !== "object") return null;
  const match = CONTENT_TYPES.find(([key]) => content[key] !== undefined && content[key] !== null);
  if (!match) return null;
  const [key, type] = match;
  const node = content[key];
  const text = typeof node === "string"
    ? node
    : node?.text ?? node?.caption ?? (type === "document" ? node?.fileName : null) ?? (type === "poll" ? node?.name : null) ?? null;
  const context = typeof node === "object" ? node?.contextInfo ?? null : null;
  return { type, text: text ? String(text).slice(0, 4000) : null, context };
}

function quotedSummary(context, normalize) {
  if (!context?.stanzaId) return null;
  const quoted = context.quotedMessage ? chatContent(normalize ? normalize(context.quotedMessage) : context.quotedMessage) : null;
  return { id: context.stanzaId, from: context.participant ?? null, type: quoted?.type ?? "text", text: quoted?.text?.slice(0, 300) ?? null };
}

/**
 * One chat-view entry from a WhatsApp message. `normalize` unwraps ephemeral/view-once
 * wrappers (Baileys' normalizeMessageContent); injectable so this stays testable.
 */
export function chatEntry(msg, { normalize, isBot }) {
  const content = chatContent(normalize ? normalize(msg?.message) : msg?.message);
  if (!content || !msg?.key?.id) return null;
  const mentions = Array.isArray(content.context?.mentionedJid) ? content.context.mentionedJid.filter((jid) => typeof jid === "string").slice(0, 20) : [];
  return {
    id: msg.key.id,
    from: msg.key.fromMe ? null : msg.key.participant || msg.participant || null,
    name: msg.pushName || null,
    from_me: Boolean(msg.key.fromMe),
    bot: Boolean(isBot?.(msg.key.id)),
    ts: messageSeconds(msg.messageTimestamp),
    type: content.type,
    text: content.text,
    quoted: quotedSummary(content.context, normalize),
    mentions
  };
}

/** Recent messages per group, newest last, bounded; in memory only (never written to disk). */
export class ChatLog {
  constructor(perGroup = 300) {
    this.perGroup = perGroup;
    this.groups = new Map();
    this.names = new Map();
    this.startedAt = Math.floor(Date.now() / 1000);
  }
  add(groupId, entry) {
    if (!entry) return;
    const list = this.groups.get(groupId) ?? [];
    const existing = list.findIndex((item) => item.id === entry.id);
    if (existing >= 0) list[existing] = { ...list[existing], ...entry, bot: list[existing].bot || entry.bot };
    else list.push(entry);
    list.sort((a, b) => a.ts - b.ts);
    while (list.length > this.perGroup) list.shift();
    this.groups.set(groupId, list);
    if (entry.from && entry.name) this.names.set(entry.from, entry.name);
  }
  markBot(groupId, id) {
    const item = (this.groups.get(groupId) ?? []).find((entry) => entry.id === id);
    if (item) item.bot = true;
  }
  list(groupId, after = 0) {
    return (this.groups.get(groupId) ?? []).filter((entry) => entry.ts > after);
  }
  forget(keepGroupIds) {
    for (const id of [...this.groups.keys()]) if (!keepGroupIds.includes(id)) this.groups.delete(id);
  }
}

/** Mentions the portal asked for: real member JIDs only, a handful at most. */
export function cleanMentions(value) {
  return Array.isArray(value) ? value.filter((jid) => typeof jid === "string" && /^\d{5,20}@(s\.whatsapp\.net|lid)$/.test(jid)).slice(0, 10) : [];
}

export function normalizeConfig(body) {
  const mode = ["off", "listen", "live"].includes(body?.mode) ? body.mode : "off";
  const groups = Array.isArray(body?.groups) ? body.groups.filter((id) => typeof id === "string" && GROUP_JID.test(id)).slice(0, 500) : [];
  return { mode, groups: mode === "off" ? [] : [...new Set(groups)], include_own_messages: mode !== "off" && body?.include_own_messages === true };
}

export function validateSend(body, config) {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  if (typeof body.client_ref !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.client_ref)) return "client_ref is required.";
  if (typeof body.to !== "string" || !GROUP_JID.test(body.to)) return "to must be a group id.";
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000) return "text must be 1 to 4000 characters.";
  if (config.mode !== "live") return "The bot is not in Live mode.";
  if (!config.groups.includes(body.to)) return "This group is not enabled in the portal.";
  return null;
}
