import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
const create = () => {
  const db = new DatabaseSync(":memory:");
  return new Store({
    exec(query, ...args) {
      return db.prepare(query).all(...args);
    },
  });
};
test("repeated captures are saved once; separate captures retained", () => {
  const s = create();
  const a = {
    sha256: "a",
    capturedAt: "2026-10-16T00:00:00Z",
    account: "12345678901234",
    rows: [1, 2],
  };
  s.save(a);
  s.save(a);
  s.save({ ...a, sha256: "b" });
  assert.equal(s.list().length, 2);
  assert.deepEqual(s.snapshot("a").rows, [1, 2]);
  assert.throws(() => s.snapshot("missing"));
});
test("separate provider sessions, explicit expiry cleanup and private status", () => {
  const s = create();
  s.setSession("fednet", "secret-session-1");
  s.setSession("cocloud", "secret-session-2");
  assert.equal(s.session("fednet"), "secret-session-1");
  s.forgetSession("fednet");
  assert.equal(s.session("fednet"), undefined);
  assert.equal(s.session("cocloud"), "secret-session-2");
  s.audit("actor", "collect:fednet", "validated");
  assert.equal(s.status().events.length, 1);
  assert.equal(JSON.stringify(s.status()).includes("secret-session"), false);
});
