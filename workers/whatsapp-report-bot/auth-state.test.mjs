import test from "node:test";
import assert from "node:assert/strict";
import { clearRemoteSession, hasRemoteSession, useRemoteAuthState } from "./auth-state.mjs";

/** In-memory stand-in for the portal's /api/report-bot/worker/auth. */
function fakePortal() {
  const store = new Map();
  const calls = [];
  const call = async (body) => {
    calls.push(body);
    if (body.action === "get") return { values: Object.fromEntries(body.keys.filter((key) => store.has(key)).map((key) => [key, store.get(key)])) };
    if (body.action === "set") {
      for (const [key, value] of Object.entries(body.entries)) value === null ? store.delete(key) : store.set(key, value);
      return { ok: true };
    }
    if (body.action === "clear") {
      store.clear();
      return { ok: true };
    }
    throw new Error("unknown action");
  };
  return { store, calls, call };
}

test("a fresh login starts empty and is saved to the portal, buffers intact", async () => {
  const portal = fakePortal();
  assert.equal(await hasRemoteSession(portal.call), false);
  const first = await useRemoteAuthState(portal.call);
  assert.equal(first.registered, false);
  assert.ok(Buffer.isBuffer(first.state.creds.noiseKey.private), "new creds carry real key buffers");
  first.state.creds.registered = true;
  first.state.creds.me = { id: "919876543210:4@s.whatsapp.net" };
  await first.saveCreds();

  // A restarted worker (new process) gets the same login back from the portal.
  const second = await useRemoteAuthState(portal.call);
  assert.equal(second.registered, true);
  assert.deepEqual(Buffer.from(second.state.creds.noiseKey.private), Buffer.from(first.state.creds.noiseKey.private));
  assert.equal(await hasRemoteSession(portal.call), true);
});

test("signal keys round-trip, null deletes, and app-state keys come back as protobuf objects", async () => {
  const portal = fakePortal();
  const { state } = await useRemoteAuthState(portal.call);
  await state.keys.set({
    "pre-key": { 1: { public: Buffer.from([1, 2]), private: Buffer.from([3, 4]) }, 2: { public: Buffer.from([5]), private: Buffer.from([6]) } },
    "sender-key": { "120363000000000001@g.us::919876543210::0": Buffer.from([9, 9]) },
    "app-state-sync-key": { AAAA: { keyData: Buffer.from([7, 7, 7]) } }
  });
  assert.ok(portal.store.has("sender-key-120363000000000001@g.us::919876543210::0"), "keys are namespaced by type");
  const preKeys = await state.keys.get("pre-key", ["1", "2", "3"]);
  assert.deepEqual([...preKeys["1"].private], [3, 4]);
  assert.equal(preKeys["3"], null, "missing keys come back as null");
  const appState = await state.keys.get("app-state-sync-key", ["AAAA"]);
  assert.deepEqual([...appState.AAAA.keyData], [7, 7, 7]);
  assert.equal(typeof appState.AAAA.toJSON, "function", "converted to the protobuf type Baileys expects");

  await state.keys.set({ "pre-key": { 1: null } });
  assert.equal((await state.keys.get("pre-key", ["1"]))["1"], null, "null removes a key");
});

test("large key sets are sent in chunks and unlinking clears everything", async () => {
  const portal = fakePortal();
  const { state, saveCreds } = await useRemoteAuthState(portal.call);
  const many = Object.fromEntries(Array.from({ length: 900 }, (_, index) => [String(index), { public: Buffer.from([index % 256]), private: Buffer.from([1]) }]));
  await state.keys.set({ "pre-key": many });
  const writes = portal.calls.filter((body) => body.action === "set");
  assert.ok(writes.every((body) => Object.keys(body.entries).length <= 400), "no request exceeds the portal's per-call limit");
  assert.equal(Object.keys(await state.keys.get("pre-key", Object.keys(many))).length, 900);
  await saveCreds();
  await clearRemoteSession(portal.call);
  assert.equal(portal.store.size, 0);
  assert.equal(await hasRemoteSession(portal.call), false);
});
