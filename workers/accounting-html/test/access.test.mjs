import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
const key = "synthetic-test-secret-at-least-32-characters";
const headers = {
  authorization: `Bearer ${key}`,
  "x-company-id": "test-company",
  "x-actor-id": "test-owner",
};
function fixture() {
  const calls = [];
  return {
    calls,
    env: {
      ACCOUNTING_API_KEY: key,
      COMPANY_ID: "test-company",
      ACCOUNTING: {
        idFromName: (value) => {
          calls.push(value);
          return value;
        },
        get: () => ({ fetch: () => Response.json({ ok: true }) }),
      },
    },
  };
}
test("missing or invalid worker key and wrong company never reach storage", async () => {
  for (const patch of [
    { authorization: "" },
    { authorization: "Bearer wrong" },
    { "x-company-id": "another-company" },
  ]) {
    const { env, calls } = fixture();
    const r = await worker.fetch(
      new Request("https://worker.example/v1/status", {
        headers: { ...headers, ...patch },
      }),
      env,
    );
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  }
});
test("actor and route allowlist enforced before durable object forwarding", async () => {
  const { env, calls } = fixture();
  assert.equal(
    (
      await worker.fetch(
        new Request("https://worker.example/v1/status", {
          headers: { ...headers, "x-actor-id": "" },
        }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request("https://worker.example/v1/payments", {
          method: "POST",
          headers,
        }),
        env,
      )
    ).status,
    404,
  );
  assert.equal(calls.length, 0);
});
test("authenticated request always selects the fixed company and returns no-store", async () => {
  const { env, calls } = fixture();
  assert.equal(
    (
      await worker.fetch(
        new Request("https://worker.example/v1/status", { headers }),
        env,
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, ["test-company"]);
  const rejected = await worker.fetch(
    new Request("https://worker.example/v1/status"),
    env,
  );
  assert.equal(rejected.headers.get("cache-control"), "private, no-store");
});
