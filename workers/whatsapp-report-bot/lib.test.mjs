import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bearerMatches, classifyContent, EventQueue, Lru, messageSeconds, normalizeConfig, pruneOlderThan, validateSend } from "./lib.mjs";

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
