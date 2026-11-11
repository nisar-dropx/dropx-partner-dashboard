import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const station = "11111111-1111-4111-8111-111111111111";
const worker = "22222222-2222-4222-8222-222222222222";
const otherStation = "33333333-3333-4333-8333-333333333333";
function setup(options = {}) {
  const calls = [];
  const auth = { locationScopeIds: [station], hasAllLocationAccess: false, companyId: "trusted-company" };
  const deps = {
    "@/lib/access-surface": { currentAdminAccessSurface: () => "ops" },
    "@/lib/authorization": { getAuthorization: async () => options.signedOut ? null : auth, hasPermission: (_auth, code, action) => options.denied ? false : code === "ops_workforce_payouts" && action === "access" },
    "@/lib/company-scope": { requireCompanyId: (authorization) => authorization.companyId },
    "@/lib/supabase-admin": { supabaseAdmin: { rpc: async (name, args) => { calls.push({ name, args }); return options.failure ? { data: null, error: { message: "sensitive database error" } } : { data: [{ workforce_id: worker, station_id: station, eligible: false, eligibility_code: "payout_dispute_open" }], error: null }; } } },
    "@/lib/payout-payment-preview-batching": { loadPayoutPaymentPreviews: ({ rows, loadBatch }) => loadBatch(rows) }
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => { if (!(name in deps)) throw new Error(name); return deps[name]; }, module, module.exports);
  const request = (body = {}) => new Request("https://ops.dropxlogistics.com/api/payments/workforce-payouts/payment-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ periodStart: "2026-10-01", periodEnd: "2026-10-31", rows: [{ workforceId: worker, stationId: station }], ...body }) });
  return { post: module.exports.POST, request, calls };
}

test("payment previews require page permission and reject out-of-scope locations before querying", async () => {
  for (const [options, body, status] of [[{ signedOut: true }, {}, 401], [{ denied: true }, {}, 403], [{}, { rows: [{ workforceId: worker, stationId: otherStation }] }, 403]]) {
    const s = setup(options);
    assert.equal((await s.post(s.request(body))).status, status);
    assert.equal(s.calls.length, 0);
  }
});
test("payment previews reject invalid periods, identities and oversized batches", async () => {
  for (const body of [{ periodStart: "2026-13-01" }, { periodEnd: "2026-10-30" }, { rows: Array(51).fill({ workforceId: worker, stationId: station }) }, { rows: [{ workforceId: "invalid", stationId: station }] }, { rows: [] }]) {
    const s = setup();
    assert.equal((await s.post(s.request(body))).status, 400);
    assert.equal(s.calls.length, 0);
  }
});
test("payment previews derive company from session and ignore submitted amounts or eligibility", async () => {
  const s = setup();
  const response = await s.post(s.request({ companyId: "other-company", rows: [{ workforceId: worker, stationId: station, eligible: true, current_target_amount: 999999 }] }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(s.calls[0], { name: "workforce_preview_payout_payment_rows", args: { p_company_id: "trusted-company", p_period_start: "2026-10-01", p_period_end: "2026-10-31", p_rows: [{ workforce_id: worker, station_id: station }] } });
  assert.equal((await response.json()).rows[0].eligibility_code, "payout_dispute_open");
});
test("preview failure is explicit and does not leak database errors", async () => {
  const s = setup({ failure: true });
  const response = await s.post(s.request());
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /sensitive database/);
});
