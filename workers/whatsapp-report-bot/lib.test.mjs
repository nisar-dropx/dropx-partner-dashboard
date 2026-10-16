import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bearerMatches, chatContent, chatEntry, ChatLog, classifyContent, cleanMentions, EventQueue, Lru, messageSeconds, normalizeConfig, pruneOlderThan, validateSend } from "./lib.mjs";

test("chat view: text, captions, replies and mentions are read; reactions and protocol noise are skipped", () => {
  assert.deepEqual(chatContent({ conversation: "Hi team" }), { type: "text", text: "Hi team", context: null });
  assert.equal(chatContent({ imageMessage: { caption: "EOD" } }).type, "image");
  assert.equal(chatContent({ reactionMessage: { text: "👍" } }), null);
  assert.equal(chatContent({ protocolMessage: {} }), null);
  const entry = chatEntry({
    key: { id: "M1", remoteJid: "120363000000000001@g.us", participant: "919876543210@s.whatsapp.net", fromMe: false },
    pushName: "Ravi",
    messageTimestamp: 1760000000,
    message: { extendedTextMessage: { text: "@919800000000 done", contextInfo: { stanzaId: "IMG1", participant: "919800000000@s.whatsapp.net", quotedMessage: { imageMessage: { caption: "EOD" } }, mentionedJid: ["919800000000@s.whatsapp.net"] } } }
  }, { normalize: (message) => message, isBot: () => false });
  assert.deepEqual(entry.quoted, { id: "IMG1", from: "919800000000@s.whatsapp.net", type: "image", text: "EOD" });
  assert.deepEqual(entry.mentions, ["919800000000@s.whatsapp.net"]);
  assert.equal(entry.name, "Ravi");
});

test("chat log is bounded, ordered, de-duplicated and forgets groups that were turned off", () => {
  const log = new ChatLog(3);
  const group = "120363000000000001@g.us";
  for (const [id, ts] of [["a", 5], ["b", 1], ["c", 3], ["d", 7]]) log.add(group, { id, ts, from: "1@s.whatsapp.net", name: "N" });
  assert.deepEqual(log.list(group).map((entry) => entry.id), ["c", "a", "d"], "oldest dropped, sorted by time");
  log.add(group, { id: "a", ts: 5, text: "edited" });
  assert.equal(log.list(group).length, 3);
  assert.deepEqual(log.list(group, 4).map((entry) => entry.id), ["a", "d"]);
  log.forget([]);
  assert.deepEqual(log.list(group), []);
});

test("mentions sent to WhatsApp are limited to real member ids", () => {
  assert.deepEqual(cleanMentions(["919876543210@s.whatsapp.net", "123456@lid", "x@g.us", 5, "evil"]), ["919876543210@s.whatsapp.net", "123456@lid"]);
  assert.deepEqual(cleanMentions(null), []);
});

const GROUP = "120363000000000001@g.us";

test("bearer check is exact and never passes with an empty secret", () => {
  const secret = "rbw_abcdefghijklmnopqrstuvwxyz";
  assert.equal(bearerMatches(`Bearer ${secret}`, secret), true);
  assert.equal(bearerMatches(`Bearer ${secret}x`, secret), false);
  assert.equal(bearerMatches(secret, secret), false);
  assert.equal(bearerMatches("Bearer ", ""), false);
  assert.equal(bearerMatches(undefined, secret), false);
});

test("only images and image documents are forwarded", () => {
  assert.equal(classifyContent({ imageMessage: { mimetype: "image/jpeg", caption: "EOD", fileLength: 12345 } }).kind, "image");
  assert.equal(classifyContent({ documentMessage: { mimetype: "image/png", fileName: "eod.png" } }).caption, "eod.png");
  assert.equal(classifyContent({ documentMessage: { mimetype: "application/pdf" } }), null);
  assert.equal(classifyContent({ conversation: "hello" }), null);
  assert.equal(classifyContent({ stickerMessage: {} }), null);
  assert.equal(classifyContent(null), null);
});

test("config: off means no groups; junk ids are dropped", () => {
  assert.deepEqual(normalizeConfig({ mode: "off", groups: [GROUP], include_own_messages: true }), { mode: "off", groups: [], include_own_messages: false });
  assert.deepEqual(normalizeConfig({ mode: "live", groups: [GROUP, GROUP, "x@s.whatsapp.net", 5] }), { mode: "live", groups: [GROUP], include_own_messages: false });
  assert.equal(normalizeConfig(null).mode, "off");
});

test("send is refused unless Live and the group is enabled", () => {
  const live = { mode: "live", groups: [GROUP] };
  const body = { client_ref: "0f8b2c1e-1111-2222-3333-444455556666", to: GROUP, text: "hi" };
  assert.equal(validateSend(body, live), null);
  assert.match(validateSend(body, { ...live, mode: "listen" }), /Live/);
  assert.match(validateSend({ ...body, to: "120363000000000009@g.us" }, live), /not enabled/);
  assert.match(validateSend({ ...body, to: "919876543210@s.whatsapp.net" }, live), /group id/);
  assert.match(validateSend({ ...body, text: " " }, live), /text/);
  assert.match(validateSend({ ...body, client_ref: "x" }, live), /client_ref/);
});

test("lru forgets the oldest entries", () => {
  const lru = new Lru(2).set("a", 1).set("b", 2).set("a", 3).set("c", 4);
  assert.deepEqual(lru.entries(), [["a", 3], ["c", 4]]);
});

test("timestamps accept numbers, strings and protobuf Longs", () => {
  assert.equal(messageSeconds(1760000000), 1760000000);
  assert.equal(messageSeconds("1760000000"), 1760000000);
  assert.equal(messageSeconds({ toNumber: () => 1760000001 }), 1760000001);
});

test("event queue is ordered, survives corrupt files, and removes acknowledged events", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "report-bot-queue-"));
  try {
    const queue = new EventQueue(directory);
    await queue.init();
    await queue.push({ n: 1 });
    await queue.push({ n: 2 });
    await writeFile(path.join(directory, "000000000000001-broken.json"), "{not json");
    const batch = await queue.peek(10);
    assert.deepEqual(batch.map((item) => item.event.n), [1, 2], "corrupt file dropped, order kept");
    await queue.remove([batch[0].name]);
    assert.equal(await queue.size(), 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("media pruning removes only expired files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "report-bot-media-"));
  try {
    await writeFile(path.join(directory, "old.bin"), "x");
    await writeFile(path.join(directory, "new.bin"), "x");
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    await utimes(path.join(directory, "old.bin"), old, old);
    await writeFile(path.join(directory, "old.msg"), "x");
    await utimes(path.join(directory, "old.msg"), old, old);
    assert.equal(await pruneOlderThan(directory, 2 * 3600 * 1000, Date.now(), ".bin"), 1, "only image bytes expire on the short cache");
    assert.equal(await pruneOlderThan(directory, 2 * 3600 * 1000, Date.now(), ".msg"), 1, "message records expire on their own schedule");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
