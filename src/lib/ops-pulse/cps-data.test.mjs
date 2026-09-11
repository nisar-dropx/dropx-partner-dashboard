import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const compile = (path, mocks = {}) => {
  const m = { exports: {} };
  new Function(
    "require",
    "exports",
    "module",
    ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  )(
    (name) => {
      if (name in mocks) return mocks[name];
      throw Error(`Unexpected dependency ${name}`);
    },
    m.exports,
    m,
  );
  return m.exports;
};
const domain = compile("./cps.ts");
const all = [
  { id: "1", station_code: "A", cluster: "North", region: "KL" },
  { id: "2", station_code: "B", cluster: "South", region: "TN" },
];
const context = {
  companyId: "company-a",
  locationScopeIds: ["1"],
  hasAllLocationAccess: false,
};
function dataModule(db, locations = all) {
  return compile("./cps-data.ts", {
    "server-only": {},
    "next/cache": { unstable_cache: (fn) => fn },
    "@/lib/company-scope": { requireCompanyId: (a) => a.companyId },
    "@/lib/authorization": {},
    "./cod": {
      loadCodLocations: async () => ({ locations, error: null }),
      todayKolkata: () => "2026-09-11",
    },
    "./adhoc-activity": { adHocClusterLabel: (l) => l.cluster },
    "./cps": domain,
    "@/lib/supabase-admin": { supabaseAdmin: db },
  });
}
test("forged station and intersecting filters cannot widen permitted locations", async () => {
  const d = dataModule(null, [all[0]]);
  assert.equal(
    (await d.cpsScope(context, { station: "B" })).selected.length,
    0,
  );
  assert.equal(
    (await d.cpsScope(context, { station: "A", region: "TN" })).selected.length,
    0,
  );
  assert.equal((await d.cpsScope(context, {})).selected.length, 1);
});
test("RPC receives company, sorted station scope and exact period; empty scope does not query", async () => {
  const calls = [];
  const db = {
    rpc: async (...args) => {
      calls.push(args);
      return { data: { daily: [], breakup: [] }, error: null };
    },
  };
  const d = dataModule(db);
  await d.loadCpsSnapshot("company-a", "2026-09-01", "2026-09-08", []);
  assert.equal(calls.length, 0);
  await d.loadCpsSnapshot(
    "company-a",
    "2026-09-01",
    "2026-09-08",
    all.toReversed(),
  );
  await d.loadCpsSnapshot("company-b", "2026-09-09", "2026-09-09", [all[1]]);
  assert.deepEqual(calls[0][1], {
    p_company: "company-a",
    p_from: "2026-09-01",
    p_through: "2026-09-08",
    p_stations: ["A", "B"],
  });
  assert.equal(calls[1][1].p_company, "company-b");
  assert.deepEqual(calls[1][1].p_stations, ["B"]);
});
test("failed or malformed snapshot cannot become a healthy empty report", async () => {
  for (const result of [
    { data: null, error: { code: "503" } },
    { data: { daily: [] }, error: null },
  ])
    await assert.rejects(
      dataModule({ rpc: async () => result }).loadCpsSnapshot(
        "company-a",
        "2026-09-01",
        "2026-09-08",
        all,
      ),
    );
});
test("Excel endpoint denies missing report or view permission before any data reads", async () => {
  for (const permissions of [[], ["cps_reports"], ["cps_daily"]]) {
    const endpoint = compile("../../app/api/ops-pulse/cps/report/route.ts", {
      "@/lib/authorization": {
        getAuthorization: async () => context,
        hasPermission: (_a, p) => permissions.includes(p),
      },
      "@/lib/ops-pulse/cps-data": {
        cpsScope: () => {
          throw Error("Data queried before permission");
        },
      },
      "@/lib/ops-pulse/cps": domain,
      "@/lib/report-workbook": {},
      "@/lib/ops-pulse/adhoc-activity": {},
    });
    assert.equal(
      (
        await endpoint.GET(
          new Request(
            "https://ops.dropxlogistics.com/api/ops-pulse/cps/report?view=daily",
          ),
        )
      ).status,
      403,
    );
  }
});
test("shared-cost edit cannot move an out-of-scope allocation into scope", async () => {
  let wrote = false;
  const record = { station_codes: ["A", "B"], updated_at: "v1" };
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    async maybeSingle() {
      return { data: record, error: null };
    },
    update() {
      wrote = true;
      return this;
    },
  };
  const actions = compile("../../app/cps/actions.ts", {
    "next/cache": { revalidateTag() {} },
    "@/lib/authorization": {
      getAuthorization: async () => context,
      hasPermission: () => true,
    },
    "@/lib/ops-pulse/cps-data": {
      cpsScope: async () => ({ companyId: "company-a", all: [all[0]] }),
    },
    "@/lib/ops-pulse/cps": domain,
    "@/lib/supabase-admin": { supabaseAdmin: { from: () => query } },
  });
  const form = new FormData();
  for (const [k, v] of Object.entries({
    id: "00000000-0000-4000-8000-000000000001",
    label: "staff",
    head: "UTR",
    station_codes: "A",
    amount: "0",
    frequency: "monthly",
    allocation: "equal",
    effective_from: "2026-09-01",
    updated_at: "v1",
  }))
    form.set(k, v);
  assert.equal((await actions.saveCpsCost(form)).ok, false);
  assert.equal(wrote, false);
});
