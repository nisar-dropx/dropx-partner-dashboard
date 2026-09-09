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
  assert.match(r.basis, /Daily MG/);
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
  const rpc = calls.find((c) => c[0] === "finance_business_daily_snapshot")[1];
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
    calls.find((c) => c[0] === "finance_business_daily_snapshot")[1]
      .p_station_codes,
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
    "@/lib/finance/performance": performance,
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

function dailyFixture(month = "2026-08", throughDay = 2, overrides = {}) {
  const pc = {
    ...card,
    effective_month: `${month}-01`,
    rates: {
      mg_amount_including_mhe: "31000",
      delivery_mg_volume: "3100",
      variable_slab: "20",
      mfn_rate: "8",
      smd_rate: "27",
      ihs_rate_below_15_percent: "6.5",
      ihs_rate_above_15_percent: "7.5",
      ...overrides,
    },
  };
  const facts = [50, 150].map((n, i) => ({
    station_code: "KOZA",
    client: "Amazon",
    work_date: `${month}-${String(i + 1).padStart(2, "0")}`,
    deliveries: String(n),
    mfn: "10",
    smd: "0",
    ihs: "0",
  }));
  const snap = { ...snapshot, daily_shipments: facts, daily_costs: [] };
  return {
    pc,
    snap,
    rows: performance.buildDailyRows(
      snap,
      "KOZA",
      "Amazon",
      pc,
      month,
      `${month}-${String(throughDay).padStart(2, "0")}`,
      false,
    ),
  };
}
test("Daily MG uses actual calendar days for 28, 29, 30 and 31 day months", () => {
  for (const [month, days] of [
    ["2026-02", 28],
    ["2024-02", 29],
    ["2026-09", 30],
    ["2026-08", 31],
  ]) {
    const { rows } = dailyFixture(month, days, {
      mg_amount_including_mhe: String(days * 1000),
      delivery_mg_volume: String(days * 100),
    });
    assert.equal(rows.length, days);
    assert.ok(rows.every((d) => d.base === "1000.00" && d.mgVolume === "100"));
    assert.equal(
      pricing.addAmounts(rows.map((d) => d.base)),
      `${days * 1000}.00`,
    );
  }
});
test("Daily excess never carries a shortfall forward; MFN adds earnings independently", () => {
  const { rows } = dailyFixture();
  assert.equal(rows[0].variable, "0.00");
  assert.equal(rows[1].excessVolume, "50");
  assert.equal(rows[1].variable, "1000.00");
  assert.equal(rows[1].mfnRevenue, "80.00");
  assert.equal(pricing.addAmounts(rows.map((d) => d.revenue)), "3160.00");
  // A pooled MTD threshold would incorrectly remove this day's 50 excess shipments.
});
test("Fractional daily MG is not rounded to whole packages or money before applying the slab", () => {
  const { rows } = dailyFixture("2026-08", 2, {
    delivery_mg_volume: "3100.31",
  });
  assert.equal(rows[0].mgVolume, "100.01");
  assert.equal(rows[1].excessVolume, "49.99");
  assert.equal(rows[1].variable, "999.80");
  const zero = dailyFixture("2026-08", 2, { delivery_mg_volume: "4650" })
    .rows[1];
  assert.equal(zero.excessVolume, "0");
  assert.equal(zero.variable, "0.00");
});
test("Cumulative paise rounding reconciles daily base, variable and MFN with MTD", () => {
  const { pc, snap } = dailyFixture("2026-08", 31, {
    mg_amount_including_mhe: "100.005",
    delivery_mg_volume: "100.1",
    mfn_rate: "0.333333333333333333333333",
  });
  snap.daily_shipments = Array.from({ length: 31 }, (_, i) => ({
    ...snap.daily_shipments[0],
    work_date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    deliveries: "100",
    mfn: "1",
  }));
  const [r] = performance.buildBusinessRows(snap, [pc], [location], filters);
  assert.equal(pricing.addAmounts(r.daily.map((d) => d.base)), "100.01");
  assert.equal(pricing.addAmounts(r.daily.map((d) => d.variable)), "59998.00");
  assert.equal(pricing.addAmounts(r.daily.map((d) => d.mfnRevenue)), "10.33");
  assert.equal(r.revenue, "60108.34");
  assert.equal(pricing.addAmounts(r.daily.map((d) => d.revenue)), r.revenue);
});
test("Missing shipment days accrue MG but keep unavailable variable earnings and costs pending", () => {
  const { rows } = dailyFixture("2026-08", 3);
  assert.equal(rows[2].base, "1000.00");
  assert.equal(rows[2].variable, null);
  assert.equal(rows[2].mfnRevenue, null);
  assert.equal(rows[2].revenue, "1000.00");
  assert.equal(rows[2].cost, null);
  assert.equal(rows[2].profit, null);
  assert.equal(rows[2].shipmentReported, false);
  assert.match(rows[2].issues.join(), /Shipment report pending/);
});
test("Unknown positive-volume rates are not silently zero; zero-volume reports are valid", () => {
  const { rows } = dailyFixture("2026-08", 2, {
    variable_slab: null,
    mfn_rate: null,
  });
  assert.equal(rows[0].variable, "0.00");
  assert.equal(rows[1].variable, null);
  assert.equal(rows[1].mfnRevenue, null);
  assert.match(rows[1].issues.join(), /rate missing/);
  const { pc, snap } = dailyFixture();
  snap.daily_shipments[0] = {
    ...snap.daily_shipments[0],
    deliveries: "0",
    mfn: "0",
  };
  const d = performance.buildDailyRows(
    snap,
    "KOZA",
    "Amazon",
    pc,
    "2026-08",
    "2026-08-01",
    false,
  )[0];
  assert.equal(d.shipmentReported, true);
  assert.equal(d.variable, "0.00");
  assert.equal(d.mfnRevenue, "0.00");
});
test("SMD does not get charged twice and IHS is not guessed from the MFN/return counts", () => {
  const { pc, snap } = dailyFixture();
  snap.daily_shipments[1] = { ...snap.daily_shipments[1], smd: "5", ihs: "20" };
  const d = performance.buildDailyRows(
    snap,
    "KOZA",
    "Amazon",
    pc,
    "2026-08",
    "2026-08-02",
    false,
  )[1];
  assert.equal(d.revenue, "2080.00");
  assert.equal(d.smd, "5");
  assert.equal(d.ihs, "20");
  assert.match(d.issues.join(), /separate SMD billing rule pending/);
  assert.match(d.issues.join(), /IHS earnings pending/);
});
test("Current-month defaults do not reuse prior-month rate cards", async () => {
  const f = data.businessFilters({});
  assert.equal(f.month, pricing.todayIndia().slice(0, 7));
  assert.equal(f.through, pricing.todayIndia());
  calls = [];
  const context = await data.financeContext("finance_revenue");
  await data.loadBusiness(context, {});
  assert.ok(
    calls.some(
      (c) =>
        c[0] === "eq" && c[1] === "effective_month" && c[2] === `${f.month}-01`,
    ),
  );
});
test("Daily costs preserve nulls and cannot allocate another client's station expenses", () => {
  const { pc, snap } = dailyFixture();
  snap.daily_costs = [
    { station_code: "KOZA", work_date: "2026-08-01", total: "500" },
  ];
  let days = performance.buildDailyRows(
    snap,
    "KOZA",
    "Amazon",
    pc,
    "2026-08",
    "2026-08-02",
    false,
  );
  assert.equal(days[0].profit, "580.00");
  assert.equal(days[1].profit, null);
  days = performance.buildDailyRows(
    snap,
    "KOZA",
    "Amazon",
    pc,
    "2026-08",
    "2026-08-02",
    true,
  );
  assert.ok(days.every((d) => d.cost === null && d.profit === null));
});
test("Corrected source counts change live estimates without adding a second copy", () => {
  const { pc, snap } = dailyFixture();
  snap.daily_shipments[1].deliveries = "200";
  const days = performance.buildDailyRows(
    snap,
    "KOZA",
    "Amazon",
    pc,
    "2026-08",
    "2026-08-02",
    false,
  );
  assert.equal(days[1].variable, "2000.00");
  assert.equal(days.length, 2);
});

test("Daily CSV contains only the selected authorized allocation and reconciles to MTD", async () => {
  const { pc, snap } = dailyFixture();
  const f = { ...filters, through: "2026-08-02" };
  const rows = performance.buildBusinessRows(snap, [pc], [location], f);
  const route = compile("../../app/finance/business/export/route.ts", {
    "next/server": {
      NextResponse: { json: (v, o) => new Response(JSON.stringify(v), o) },
    },
    "@/lib/finance/data": {
      financeContext: async (code) => {
        assert.equal(code, "finance_revenue");
        return {};
      },
      loadBusiness: async () => ({
        rows,
        filters: f,
        readAt: "2026-09-09T00:00:00Z",
      }),
    },
    "@/lib/finance/pricing": pricing,
    "@/lib/finance/performance": performance,
  });
  const response = await route.GET(
    new Request(
      "https://fin.dropxlogistics.com/finance/business/export?detail=daily&daily=KOZA&dailyClient=Amazon&month=2026-08",
    ),
  );
  const csv = pricing.parseCsv(await response.text());
  assert.equal(csv.length, 3);
  assert.ok(csv.slice(1).every((row) => row[0] === "KOZA"));
  const revenueIndex = csv[0].indexOf("Day revenue INR");
  assert.equal(
    pricing.addAmounts(csv.slice(1).map((row) => row[revenueIndex])),
    rows[0].revenue,
  );
  assert.match(
    response.headers.get("Content-Disposition"),
    /2026-08-daily.csv/,
  );
  assert.ok(!csv[0].includes("Recorded costs INR"));
  const denied = await route.GET(
    new Request(
      "https://fin.dropxlogistics.com/finance/business/export?detail=daily&daily=OUTSIDE&dailyClient=Amazon",
    ),
  );
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /No permitted allocation/);
});
test("Quantity display aggregation preserves fractional MG precision", () => {
  assert.equal(
    pricing.addQuantities([
      "100.1234567890123456789",
      "0.0000000000000000001",
      null,
    ]),
    "100.123456789012345679",
  );
  assert.equal(pricing.addQuantities([null]), null);
});
test("Flipkart daily changes reconcile through a monthly slab boundary", () => {
  const fc = { ...slabInput, id: "f1", revision: 1 };
  const snap = {
    ...snapshot,
    shipments: [{ ...shipment, client: "Flipkart", deliveries: "1001" }],
    daily_shipments: [
      {
        station_code: "KOZA",
        client: "Flipkart",
        work_date: "2026-08-01",
        deliveries: "1000",
      },
      {
        station_code: "KOZA",
        client: "Flipkart",
        work_date: "2026-08-02",
        deliveries: "1",
      },
    ],
  };
  const [r] = performance.buildBusinessRows(snap, [fc], [location], {
    ...filters,
    through: "2026-08-02",
  });
  assert.equal(r.daily[0].revenue, "10000.00");
  assert.equal(r.daily[1].revenue, "12.00");
  assert.equal(pricing.addAmounts(r.daily.map((d) => d.revenue)), r.revenue);
});

const xptLocation = {
  ...location,
  station_code: "KGQC",
  pricing_model: "xpt",
  parent_station_code: "KGQA",
};
const xptCard = {
  ...card,
  station_code: "KGQC",
  rates: {
    pricing_model: "xpt",
    parent_station_code: "KGQA",
    mg_amount_including_mhe: null,
    delivery_mg_volume: null,
    variable_slab: null,
  },
};
function xptFixture(fixed = null) {
  const parent = {
    ...card,
    station_code: "KGQA",
    rates: {
      ...base.rates,
      mg_amount_including_mhe: "3100",
      delivery_mg_volume: "310",
      variable_slab: "21",
      mfn_rate: "8",
    },
  };
  const child = {
    ...xptCard,
    rates: { ...xptCard.rates, mg_amount_including_mhe: fixed },
  };
  const snap = {
    shipments: [
      { ...shipment, station_code: "KGQA", deliveries: "40", days: 2 },
      { ...shipment, station_code: "KGQC", deliveries: "300", days: 2 },
    ],
    costs: [
      { ...cost, station_code: "KGQA", total: "100", days: 2 },
      { ...cost, station_code: "KGQC", total: "50", days: 2 },
    ],
    daily_shipments: [
      ...[1, 2].map((i) => ({
        ...shipment,
        station_code: "KGQA",
        work_date: `2026-08-0${i}`,
        deliveries: "20",
        mg_deliveries: "20",
        swa: "0",
        mfn: "0",
        smd: "0",
        ihs: "0",
      })),
      ...[1, 2].map((i) => ({
        ...shipment,
        station_code: "KGQC",
        work_date: `2026-08-0${i}`,
        deliveries: String(i * 100),
        mg_deliveries: String(i * 100),
        swa: "0",
        mfn: "0",
        smd: "0",
        ihs: "0",
      })),
    ],
    daily_costs: [],
  };
  const places = [
    { ...location, station_code: "KGQA", pricing_model: "mg" },
    xptLocation,
  ];
  return {
    parent,
    child,
    snap,
    places,
    f: { ...filters, through: "2026-08-02" },
  };
}
test("XPT fixed payout may be blank and its variable rate cannot override the parent", () => {
  const result = pricing.validatePricing({
    ...base,
    station_code: "KGQC",
    rates: {
      ...xptCard.rates,
      variable_slab: "999",
      delivery_mg_volume: "500",
    },
  });
  assert.equal(result.rates.mg_amount_including_mhe, null);
  assert.equal(result.rates.variable_slab, null);
  assert.equal(result.rates.delivery_mg_volume, null);
  assert.throws(() =>
    pricing.validatePricing({
      ...base,
      station_code: "KGQC",
      rates: { ...xptCard.rates, parent_station_code: "KGQC" },
    }),
  );
});
test("XPT pays on every eligible delivery, with blank fixed payout explicitly pending", () => {
  const { parent, child, snap, places, f } = xptFixture();
  const rows = performance.buildBusinessRows(snap, [parent, child], places, f);
  const xpt = rows.find((r) => r.station === "KGQC");
  assert.equal(xpt.revenue, "6300.00");
  assert.equal(xpt.variableRate, "21");
  assert.equal(xpt.pendingFixed, true);
  assert.ok(xpt.daily.every((d) => d.base === null));
  assert.match(xpt.issues.join(), /XPT fixed payout missing/);
  const group = performance.parentGroups(rows)[0];
  assert.equal(group.revenue, "6920.00");
  assert.equal(group.cost, "150.00");
  assert.equal(group.members.length, 2);
  assert.equal(pricing.addAmounts(rows.map((r) => r.revenue)), group.revenue);
});
test("Entering XPT fixed payout adds calendar accrual; parent rate edits flow through automatically", () => {
  const { parent, child, snap, places, f } = xptFixture("3100");
  const [xpt] = performance
    .buildBusinessRows(snap, [parent, child], places, f)
    .filter((r) => r.model === "xpt");
  assert.equal(xpt.revenue, "6500.00");
  assert.equal(xpt.pendingFixed, false);
  assert.equal(pricing.addAmounts(xpt.daily.map((d) => d.base)), "200.00");
  const [updated] = performance
    .buildBusinessRows(snap, [parent, child], places, f, {
      KGQA: { rate: "22", revision: 2 },
    })
    .filter((r) => r.model === "xpt");
  assert.equal(updated.revenue, "6800.00");
  assert.equal(updated.parentRateRevision, 2);
});
test("SWA is excluded from both parent MG excess and XPT variable earnings", () => {
  const { parent, child, snap, places, f } = xptFixture();
  snap.daily_shipments.forEach((d) => {
    d.swa = "5";
    d.mg_deliveries = String(Number(d.deliveries) - 5);
  });
  const rows = performance.buildBusinessRows(snap, [parent, child], places, f);
  assert.equal(rows.find((r) => r.station === "KGQA").revenue, "410.00");
  const xpt = rows.find((r) => r.station === "KGQC");
  assert.equal(xpt.revenue, "6090.00");
  assert.equal(xpt.swaDeliveries, "10");
  assert.equal(xpt.eligibleDeliveries, "290");
  assert.match(xpt.issues.join(), /SWA revenue pending/);
});
test("Missing Amazon count does not fall back to the total containing SWA", () => {
  const { parent, child, snap, places, f } = xptFixture();
  snap.daily_shipments.forEach((d) => {
    d.mg_deliveries = null;
    d.swa = "5";
  });
  const rows = performance.buildBusinessRows(snap, [parent, child], places, f);
  assert.equal(rows.find((r) => r.station === "KGQA").revenue, "200.00");
  assert.equal(rows.find((r) => r.station === "KGQC").revenue, null);
});
test("Parent selection can include XPTs, while standalone XPT and group exports remain scoped", () => {
  const { parent, child, snap, places, f } = xptFixture();
  assert.deepEqual(
    data
      .filterLocations(places, {
        ...f,
        region: "",
        cluster: "",
        location: "KGQA",
        includeXpts: "1",
      })
      .map((l) => l.station_code),
    ["KGQA", "KGQC"],
  );
  assert.deepEqual(
    data
      .filterLocations(places, {
        ...f,
        region: "",
        cluster: "",
        location: "KGQA",
        includeXpts: "0",
      })
      .map((l) => l.station_code),
    ["KGQA"],
  );
  const rows = performance.buildBusinessRows(snap, [parent, child], places, f);
  const scoped = rows.filter((r) => r.station === "KGQC");
  assert.deepEqual(
    performance.selectDailyRows(scoped, "group:KGQA").map((r) => r.station),
    ["KGQC"],
  );
  assert.equal(performance.selectDailyRows(scoped, "KGQA", "Amazon").length, 0);
});
test("XPT pricing writes reject a forged parent and allow a blank fixed payout for its real parent", async () => {
  const previous = writeContext;
  writeContext = { ...writeContext, locations: [xptLocation] };
  let r = await actions.savePricing([
    {
      ...base,
      station_code: "KGQC",
      rates: { ...xptCard.rates, parent_station_code: "OUTSIDE" },
    },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.error, /configured parent/);
  r = await actions.savePricing([
    { ...base, station_code: "KGQC", rates: xptCard.rates },
  ]);
  assert.equal(r.ok, true);
  writeContext = previous;
});

test("An XPT-only reader inherits the company/month-scoped parent rate without parent business data", async () => {
  const { child, snap } = xptFixture();
  const queries = [];
  const scopedDb = {
    from(table) {
      const steps = [["from", table]];
      queries.push(steps);
      const builder = new Proxy(
        {},
        {
          get(_target, key) {
            if (key === "then")
              return (resolve) => {
                const parentQuery = steps.some(
                  (s) =>
                    s[0] === "select" &&
                    s[1] === "id,station_code,revision,rates",
                );
                resolve({
                  data: parentQuery
                    ? [
                        {
                          id: "p2",
                          station_code: "KGQA",
                          revision: 2,
                          rates: {
                            variable_slab: "22",
                            mg_amount_including_mhe: "999999",
                          },
                        },
                        {
                          id: "p1",
                          station_code: "KGQA",
                          revision: 1,
                          rates: { variable_slab: "21" },
                        },
                      ]
                    : [child],
                  error: null,
                });
              };
            return (...args) => {
              steps.push([key, ...args]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
    async rpc(name, args) {
      assert.equal(name, "finance_business_daily_snapshot");
      assert.equal(args.p_company, "company-1");
      assert.deepEqual(args.p_station_codes, ["KGQC"]);
      return {
        data: {
          ...snap,
          shipments: snap.shipments.filter((r) => r.station_code === "KGQC"),
          costs: snap.costs.filter((r) => r.station_code === "KGQC"),
          daily_shipments: snap.daily_shipments.filter(
            (r) => r.station_code === "KGQC",
          ),
        },
        error: null,
      };
    },
  };
  const result = await data.loadBusiness(
    {
      authorization: auth,
      companyId: "company-1",
      locations: [xptLocation],
      db: scopedDb,
    },
    { month: "2026-08", through: "2026-08-02", location: "KGQC" },
  );
  assert.deepEqual(
    result.rows.map((r) => r.station),
    ["KGQC"],
  );
  assert.equal(result.rows[0].variableRate, "22");
  assert.equal(result.rows[0].parentRateRevision, 2);
  assert.equal(result.rows[0].mg, null);
  assert.equal(result.rows[0].revenue, "6600.00");
  for (const steps of queries) {
    assert.ok(
      steps.some(
        (s) => s[0] === "eq" && s[1] === "company_id" && s[2] === "company-1",
      ),
    );
    assert.ok(
      steps.some(
        (s) =>
          s[0] === "eq" && s[1] === "effective_month" && s[2] === "2026-08-01",
      ),
    );
  }
  const parentQuery = queries.find((steps) =>
    steps.some(
      (s) => s[0] === "select" && s[1] === "id,station_code,revision,rates",
    ),
  );
  assert.ok(
    parentQuery.some(
      (s) =>
        s[0] === "in" &&
        s[1] === "station_code" &&
        JSON.stringify(s[2]) === '["KGQA"]',
    ),
  );
  assert.ok(
    parentQuery.some(
      (s) => s[0] === "eq" && s[1] === "provider" && s[2] === "Amazon",
    ),
  );
});
