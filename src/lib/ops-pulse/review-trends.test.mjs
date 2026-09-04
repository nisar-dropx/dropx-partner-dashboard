import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
function compile(path, mocks = {}) {
  const m = { exports: {} };
  const source = ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function("require", "exports", "module", source)(
    (n) => (n in mocks ? mocks[n] : require(n)),
    m.exports,
    m,
  );
  return m.exports;
}
const hawkeye = compile("./hawkeye.ts"),
  policy = compile("./performance-source-policy.ts");
const t = compile("./review-trends.ts", {
  "./hawkeye": hawkeye,
  "./performance-source-policy": policy,
});
test("seven/fourteen calendar days are inclusive, ordered and cross months/years correctly", () => {
  assert.deepEqual(t.trendDates("2026-01-03", 7), [
    "2025-12-28",
    "2025-12-29",
    "2025-12-30",
    "2025-12-31",
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
  ]);
  assert.equal(t.trendDates("2026-09-03").length, 14);
  for (const date of ["2026-02-30", "not-date", "2026-2-1"])
    assert.throws(() => t.trendDates(date));
});
test("reject duplicate parameters and unknown groups before querying data", () => {
  for (const query of [
    "station=AWEZ&date=2026-09-03&group=x",
    "station=AWEZ&station=ERSE&date=2026-09-03&group=cost",
    "station=AWEZ&date=2026-02-30&group=cost",
    "station=AWEZ,ERSE&date=2026-09-03&group=cost",
  ])
    assert.throws(() => t.readTrendQuery(new URLSearchParams(query)));
  assert.equal(
    t.readTrendQuery(
      new URLSearchParams("station=AWEZ&date=2026-09-03&group=cost"),
    ).group,
    "cost",
  );
});
test("Hawkeye keeps zero, leaves gaps, uses latest upload and never falls back to EDSP", () => {
  const facts = [
    {
      id: "old",
      source_type: "amazon_hawkeye_daily",
      created_at: "2026-09-01",
      report_date: "2026-08-31",
      values_json: { metrics: { "AFN Prem DOT%": 0.99 } },
    },
    {
      id: "new",
      source_type: "amazon_hawkeye_daily",
      created_at: "2026-09-02",
      report_date: "2026-08-31",
      values_json: { metrics: { "AFN Prem DOT%": 0 } },
    },
    {
      source_type: "daily_edsp_metrics",
      created_at: "2026-09-03",
      report_date: "2026-09-01",
      values_json: { metrics: { "AFN Prem DOT%": 0.97 } },
    },
  ];
  const rows = t.performanceTrendSeries(["2026-08-31", "2026-09-01"], facts, [
    { metricKey: "afn_premium_dot", target: 0.955, direction: "higher" },
  ]);
  assert.equal(rows.length, 33);
  const dot = rows.find((s) => s.key === "afn_premium_dot");
  assert.deepEqual(
    dot.points.map((p) => p.value),
    [0, null],
  );
  assert.equal(dot.target, 95.5);
});
test("cost trend distinguishes absent cost data from recorded zero; allocation and CPS use delivery", () => {
  const dates = ["2026-09-01", "2026-09-02"],
    rows = t.costTrendSeries(
      dates,
      [{ work_date: dates[1], total_cost: 0, overall_cps: 0, da_pay_cost: 0 }],
      [
        { work_date: dates[0], delivered: 100, active_ids: 5 },
        { work_date: dates[1], delivered: 200, active_ids: 10 },
      ],
      [],
      [
        { work_date: dates[0], category: "Van", approved_amount: 1500 },
        { work_date: dates[0], category: "DA", approved_amount: 300 },
      ],
    );
  const values = (key) =>
    rows.find((s) => s.key === key).points.map((p) => p.value);
  assert.deepEqual(values("daily_cps"), [null, 0]);
  assert.deepEqual(values("salary_da_cps"), [null, 0]);
  assert.deepEqual(values("allocation"), [20, 20]);
  assert.deepEqual(values("ad_hoc_van"), [1500, 0]);
  assert.deepEqual(values("ad_hoc_van_cps"), [15, 0]);
  assert.match(
    rows.find((s) => s.key === "mtd_cps").points[1].note,
    /1 delivery days missing costs/,
  );
});
test("MTD totals reset per month and exclude future rows and ratio averaging", () => {
  const rows = t.costTrendSeries(
    ["2026-08-31", "2026-09-01", "2026-09-02"],
    [
      { work_date: "2026-08-31", total_cost: 1000, total_delivery: 100 },
      { work_date: "2026-09-01", total_cost: 400, total_delivery: 100 },
      { work_date: "2026-09-02", total_cost: 800, total_delivery: 300 },
      { work_date: "2026-09-03", total_cost: 9000, total_delivery: 1 },
    ],
    [],
    [],
    [
      { work_date: "2026-08-30", category: "Van", approved_amount: 50 },
      { work_date: "2026-09-01", category: "Van", approved_amount: 60 },
    ],
  );
  assert.deepEqual(
    rows.find((s) => s.key === "mtd_cps").points.map((p) => p.value),
    [10, 4, 3],
  );
  assert.deepEqual(
    rows.find((s) => s.key === "ad_hoc_van_mtd").points.map((p) => p.value),
    [50, 60, 60],
  );
});
test("unmapped salary days carry an explicit completeness warning", () => {
  const rows = t.costTrendSeries(
    ["2026-09-01"],
    [],
    [{ work_date: "2026-09-01", delivered: 10, active_ids: 1 }],
    [
      {
        work_date: "2026-09-01",
        provider_employee_id: "da",
        da_total_pay: 0,
        mapping_status: "UNMAPPED",
      },
    ],
    [],
  );
  assert.match(
    rows.find((s) => s.key === "salary_da_cps").points[0].note,
    /mapping gaps/,
  );
});
test("delivery fallback and salary precedence match the review card", () => {
  const date = "2026-09-01",
    rows = t.costTrendSeries(
      [date],
      [{ work_date: date, da_pay_cost: 600 }],
      [{ work_date: date, delivered: 0, active_ids: 0 }],
      [{ work_date: date, da_total_pay: 0, total_delivery: 4 }],
      [],
      [
        { work_date: date, driver_id: "a", package_count: 10 },
        { work_date: date, driver_id: "b", package_count: 20 },
      ],
    );
  const value = (key) => rows.find((s) => s.key === key).points[0].value;
  assert.equal(value("delivered"), 30);
  assert.equal(value("allocation"), 15);
  assert.equal(value("salary_da_cps"), 20);
});
test("chart breaks across gaps, preserves constant/zero data and includes target in scale", () => {
  const g = t.trendGeometry(
    [
      { date: "a", value: 0 },
      { date: "b", value: null },
      { date: "c", value: 4 },
    ],
    10,
  );
  assert.equal(g.segments.length, 2);
  assert.equal(g.max, 10);
  assert.equal(g.dots[1].y, null);
  assert.ok(
    Number.isFinite(t.trendGeometry([{ date: "a", value: 0 }]).dots[0].y),
  );
});
test("overnight timing is labelled next day and zero remains valid", () => {
  assert.equal(t.clockMinutes("2026-09-02T00:15:00+05:30", "2026-09-01"), 1455);
  assert.equal(t.formatTrendValue(1455, "time"), "00:15 (+1d)");
  assert.equal(t.formatTrendValue(null, "money"), "No data");
  assert.equal(t.formatTrendValue(0, "percent"), "0%");
});
function routeFixture({
  allowed = true,
  stationAllowed = true,
  scopeError = false,
  loadError = false,
} = {}) {
  const calls = [];
  const route = compile("../../app/api/ops-pulse/performance/trends/route.ts", {
    "@/lib/authorization": {
      getAuthorization: async () => ({
        locationScopeIds: ["station"],
        hasAllLocationAccess: false,
      }),
      hasPermission: () => allowed,
    },
    "@/lib/company-scope": { requireCompanyId: () => "company" },
    "@/lib/ops-pulse/cod": {
      loadCodLocations: async (...args) => {
        calls.push(["scope", ...args]);
        return {
          locations: stationAllowed
            ? [{ id: "station", station_code: "AWEZ" }]
            : [],
          error: scopeError ? "failed" : null,
        };
      },
    },
    "@/lib/ops-pulse/review-trends": t,
    "@/lib/ops-pulse/review-trends-data": {
      loadReviewTrends: async (...args) => {
        calls.push(["load", ...args]);
        if (loadError) throw Error("private DB error");
        return { station: "AWEZ", series: [] };
      },
    },
  });
  return { route, calls };
}
test("trend API enforces review permission and station scope before loading any values", async () => {
  for (const options of [
    { allowed: false },
    { stationAllowed: false },
    { scopeError: true },
  ]) {
    const f = routeFixture(options),
      r = await f.route.GET(
        new Request("https://test/api?station=AWEZ&date=2026-09-03&group=cost"),
      );
    assert.equal(r.status, options.scopeError ? 503 : 403);
    assert.ok(!f.calls.some((c) => c[0] === "load"));
  }
});
test("trend API returns private no-store data with validated company/station/date", async () => {
  const f = routeFixture(),
    r = await f.route.GET(
      new Request("https://test/api?station=AWEZ&date=2026-09-03&group=cost"),
    );
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual(f.calls.find((c) => c[0] === "load").slice(1), [
    "company",
    { id: "station", station_code: "AWEZ" },
    "2026-09-03",
    "cost",
  ]);
});
test("invalid date causes HTTP 400 without accessing station data", async () => {
  const f = routeFixture(),
    r = await f.route.GET(
      new Request("https://test/api?station=AWEZ&date=2026-02-30&group=cost"),
    );
  assert.equal(r.status, 400);
  assert.equal(f.calls.length, 0);
});
