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

/** Deletes files in `directory` older than `maxAgeMs`; returns how many. */
export async function pruneOlderThan(directory, maxAgeMs, now = Date.now()) {
  let removed = 0;
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs > maxAgeMs) {
      await rm(file, { force: true });
      removed += 1;
    }
  }
  return removed;
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
