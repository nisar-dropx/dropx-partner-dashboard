import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
function compile(path, mocks = {}) {
  const m = { exports: {} };
  new Function(
    "require",
    "exports",
    "module",
    ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
  )((name) => (name in mocks ? mocks[name] : require(name)), m.exports, m);
  return m.exports;
}
const money = compile("src/lib/finance360/model.ts");
const treasury = compile("src/lib/finance/treasury/model.ts", {
  "../../finance360/model": money,
});
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const BANK = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ID = "a".repeat(64);
const statement = () => ({
  account: "001234567890",
  sha256: ID,
  start: "2026-10-15",
  end: "2026-10-16",
  opening: "100.00",
  closing: "70.00",
  rows: [
    {
      date: "2026-10-16",
      description: "Test debit",
      debit: "30.00",
      credit: "0.00",
      balance: "70.00",
      reference: "TESTREF123",
    },
  ],
});
function fixture(options = {}) {
  const calls = { worker: [], rpc: [], queries: [] };
  const ctx = {
    companyId: options.company ?? COMPANY,
    authorization: {
      userId: "user-1",
      readOnly: false,
      owner: true,
      add: true,
      ...options.authorization,
    },
    db: {
      from(table) {
        const filters = [];
        const q = {
          select() {
            return q;
          },
          eq(k, v) {
            filters.push([k, v]);
            return q;
          },
          async single() {
            calls.queries.push({ table, filters });
            return table === "payment_banks"
              ? {
                  data: {
                    id: BANK,
                    account_no: options.account ?? "001234567890",
                  },
                }
              : { data: { code: "bank" } };
          },
          then(resolve, reject) {
            return Promise.resolve({
              data: [
                {
                  id: BANK,
                  display_name: "Federal",
                  account_no: "001234567890",
                },
              ],
            }).then(resolve, reject);
          },
        };
        return q;
      },
      async rpc(name, payload) {
        calls.rpc.push({ name, payload });
        return { error: options.rpcError ?? null };
      },
    },
  };
  const route = compile(
    "src/app/api/finance/accounting-sync/[action]/route.ts",
    {
      "next/cache": { revalidatePath() {} },
      "@/lib/finance360/server": { booksContext: async () => ctx },
      "@/lib/authorization": {
        isCompanyOwner: (a) => a.owner,
        hasPermission: (a) => a.add,
      },
      "@/lib/finance360/model": money,
      "@/lib/finance/treasury/model": treasury,
      "@/lib/finance/accounting-sync/client": {
        ACCOUNTING_COMPANY: COMPANY,
        accountingConfigured: () => true,
        accountingRequest: async (...args) => {
          calls.worker.push(args);
          return options.snapshot ?? statement();
        },
      },
      "@/lib/finance/accounting-sync/console": {
        accountingConsole: "test console",
      },
      "@/lib/finance/accounting-sync/payments": {
        paymentCandidates: async () => ({ items: [] }),
        preparePaymentPlan: async () => {
          throw Error("Not configured in this fixture");
        },
        validatePaymentPlan: async () => {},
        paymentChecklist: () => "",
      },
    },
  );
  const post = (
    action = "import",
    input = { id: ID, bankId: BANK, confirmed: true },
    origin = "https://fin.example",
  ) =>
    route.POST(
      new Request(`https://fin.example/api/finance/accounting-sync/${action}`, {
        method: "POST",
        headers: { origin },
        body: JSON.stringify(input),
      }),
      { params: { action } },
    );
  return { route, post, calls };
}
test("browser controls require owner, including otherwise authorized accounting users", async () => {
  const f = fixture({ authorization: { owner: false } });
  assert.equal((await f.post("session", { provider: "fednet" })).status, 403);
  assert.equal((await f.post("collect", { provider: "fednet" })).status, 403);
  assert.equal(f.calls.worker.length, 0);
});
test("read-only, other-company and missing add permission cannot import", async () => {
  for (const options of [
    { authorization: { readOnly: true } },
    { company: "other" },
    { authorization: { add: false } },
  ]) {
    const f = fixture(options);
    assert.equal((await f.post()).status, 403);
    assert.equal(f.calls.rpc.length, 0);
    assert.equal(f.calls.worker.length, 0);
  }
});
test("cross-origin, insecure-origin, null-origin requests rejected before worker access", async () => {
  for (const origin of [
    "https://attacker.example",
    "http://fin.example",
    "null",
  ]) {
    const f = fixture();
    assert.equal((await f.post("import", undefined, origin)).status, 403);
    assert.equal(f.calls.worker.length, 0);
  }
});
test("import requires explicit review and rejects null JSON", async () => {
  const f = fixture();
  assert.equal(
    (await f.post("import", { id: ID, bankId: BANK, confirmed: false })).status,
    400,
  );
  assert.equal((await f.post("import", null)).status, 400);
  assert.equal(f.calls.rpc.length, 0);
});
test("bank account mismatch cannot write a statement", async () => {
  const f = fixture({ account: "991234567890" });
  const response = await f.post();
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /does not belong/);
  assert.equal(f.calls.rpc.length, 0);
});
test("server revalidates balances even when worker supplied a snapshot", async () => {
  const s = statement();
  s.rows[0].debit = "20.00";
  const f = fixture({ snapshot: s });
  assert.equal((await f.post()).status, 422);
  assert.equal(f.calls.rpc.length, 0);
});
test("reviewed import uses existing atomic RPC with server-selected company and account", async () => {
  const f = fixture();
  assert.equal((await f.post()).status, 200);
  assert.equal(f.calls.rpc.length, 1);
  const { name, payload } = f.calls.rpc[0];
  assert.equal(name, "finance360_write");
  assert.equal(payload.p_company, COMPANY);
  assert.equal(payload.p_action, "bank");
  assert.equal(payload.p_actor, "user-1");
  assert.equal(payload.p_data.rows.length, 1);
  assert.match(payload.p_data.sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    f.calls.queries.every((q) =>
      q.filters.some(
        ([key, value]) => key === "company_id" && value === COMPANY,
      ),
    ),
  );
});
test("duplicate and overlapping statement database errors do not report success", async () => {
  for (const rpcError of [
    { code: "23505" },
    { code: "P0001", message: "Statement period overlaps." },
  ]) {
    const f = fixture({ rpcError });
    assert.equal((await f.post()).status, 409);
    assert.equal(f.calls.rpc.length, 1);
  }
});
test("preview masks full account number", async () => {
  const f = fixture();
  const response = await f.route.GET(
    new Request(
      `https://fin.example/api/finance/accounting-sync/preview?id=${ID}`,
    ),
    { params: { action: "preview" } },
  );
  const data = await response.json();
  assert.equal(data.account, undefined);
  assert.equal(data.accountLast4, "7890");
});
