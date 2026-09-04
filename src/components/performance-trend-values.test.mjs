import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const localRequire = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  vm.runInNewContext(code, { exports, Date, Intl, require: name => name.startsWith("@/")
    ? load(resolve(here, "..", name.slice(2) + ".ts"))
    : name.startsWith(".") ? load(resolve(dirname(file), name + ".ts")) : localRequire(name) });
  return exports;
}
const { PerformanceTrendValues, recordedTrendTotal } = load(resolve(here, "performance-trend-values.tsx"));
const points = Array.from({ length: 14 }, (_, i) => ({ date: `2026-09-${String(i+1).padStart(2,"0")}`, value: i === 13 ? null : i === 12 ? 0 : 100, note: i === 13 ? "No report" : "1 approved request" }));
const base = { key: "ad_hoc_van", unit: "money", label: "Ad-hoc van amount", points, note: "Approved requests" };
const render = (series = base, days = 7) => renderToStaticMarkup(createElement(PerformanceTrendValues, { series, days }));

test("first view renders exact daily amounts newest first, no graph", () => {
  const html = render();
  assert.match(html, /₹100/);
  assert.match(html, /₹0/);
  assert.match(html, /No data/);
  assert.match(html, /6\/7 days recorded/);
  assert.match(html, /7-day recorded total/);
  assert.match(html, /₹500/);
  assert.ok(html.indexOf('dateTime="2026-09-14"') < html.indexOf('dateTime="2026-09-08"'));
  assert.equal((html.match(/<time /g) || []).length, 7);
  assert.doesNotMatch(html, /<svg/);
});
test("14-day switch includes all values without changing source points", () => {
  const before = JSON.stringify(points), html = render(base, 14);
  assert.equal((html.match(/<time /g) || []).length, 14);
  assert.match(html, /₹1,200/);
  assert.equal(JSON.stringify(points), before);
});
test("missing selected day does not substitute an older amount; zero is recorded", () => {
  assert.match(render(), /14 Sept<\/small><strong>No data/);
  assert.equal(recordedTrendTotal(base, [{date:"2026-09-14",value:null}]), null);
  assert.equal(recordedTrendTotal(base, [{date:"2026-09-14",value:0}]), 0);
});
test("CPS, MTD amounts, percentages, allocation and clocks are never summed", () => {
  for (const key of ["daily_cps","mtd_cps","ad_hoc_van_mtd","ad_hoc_da_mtd","salary_da_cps","allocation","emd","arrival","afn_premium_dot"]) {
    assert.equal(recordedTrendTotal({...base,key}, points), null, key);
    assert.doesNotMatch(render({...base,key}), /recorded total/);
  }
});
test("only additive daily costs and deliveries get a recorded total", () => {
  for (const key of ["delivered","salary_da_cost","ad_hoc_van","ad_hoc_da","day_cost"])
    assert.equal(recordedTrendTotal({...base,key}, points), 1200, key);
});
test("percentages retain targets, missed state, and exact numeric values", () => {
  const html = render({...base,key:"emd",unit:"percent",target:95,direction:"higher",points:[{date:"2026-09-14",value:93.2}]});
  assert.match(html, /93.2%/);
  assert.match(html, /Off target/);
  assert.doesNotMatch(html, /recorded total/);
});
test("metric cards are history triggers while cost details keep their own action", () => {
  const desk = readFileSync(resolve(here,"performance-review-desk.tsx"),"utf8");
  assert.match(desk, /metric=\{metric.key\} label=\{metric.short\} variant="card"/);
  assert.equal((desk.match(/<TrendButton group="cost"/g) || []).length, 1);
  assert.match(desk, /snapshot.adHocVanRequests.map/);
  const trends = readFileSync(resolve(here,"performance-trends.tsx"),"utf8");
  assert.match(trends, /!expanded \? <PerformanceTrendValues/);
  assert.match(trends, /expanded && \(valid.length/);
  assert.match(trends, /Graph & details/);
});
