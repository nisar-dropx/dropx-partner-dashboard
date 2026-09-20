import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const module = { exports: {} };
new Function(
  "exports",
  "module",
  ts.transpileModule(
    readFileSync(new URL("./cps.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
)(module.exports, module);
const { cpsPeriod, cpsView, ratio, summarizeCps, validateCostInput, groupCps } =
  module.exports;
const day = {
  station_code: "A",
  work_date: "2026-09-01",
  deliveries: 100,
  activity: 110,
  associate_rows: 2,
  unmapped: 0,
  unpaid: 0,
  da: 900,
  utr: 100,
  van: 200,
  other: 300,
  rent: 100,
  total: 1500,
  target: 20,
  shipment_present: true,
  utr_configured: true,
  updated_at: null,
};
test("daily, MTD and calendar month have exact date boundaries", () => {
  assert.deepEqual(
    cpsPeriod({ view: "daily", date: "2026-09-08" }, "2026-09-11"),
    {
      mode: "daily",
      date: "2026-09-08",
      month: "2026-09",
      from: "2026-09-08",
      to: "2026-09-08",
      days: 1,
    },
  );
  assert.equal(
    cpsPeriod({ view: "mtd", date: "2026-09-08" }, "2026-09-11").from,
    "2026-09-01",
  );
  assert.equal(
    cpsPeriod({ view: "monthly", month: "2024-02" }, "2026-09-11").to,
    "2024-02-29",
  );
  assert.equal(
    cpsPeriod({ view: "monthly", month: "2026-09" }, "2026-09-11").to,
    "2026-09-11",
  );
  assert.equal(cpsPeriod({}, "2026-10-01").from, "2026-09-01");
});
test("future and malformed dates never drive the latest view", () => {
  for (const date of ["2026-12-07", "2026-02-30", "bad"])
    assert.equal(cpsPeriod({ date }, "2026-09-11").date, "2026-09-10");
  assert.equal(cpsView("__proto__"), "overview");
  assert.equal(cpsView("mtd"), "mtd");
});
test("CPS and target are weighted from numerators, never daily averages", () => {
  const summary = summarizeCps([
    day,
    {
      ...day,
      deliveries: 900,
      total: 27000,
      da: 27000,
      utr: 0,
      van: 0,
      other: 0,
      target: 30,
    },
  ]);
  assert.equal(summary.cps, 28.5);
  assert.equal(summary.target, 29);
  assert.equal(summary.gap, -0.5);
  assert.equal(summary.impact, -500);
});
test("zero denominators and missing targets stay unavailable", () => {
  assert.equal(ratio(100, 0), null);
  assert.equal(summarizeCps([{ ...day, deliveries: 0 }]).cps, null);
  assert.equal(summarizeCps([day, { ...day, target: null }]).target, null);
});
test("missing shipments, missing staff and unmapped pay remain provisional", () => {
  for (const field of [
    { unmapped: 1 },
    { unpaid: 1 },
    { shipment_present: false },
    { utr_configured: false },
  ])
    assert.equal(summarizeCps([{ ...day, ...field }]).provisional, true);
  assert.equal(summarizeCps([day]).provisional, false);
});
test("cost amounts sum once: Other already contains rent", () => {
  const summary = summarizeCps([day]);
  assert.equal(
    summary.total,
    summary.da + summary.utr + summary.van + summary.other,
  );
  assert.equal(summary.total, 1500);
  assert.equal(
    groupCps([day, { ...day, station_code: "B" }], (r) => r.station_code)
      .length,
    2,
  );
});
const input = {
  label: "UTR staff",
  head: "UTR",
  station_codes: "A,B",
  amount: "30000.00",
  frequency: "monthly",
  allocation: "delivery_share",
  effective_from: "2026-09-01",
};
test("cost input requires exact permitted scope and real date", () => {
  assert.deepEqual(validateCostInput(input, ["A", "B"]).station_codes, [
    "A",
    "B",
  ]);
  assert.throws(() => validateCostInput(input, ["A"]), /access/);
  assert.throws(
    () =>
      validateCostInput({ ...input, effective_from: "2026-02-30" }, ["A", "B"]),
    /period/,
  );
  assert.throws(
    () => validateCostInput({ ...input, amount: "" }, ["A", "B"]),
    /amount/,
  );
  assert.throws(
    () => validateCostInput({ ...input, amount: "NaN" }, ["A", "B"]),
    /amount/,
  );
  assert.equal(
    validateCostInput({ ...input, amount: "0" }, ["A", "B"]).amount,
    0,
  );
});
test("cost input preserves zero and disabled status, rejects bad periods", () => {
  assert.equal(
    validateCostInput({ ...input, is_active: false }, ["A", "B"]).is_active,
    false,
  );
  assert.throws(
    () =>
      validateCostInput(
        { ...input, frequency: "once", effective_to: "2026-09-03" },
        ["A", "B"],
      ),
    /One-off/,
  );
  assert.throws(
    () =>
      validateCostInput({ ...input, effective_to: "2026-08-31" }, ["A", "B"]),
    /period/,
  );
});
