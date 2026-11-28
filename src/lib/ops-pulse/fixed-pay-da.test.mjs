import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);

function compile(path, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "exports", "module", code)(
    (name) => (name in mocks ? mocks[name] : require(name)),
    module.exports,
    module
  );
  return module.exports;
}

const math = compile("./fixed-pay-da-math.ts", {
  "./cps": { cpsShipmentCount: (deliveries, customerReturns = 0) => Number(deliveries || 0) + Number(customerReturns || 0) },
  "./cps-details": {}
});

test("salary-only CPS uses the cohort's own shipments", () => {
  assert.equal(math.fixedPaySalary({ salary: 2000, variable: 500, fuel: 100 }), 2000);
  assert.equal(math.fixedPayShipments({ deliveries: 80, customer_returns: 20 }), 100);
  assert.equal(math.fixedPayCps(2000, 100), 20);
});

test("pending days do not null the station CPS", () => {
  assert.equal(math.fixedPayCps(1500, 50), 30);
});

test("empty stations are kept and variable/fuel are excluded", () => {
  const stations = math.projectFixedPayDaStations(
    [
      { id: "1", station_code: "A", station_name: "Alpha", region: "South", cluster_manager: "CM", aom: null },
      { id: "2", station_code: "B", station_name: "Beta", region: "South", cluster_manager: "CM", aom: null }
    ],
    [
      {
        worker_id: "w1",
        dropx_id: "D1",
        name: "Fixed DA",
        station_code: "A",
        cohort: "guarantee",
        provider_ids: ["P1"],
        work_dates: ["2026-11-01"],
        cost_dates: ["2026-11-01"],
        work_bases: ["attendance"],
        periods: [],
        deliveries: 40,
        customer_returns: 0,
        seller_pickups: 0,
        seller_returns: 0,
        salary: 1200,
        variable: 300,
        fuel: 50,
        van: 0
      },
      {
        worker_id: "w2",
        dropx_id: "D2",
        name: "Variable DA",
        station_code: "A",
        cohort: "variable",
        provider_ids: ["P2"],
        work_dates: ["2026-11-01"],
        cost_dates: ["2026-11-01"],
        work_bases: ["attendance"],
        periods: [],
        deliveries: 100,
        customer_returns: 0,
        seller_pickups: 0,
        seller_returns: 0,
        salary: 0,
        variable: 800,
        fuel: 0,
        van: 0
      }
    ]
  );
  assert.equal(stations.length, 2);
  assert.equal(stations[0].code, "A");
  assert.equal(stations[0].salary, 1200);
  assert.equal(stations[0].shipments, 40);
  assert.equal(stations[0].cps, 30);
  assert.equal(stations[1].code, "B");
  assert.equal(stations[1].salary, 0);
  assert.equal(stations[1].cps, null);
});
