import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as batching from "../lib/bounded-concurrency.ts";
import * as paymentState from "../lib/workforce-payout-payment-summary.ts";

const compiled = ts.transpileModule(readFileSync(new URL("./use-workforce-payment-status.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const base = { id: "one", reviewSubjectId: "worker", locationId: "station", netAmount: 100, status: "Payment Published", publicationPaymentReady: true, publicationLockState: "locked", publicationTargetAmount: 100 };
function harness(fetcher) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useMemo(fn) { return fn(); },
    useEffect(fn, deps) { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== slots[index][i])) { slots[index] = deps; effects.push(fn); } }
  };
  const deps = { react, "@/lib/bounded-concurrency": batching, "@/lib/workforce-payout-payment-summary": paymentState };
  const module = { exports: {} };
  new Function("require", "module", "exports", "fetch", compiled)((name) => deps[name], module, module.exports, fetcher);
  return {
    render(rows, audience = "workforce", end = "2026-10-31") { cursor = 0; return module.exports.useWorkforcePaymentStatus(rows, audience, "2026-10-01", end); },
    runEffects() { return effects.splice(0).map((fn) => fn()).filter(Boolean); }
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const preview = { workforce_id: "worker", station_id: "station", current_target_amount: 100, paid_amount: 100, processing_amount: 0, balance_payable: 0, available_to_pay: 0, payment_status: "Paid", eligible: false, eligibility_code: "no_positive_balance" };

test("deferred status updates Paid without changing earnings or existing authoritative summaries", async () => {
  const existing = { ...base, id: "existing", reviewSubjectId: "other", paymentSummary: { status: "On Hold" } };
  const rows = [base, existing];
  let request;
  const h = harness(async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ rows: [preview] }) }; });
  h.render(rows); h.runEffects();
  assert.equal(h.render(rows).loading, true);
  await flush();
  const done = h.render(rows);
  assert.equal(done.loading, false);
  assert.equal(done.rows[0].status, "Paid");
  assert.equal(done.rows[0].netAmount, 100);
  assert.equal(done.rows[1], existing);
  assert.deepEqual(request.rows, [{ workforceId: "worker", stationId: "station" }]);
});
test("failed status loading stays unavailable rather than fabricating unpaid or eligible rows", async () => {
  const rows = [base];
  const h = harness(async () => ({ ok: false }));
  h.render(rows); h.runEffects(); await flush();
  const done = h.render(rows);
  assert.equal(done.error, true);
  assert.equal(done.rows[0].paymentSummary, undefined);
  assert.equal(done.rows[0].status, base.status);
});
test("leaving a worksheet aborts pending reads and discards late responses", async () => {
  let finish;
  let signal;
  const rows = [base];
  const h = harness((_url, options) => { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); });
  h.render(rows); const cleanups = h.runEffects();
  cleanups.forEach((cleanup) => cleanup());
  assert.equal(signal.aborted, true);
  finish({ ok: true, json: async () => ({ rows: [preview] }) });
  await flush();
  assert.equal(h.render(rows).rows[0].paymentSummary, undefined);
});
test("daily ranges and Helpers never use the Workforce monthly preview endpoint", () => {
  let calls = 0;
  for (const [audience, end] of [["helpers", "2026-10-31"], ["workforce", "2026-10-15"]]) {
    const h = harness(async () => { calls++; });
    h.render([base], audience, end); h.runEffects();
  }
  assert.equal(calls, 0);
});

test("progress counts only returned statuses across batches and stays incomplete on failure", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({ ...base, id: String(index), reviewSubjectId: "worker-" + index }));
  let finish;
  const h = harness(async (_url, options) => {
    const requested = JSON.parse(options.body).rows;
    if (requested.length === 1) return new Promise((resolve) => { finish = resolve; });
    return { ok: true, json: async () => ({ rows: requested.map((row) => ({ ...preview, workforce_id: row.workforceId })) }) };
  });
  h.render(rows);
  h.runEffects();
  await flush();
  const pending = h.render(rows);
  assert.equal(pending.loading, true);
  assert.equal(pending.loaded, 50);
  assert.equal(pending.total, 51);
  finish({ ok: false });
  await flush();
  const done = h.render(rows);
  assert.equal(done.loading, false);
  assert.equal(done.error, true);
  assert.equal(done.loaded, 50);
});
