import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
const trends = compile("./review-trends.ts", {
  "./hawkeye": compile("./hawkeye.ts"),
  "./performance-source-policy": compile("./performance-source-policy.ts"),
});
const fuel = compile("./review-fuel.ts", { "./review-trends": trends });
const card = (date, amount = 100, rest = {}) => ({
  id: date,
  provider: "IOC",
  transaction_id: date,
  transaction_date: date,
  vehicle_no: "KL 11 AB 1234",
  amount,
  litres: 10,
  ...rest,
});
const portal = (date, amount = 200, rest = {}) => ({
  id: date,
  request_no: "P1",
  work_date: date,
  amount_requested: amount,
  ...rest,
});

test("7/14/MTD windows include selected day, reset at month start and validate dates", () => {
  assert.equal(fuel.fuelDates("2026-09-04", 7)[0], "2026-08-29");
  assert.equal(fuel.fuelDates("2026-09-04", 14)[0], "2026-08-22");
  assert.deepEqual(fuel.fuelDates("2026-09-04", "mtd"), [
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
  ]);
  assert.equal(fuel.fuelFromDate("2026-09-30"), "2026-09-01");
  assert.throws(() => fuel.fuelDates("2026-02-30", 7));
});
test("card and portal subtotals remain separate; duplicate imports only dedupe exact provider/reference", () => {
  const data = fuel.buildReviewFuel(
    "QA",
    "2026-09-04",
    [
      card("2026-09-01"),
      card("2026-09-01"),
      card("2026-09-01", 100, { provider: "BPCL" }),
    ],
    [portal("2026-09-01")],
    "2026-09-01",
  );
  assert.equal(data.entries.length, 3);
  const t = fuel.fuelTotals(data.entries);
  assert.equal(t.card, 200);
  assert.equal(t.portal, 200);
  assert.equal(t.litres, 20);
  assert.equal("combined" in t, false);
});
test("unknown vehicle and quantity remain unknown, zero day remains zero", () => {
  const data = fuel.buildReviewFuel(
    "QA",
    "2026-09-04",
    [card("2026-09-01", 500, { litres: 0 })],
    [portal("2026-09-01")],
    "2026-09-01",
  );
  assert.equal(data.entries.find((e) => e.source === "portal").vehicle, null);
  assert.equal(fuel.fuelTotals(data.entries).litres, null);
  assert.equal(fuel.fuelTotals(fuel.fuelInDates(data, ["2026-09-02"])).card, 0);
  assert.equal(
    data.entries.find((e) => e.source === "card").vehicle,
    "KL11AB1234",
  );
});
test("uses approved amount then actual amount then requested, preserves a zero override", () => {
  const data = fuel.buildReviewFuel(
    "QA",
    "2026-09-04",
    [],
    [
      portal("2026-09-03", 200, { amount: 199.88 }),
      portal("2026-09-04", 200, { amount_approved: 0, amount: 200 }),
    ],
    null,
  );
  assert.equal(fuel.fuelTotals(data.entries).portal, 199.88);
  assert.throws(() =>
    fuel.buildReviewFuel(
      "QA",
      "2026-09-04",
      [card("2026-09-01", "bad")],
      [],
      null,
    ),
  );
});
test("availability does not enable empty stations, future records do not bleed into past reviews", () => {
  assert.equal(
    fuel.buildReviewFuel("QA", "2026-09-04", [], [], null).available,
    false,
  );
  const data = fuel.buildReviewFuel(
    "QA",
    "2026-09-04",
    [card("2026-09-05")],
    [portal("2026-09-05"), portal("2026-07-01")],
    "2026-07-01",
  );
  assert.equal(data.available, true);
  assert.equal(data.entries.length, 0);
  assert.equal(data.latestPortalDate, "2026-07-01");
});
test("vehicle rows keep source separation and MTD entries outside seven-day window", () => {
  const data = fuel.buildReviewFuel(
    "QA",
    "2026-09-30",
    [card("2026-09-01", 100), card("2026-09-30", 1000)],
    [portal("2026-09-30", 200)],
    "2026-09-30",
  );
  const groups = fuel.fuelVehicleRows(data, fuel.fuelDates(data.date, 7));
  assert.equal(groups.length, 2);
  assert.equal(groups[0].entries.length, 2);
  assert.equal(
    fuel.fuelTotals(fuel.fuelInDates(data, fuel.fuelDates(data.date, 7))).card,
    1000,
  );
  assert.equal(
    fuel.fuelTotals(fuel.fuelInDates(data, fuel.fuelDates(data.date, "mtd")))
      .card,
    1100,
  );
});
test("loader scopes all sources by company and station, uses historical import mapping, and pages requests", async () => {
  const calls = [];
  const db = {
    from(table) {
      const ops = [];
      calls.push({ table, ops });
      const q = new Proxy(
        {},
        {
          get(_, key) {
            if (key === "then")
              return (ok) =>
                Promise.resolve(
                  ok({
                    data:
                      table === "payment_heads"
                        ? [{ id: "head" }]
                        : table === "payment_requests"
                          ? [
                              { ...portal("2026-09-04"), status: "APPROVED" },
                              { ...portal("2026-09-03"), status: "REJECTED" },
                            ]
                          : ops.some((o) => o[0] === "maybeSingle")
                            ? { transaction_date: "2026-09-04" }
                            : [card("2026-09-04")],
                    error: null,
                  }),
                );
            return (...args) => {
              ops.push([key, ...args]);
              return q;
            };
          },
        },
      );
      return q;
    },
  };
  const loader = compile("./review-fuel-data.ts", {
    "server-only": {},
    "@/lib/supabase-admin": { supabaseAdmin: db },
    "./review-trends-data": {
      readTrendPages: async (fn) => (await fn(0)).data,
    },
    "./performance-review": {
      isApprovedPayment: (r) => r.status === "APPROVED",
    },
    "./review-fuel": fuel,
  });
  const data = await loader.loadReviewFuel("COMPANY", "QA", "2026-09-04");
  assert.equal(data.entries.length, 2);
  for (const call of calls)
    assert.ok(
      call.ops.some(
        (o) => o[0] === "eq" && o[1] === "company_id" && o[2] === "COMPANY",
      ),
    );
  for (const call of calls.filter((c) => c.table === "cps_fuel_daily"))
    assert.ok(
      call.ops.some(
        (o) => o[0] === "eq" && o[1] === "station_code" && o[2] === "QA",
      ),
    );
  const p = calls.find((c) => c.table === "payment_requests");
  assert.ok(
    p.ops.some(
      (o) =>
        o[0] === "or" &&
        o[1] ===
          "station_code.eq.QA,and(station_code.is.null,location_code.eq.QA)",
    ),
  );
  assert.ok(p.ops.some((o) => o[0] === "range" && o[1] === 0 && o[2] === 999));
  assert.ok(!calls.some((c) => c.table === "fleet_vehicles"));
});
test("API rejects unauthenticated, unauthorized, malformed and out-of-scope reads before loading fuel", async () => {
  let auth = null,
    scope = { locations: [{ id: "station", station_code: "QA" }], error: null },
    loads = 0,
    fail = false;
  const route = compile("../../app/api/ops-pulse/performance/fuel/route.ts", {
    "@/lib/authorization": {
      getAuthorization: async () => auth,
      hasPermission: (a) => a.allowed,
    },
    "@/lib/company-scope": { requireCompanyId: (a) => a.companyId },
    "@/lib/ops-pulse/cod": { loadCodLocations: async () => scope },
    "@/lib/ops-pulse/review-trends": trends,
    "@/lib/ops-pulse/review-fuel-data": {
      loadReviewFuel: async (company, station, date) => {
        loads++;
        if (fail) throw Error("DB down");
        return { company, station, date };
      },
    },
  });
  const get = (query = "station=QA&date=2026-09-04") =>
    route.GET(new Request(`https://example.test/api/fuel?${query}`));
  assert.equal((await get()).status, 403);
  auth = { allowed: false };
  assert.equal((await get()).status, 403);
  auth = {
    allowed: true,
    companyId: "COMPANY",
    locationScopeIds: ["station"],
    hasAllLocationAccess: false,
  };
  for (const query of [
    "station=QA&date=2026-02-30",
    "station=QA&station=OTHER&date=2026-09-04",
    "station=QA,OTHER&date=2026-09-04",
    "station=QA&date=2026-09-04&group=cost",
  ])
    assert.equal((await get(query)).status, 400);
  assert.equal((await get("station=OTHER&date=2026-09-04")).status, 403);
  assert.equal(loads, 0);
  const ok = await get();
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await ok.json(), {
    company: "COMPANY",
    station: "QA",
    date: "2026-09-04",
  });
  fail = true;
  const failed = await get();
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error, /retry/);
});
