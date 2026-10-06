import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function compile(path, dependencies = {}) {
  const module = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(name => { if (name in dependencies) return dependencies[name]; throw Error(name); }, module, module.exports);
  return module.exports;
}
const domain = compile("../../../../src/lib/ops-pulse/cps.ts");
const { connectCpsSummary } = compile("./connect-cps-summary.ts", { "../../../../src/lib/ops-pulse/cps": domain });
const day = (station_code, work_date, deliveries, total, overrides = {}) => ({
  station_code, work_date, deliveries, total, da: total, utr: 0, van: 0, other: 0, rent: 0,
  activity: deliveries, associate_rows: 1, unmapped: 0, unpaid: 0,
  shipment_present: true, utr_configured: true, target: 20, ...overrides,
});
const snapshot = daily => ({ daily, breakup: [], generated_at: "2026-10-06" });
const summarize = (data, places = [{ code: "A", name: "Station A" }]) => connectCpsSummary(data, places, "2026-09-01", "2026-09-30");

test("monthly CPS uses every day's cost and delivered volume, not the last day or mean of daily ratios", () => {
  const result = summarize(snapshot([day("A", "2026-09-01", 100, 1000), day("A", "2026-09-02", 10, 300)]));
  assert.equal(result.stations[0].value, 1300 / 110);
  assert.equal(result.stations[0].delivered, 110);
  assert.equal(result.value, 1300 / 110);
  assert.notEqual(result.value, 30);
});
test("portfolio CPS is delivery weighted and parent XPT is counted once", () => {
  const result = summarize(snapshot([day("A", "2026-09-01", 100, 1000), day("X", "2026-09-01", 10, 300), day("B", "2026-09-01", 1000, 5000)]),
    [{ code: "A", name: "A" }, { code: "X", name: "X", parent: "A", isXpt: true }, { code: "B", name: "B" }]);
  assert.equal(result.stations.length, 2);
  assert.equal(result.stations[0].value, 1300 / 110);
  assert.equal(result.value, 6300 / 1110);
});
test("child-only access never includes parent or sibling financial data", () => {
  const result = summarize(snapshot([day("A", "2026-09-01", 1000, 10000), day("X", "2026-09-01", 10, 300), day("Y", "2026-09-01", 100, 1000)]),
    [{ code: "X", name: "X", parent: "A", isXpt: true }]);
  assert.equal(result.stations[0].code, "A");
  assert.deepEqual(result.stations[0].members, ["X"]);
  assert.equal(result.value, 30);
  assert.match(result.stations[0].subtitle, /only in your access/);
});
test("cost and deliveries stop at each station's last reported day, preserving internal gaps", () => {
  const result = summarize(snapshot([
    day("A", "2026-08-31", 10, 900), day("A", "2026-09-01", 10, 100),
    day("A", "2026-09-02", 0, 50, { shipment_present: false }), day("A", "2026-09-03", 10, 100),
    day("A", "2026-09-04", 0, 50, { shipment_present: false }), day("A", "2026-10-01", 10, 900),
  ]));
  assert.equal(result.stations[0].value, 250 / 20);
  assert.equal(result.latestDate, "2026-09-03");
  assert.equal(result.stations[0].provisional, true);
});
test("missing shipments and zero deliveries cannot become a healthy zero CPS", () => {
  assert.equal(summarize(snapshot([day("A", "2026-09-01", 0, 50, { shipment_present: false })])).stations.length, 0);
  const result = summarize(snapshot([day("A", "2026-09-01", 0, 50)]));
  assert.equal(result.value, null);
  assert.equal(result.stations[0].value, null);
});
test("breakdown preserves all cost heads, flags missing group members, and excludes private evidence", () => {
  const result = summarize({ ...snapshot([day("A", "2026-09-01", 10, 210, { da: 50, utr: 40, van: 30, rent: 20, other: 60, overhead: 10 })]),
    staff: [{ name: "PRIVATE PERSON", monthly_ctc: 100000 }],
    gaps: [{ station_code: "A", kind: "Payment setup missing", first_date: "2026-09-01", last_date: "2026-09-30", name: "PRIVATE PERSON" }],
  }, [{ code: "A", name: "A" }, { code: "X", name: "X", isXpt: true, parent: "A" }]);
  assert.equal(result.stations[0].breakdown.reduce((sum, item) => sum + item.cps, 0), 21);
  assert.equal(result.stations[0].provisional, true);
  assert.equal(result.stations[0].issues.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE PERSON|monthly_ctc|100000|"cost":|"amount":/);
});
