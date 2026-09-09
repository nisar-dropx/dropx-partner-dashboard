import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
function compile(path, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function("require", "exports", "module", code)(
    (name) => (name in mocks ? mocks[name] : require(name)),
    module.exports,
    module,
  );
  return module.exports;
}
const pricing = compile("./pricing.ts");
const performance = compile("./performance.ts", { "./pricing": pricing });
const base = {
  provider: "Amazon",
  station_code: "KOZA",
  effective_month: "2026-08-01",
  expected_revision: 0,
  rates: {
    mg_amount_including_mhe: "747233.1009887976",
    delivery_mg_volume: "21250.123456789012345",
  },
  slabs: [],
  slab_mode: "progressive",
  reason: "Source import",
};
const card = { ...base, id: "c1", revision: 1, created_at: "2026-09-09" };
const filters = { month: "2026-08", through: "2026-08-31", provider: "" };
const location = {
  station_code: "KOZA",
  station_name: "Kozhikode",
  region: "KL",
  cluster: "Calicut",
  providers: { name: "Amazon" },
};
const cost = {
  station_code: "KOZA",
  days: 31,
  total: "123456.78",
  missing_cost_rows: 0,
  last_date: "2026-08-31",
};
const shipment = {
  station_code: "KOZA",
  client: "Amazon",
  days: 31,
  deliveries: "1000",
  missing_delivery_rows: 0,
  last_date: "2026-08-31",
};
const snapshot = {
  shipments: [shipment],
  costs: [cost],
  read_at: "2026-09-09T00:00:00Z",
};
test("Exact input decimals and unspecified values are retained", () => {
  const v = pricing.validatePricing(base);
  assert.equal(v.rates.mg_amount_including_mhe, "747233.1009887976");
  assert.equal(v.rates.ihs_mg_volume, null);
  assert.equal(v.rates.delivery_mg_volume, "21250.123456789012345");
});
test("Money rounding, daily proration and negative profit are deterministic", () => {
  assert.equal(pricing.mgEstimate("747233.1009887976", 31, 31), "747233.10");
  assert.equal(pricing.mgEstimate("31000", 9, 31), "9000.00");
  assert.equal(pricing.amount(pricing.decimal("1.005")), "1.01");
  assert.equal(pricing.subtractAmounts("10", "20.555"), "-10.56");
  assert.equal(pricing.addAmounts([null, null]), null);
  assert.equal(pricing.addAmounts(["0", null]), "0.00");
});
test("Invalid dates, numeric coercion and required MG fields fail validation", () => {
  for (const overrides of [
    { effective_month: "2026-13-01" },
    { effective_month: "2026-08-02" },
    { rates: { ...base.rates, mg_amount_including_mhe: 747233 } },
    { rates: { ...base.rates, mg_amount_including_mhe: "" } },
    { expected_revision: -1 },
    { station_code: "../KOZA" },
  ])
    assert.throws(() => pricing.validatePricing({ ...base, ...overrides }));
});
const slabInput = {
  ...base,
  provider: "Flipkart",
  rates: {},
  slabs: [
    { above: "0", upto: "1000", rate: "10" },
    { above: "1000", upto: null, rate: "12" },
  ],
};
test("Slab methods use the specified inclusive threshold and monthly quantity", () => {
  const v = pricing.validatePricing(slabInput);
  assert.equal(pricing.slabEstimate("1000", v.slabs, "all_units"), "10000.00");
  assert.equal(pricing.slabEstimate("1001", v.slabs, "all_units"), "12012.00");
  assert.equal(
    pricing.slabEstimate("1001", v.slabs, "progressive"),
    "10012.00",
  );
  assert.equal(pricing.slabEstimate("0", v.slabs, "all_units"), "0.00");
});
test("Gaps, overlaps, unordered or closed final slabs cannot be saved", () => {
  for (const slabs of [
    [{ above: "1", upto: null, rate: "10" }],
    [
      { above: "0", upto: "1000", rate: "10" },
      { above: "999", upto: null, rate: "12" },
    ],
    [
      { above: "0", upto: "1000", rate: "10" },
      { above: "1001", upto: null, rate: "12" },
    ],
    [{ above: "0", upto: "10", rate: "1" }],
    [],
  ])
    assert.throws(() => pricing.validatePricing({ ...slabInput, slabs }));
});
test("CSV parses quoted commas/newlines and protects spreadsheet formulas", () => {
  assert.deepEqual(
    pricing.parseCsv('\uFEFFa,b\r\n"hello, world","one\ntwo"\r\n'),
    [
      ["a", "b"],
      ["hello, world", "one\ntwo"],
    ],
  );
  assert.throws(() => pricing.parseCsv('a\n"unclosed'));
  assert.equal(pricing.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(pricing.csvCell("-123.45"), '"-123.45"');
});
test("Amazon CSV validates required headers, duplicates and preserves source precision", () => {
  const headers = ["station_code", ...pricing.amazonFields.map((f) => f[1])];
  const data = [
    "KOZA",
    ...pricing.amazonFields.map(([key]) => base.rates[key] ?? ""),
  ];
  const csv = pricing.csvText([headers, data]);
  const records = pricing.amazonCsv(
    csv,
    "2026-08",
    "rates.csv",
    "a".repeat(64),
  );
  assert.equal(records[0].rates.mg_amount_including_mhe, "747233.1009887976");
  assert.throws(() =>
    pricing.amazonCsv(
      pricing.csvText([headers, data, data]),
      "2026-08",
      "rates.csv",
      "a".repeat(64),
    ),
  );
  assert.throws(() =>
    pricing.amazonCsv(
      "station_code\nKOZA",
      "2026-08",
      "rates.csv",
      "a".repeat(64),
    ),
  );
});
test("Revenue is estimated from month-specific pricing and observed costs are counted once", () => {
  const [r] = performance.buildBusinessRows(
    snapshot,
    [card],
    [location],
    filters,
  );
  assert.equal(r.revenue, "747233.10");
  assert.equal(r.cost, "123456.78");
  assert.equal(r.profit, "623776.32");
  assert.match(r.basis, /MG calendar-day estimate/);
  assert.ok(r.issues.some((x) => x.includes("not included")));
});
test("Missing rates and missing costs stay null, never creating artificial profit", () => {
  const [r] = performance.buildBusinessRows(snapshot, [], [location], filters);
  assert.equal(r.revenue, null);
  assert.equal(r.profit, null);
  const [withoutCost] = performance.buildBusinessRows(
    { ...snapshot, costs: [] },
    [card],
    [location],
    filters,
  );
  assert.equal(withoutCost.cost, null);
  assert.equal(withoutCost.profit, null);
});
test("Partial source coverage and incomplete cost values are visible", () => {
  const [r] = performance.buildBusinessRows(
    { ...snapshot, costs: [{ ...cost, days: 10, missing_cost_rows: 1 }] },
    [card],
    [location],
    filters,
  );
  assert.equal(r.cost, null);
  assert.equal(r.profit, null);
  assert.ok(r.issues.includes("Cost coverage 10/31 days"));
});
test("Shared station costs cannot be counted twice, including when filtering a client", () => {
  const snap = {
    ...snapshot,
    shipments: [shipment, { ...shipment, client: "Flipkart" }],
  };
  const rows = performance.buildBusinessRows(snap, [card], [location], filters);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.cost === null && r.profit === null));
  const one = performance.buildBusinessRows(snap, [card], [location], {
    ...filters,
    provider: "Amazon",
  });
  assert.equal(one.length, 1);
  assert.equal(one[0].cost, null);
});
test("Flipkart uses imported deliveries and flags unavailable quantities", () => {
  const fc = { ...slabInput, id: "f1", revision: 1 };
  const snap = {
    shipments: [{ ...shipment, client: "Flipkart", deliveries: "1001" }],
    costs: [cost],
  };
  const [r] = performance.buildBusinessRows(snap, [fc], [location], filters);
  assert.equal(r.revenue, "10012.00");
  const [missing] = performance.buildBusinessRows(
    { shipments: [], costs: [cost] },
    [fc],
    [location],
    filters,
  );
  assert.equal(missing.revenue, null);
});
const auth = {
  companyId: "company-1",
  userId: "user-1",
  hasAllLocationAccess: false,
  locationScopeIds: ["s1"],
};
let host = "fin.dropxlogistics.com";
let calls = [];
const query = new Proxy(
  {},
  {
    get(_t, key) {
      if (key === "then")
        return (resolve) => resolve({ data: [], error: null });
      return (...args) => {
        calls.push([key, ...args]);
        return query;
      };
    },
  },
);
const db = {
  from: () => query,
  rpc: async (name, args) => {
    calls.push([name, args]);
    return { data: { shipments: [], costs: [], read_at: "now" }, error: null };
  },
};
const data = compile("./data.ts", {
  "server-only": {},
  "next/headers": { headers: () => new Headers({ host }) },
  "next/navigation": {
    notFound: () => {
      throw new Error("not-found");
    },
  },
  "@/lib/authorization": {
    requirePagePermission: async () => auth,
    hasPermission: (a, _c, action) =>
      !a.readOnly && (action === "edit" ? a.edit : a.add),
  },
  "@/lib/company-scope": { requireCompanyId: (a) => a.companyId },
  "@/lib/finance/surface": compile("./surface.ts"),
  "@/lib/supabase-admin": { supabaseAdmin: db },
  "@/lib/ops-pulse/cod": {
    loadCodLocations: async () => ({
      locations: [{ ...location, id: "s1" }],
      error: null,
    }),
  },
  "./pricing": pricing,
  "./performance": performance,
});
test("Business filters reject future and cross-month dates", () => {
  assert.throws(() => data.businessFilters({ month: "2099-01" }));
  assert.throws(() =>
    data.businessFilters({ month: "2026-08", through: "2026-09-01" }),
  );
  assert.throws(() =>
    data.businessFilters({ month: "2026-02", through: "2026-02-30" }),
  );
  assert.equal(
    data.businessFilters({ month: "2026-08" }).through,
    "2026-08-31",
  );
});
test("Pricing and business loaders enforce company, location scope and Finance host", async () => {
  calls = [];
  const context = await data.financeContext("finance_revenue");
  await data.loadBusiness(context, { month: "2026-08" });
  const rpc = calls.find((c) => c[0] === "finance_business_snapshot")[1];
  assert.equal(rpc.p_company, "company-1");
  assert.deepEqual(rpc.p_station_codes, ["KOZA"]);
  assert.ok(
    calls.some(
      (c) => c[0] === "eq" && c[1] === "company_id" && c[2] === "company-1",
    ),
  );
  assert.ok(
    calls.some(
      (c) => c[0] === "in" && c[1] === "station_code" && c[2][0] === "KOZA",
    ),
  );
  host = "dashboard.dropxlogistics.com";
  await assert.rejects(data.financeContext("finance_revenue"), /not-found/);
  host = "fin.dropxlogistics.com";
});
test("Empty authorized location scope produces an empty database filter, never all locations", async () => {
  calls = [];
  await data.loadBusiness(
    { authorization: auth, companyId: "company-1", locations: [], db },
    { month: "2026-08" },
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "finance_business_snapshot")[1].p_station_codes,
    [],
  );
});
test("Read-only preview and independent add/edit rights are enforced", () => {
  assert.equal(data.canWritePricing({ add: true, edit: false }, 0), true);
  assert.equal(data.canWritePricing({ add: true, edit: false }, 1), false);
  assert.equal(
    data.canWritePricing({ add: true, edit: true, readOnly: true }, 0),
    false,
  );
});
let writeContext = {
  authorization: { ...auth, add: true, edit: true },
  companyId: "company-1",
  locations: [{ ...location, id: "s1" }],
  db: {
    rpc: async (name, args) => {
      calls.push([name, args]);
      return { data: args.p_items.length, error: null };
    },
  },
};
const actions = compile("../../app/master/pricing/actions.ts", {
  "next/cache": { revalidatePath: () => {} },
  "@/lib/finance/data": {
    financeContext: async () => writeContext,
    canWritePricing: data.canWritePricing,
  },
  "@/lib/finance/pricing": pricing,
});
test("Pricing writes reject unauthorized locations, edits and read-only previews", async () => {
  calls = [];
  let r = await actions.savePricing([{ ...base, station_code: "OUTSIDE" }]);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
  writeContext = {
    ...writeContext,
    authorization: { ...auth, add: true, edit: false },
  };
  r = await actions.savePricing([{ ...base, expected_revision: 1 }]);
  assert.equal(r.ok, false);
  writeContext = {
    ...writeContext,
    authorization: { ...auth, add: true, edit: true, readOnly: true },
  };
  r = await actions.savePricing([base]);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
  writeContext = {
    ...writeContext,
    authorization: { ...auth, add: true, edit: true },
  };
});
test("Pricing writes validate a whole batch before one company-scoped atomic RPC", async () => {
  calls = [];
  let r = await actions.savePricing([base, base]);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
  r = await actions.savePricing([base]);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "finance_save_pricing");
  assert.equal(calls[0][1].p_company, "company-1");
  assert.equal(calls[0][1].p_actor, "user-1");
  assert.equal(calls[0][1].p_items[0].expected_revision, 0);
});
test("Filtered CSV exports reuse the authorized loader and include estimate caveats", async () => {
  let seen;
  const route = compile("../../app/finance/business/export/route.ts", {
    "next/server": {
      NextResponse: { json: (v, o) => new Response(JSON.stringify(v), o) },
    },
    "@/lib/finance/data": {
      financeContext: async (code) => {
        seen = { code };
        return { companyId: "company-1" };
      },
      loadBusiness: async (context, q) => {
        seen = { ...seen, context, q };
        return {
          rows: performance.buildBusinessRows(
            snapshot,
            [card],
            [location],
            filters,
          ),
          filters,
          readAt: "2026-09-09T00:00:00Z",
        };
      },
    },
    "@/lib/finance/pricing": pricing,
  });
  const response = await route.GET(
    new Request(
      "https://fin.dropxlogistics.com/finance/business/export?tab=pnl&month=2026-08&region=KL&location=KOZA",
    ),
  );
  assert.equal(seen.code, "finance_pnl");
  assert.equal(seen.q.location, "KOZA");
  assert.equal(seen.q.region, "KL");
  assert.equal(seen.context.companyId, "company-1");
  assert.match(response.headers.get("Cache-Control"), /no-store/);
  const body = await response.text();
  assert.match(body, /623776.32/);
  assert.match(body, /Management estimate only/);
  assert.match(body, /"KOZA"/);
});
