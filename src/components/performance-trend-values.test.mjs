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
const { PerformanceTrendValues, TrendPointRequestDetails, recordedTrendTotal, trendPeriodPoints } = load(resolve(here, "performance-trend-values.tsx"));
const points = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-09-${String(i+1).padStart(2,"0")}`,
  value: i === 13 ? null : i === 12 ? 0 : 100,
  note: i === 13 ? "No report" : "1 van · 500 total delivered · 90 van shipments",
  context: {
    vanCount: i === 13 ? 0 : 1,
    delivered: 500,
    adHocVanShipments: i === 13 ? 0 : 90,
    requests: i === 12 ? [{ requestNo: "PAY-13", amount: 0, reason: "Peak load", remarks: "Extra route", fields: [{ label: "Vehicle number", value: "KL11AX1234" }] }] : [],
  },
}));
const base = { key: "ad_hoc_van", unit: "money", label: "Ad-hoc van amount", points, note: "Approved requests" };
const render = (series = base, period = 7, endDate = "2026-09-14") => renderToStaticMarkup(createElement(PerformanceTrendValues, { series, period, endDate }));

test("first view renders exact daily amounts newest first, no graph", () => {
  const html = render();
  assert.match(html, /₹100/);
  assert.match(html, /₹0/);
  assert.match(html, /No data/);
  assert.match(html, /6\/7 days recorded/);
  assert.match(html, /7-day recorded total/);
  assert.match(html, /₹500/);
  assert.match(html, /role="columnheader">Amount/);
  assert.match(html, /class="review-history-value-amount" role="cell" aria-label="13 Sept: ₹0"><strong>₹0/);
  assert.match(html, /class="review-history-value-amount" role="cell" aria-label="12 Sept: ₹100"><strong>₹100/);
  assert.match(html, /6<\/strong> vans/);
  assert.match(html, /3,500<\/strong> delivered/);
  assert.match(html, /540<\/strong> van shipments/);
  assert.match(html, /1 van · 500 total delivered · 90 van shipments/);
  assert.ok(html.indexOf('dateTime="2026-09-14"') < html.indexOf('dateTime="2026-09-08"'));
  assert.equal((html.match(/<time /g) || []).length, 7);
  assert.doesNotMatch(html, /<svg/);
});
test("expanded ad-hoc van detail shows request reason, remarks and operational fields", () => {
  const html = renderToStaticMarkup(createElement(TrendPointRequestDetails, { series: base, point: points[12] }));
  assert.match(html, /PAY-13/);
  assert.match(html, /Peak load/);
  assert.match(html, /Extra route/);
  assert.match(html, /Vehicle number/);
  assert.match(html, /KL11AX1234/);
  assert.doesNotMatch(html, /approved request/i);
});
test("daily values use scoped grid rows so global table styles cannot hide amounts", () => {
  const css = readFileSync(resolve(here, "../app/ops-pulse/performance/review-trends.css"), "utf8");
  assert.match(css, /\.review-history-value-row\s*\{[^}]*display:\s*grid/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(110px,\s*40%\)/);
  assert.match(css, /\.review-history-value-amount strong\s*\{[^}]*visibility:\s*visible/);
  assert.doesNotMatch(render(), /<table/);
});
test("14-day switch includes all values without changing source points", () => {
  const before = JSON.stringify(points), html = render(base, 14);
  assert.equal((html.match(/<time /g) || []).length, 14);
  assert.match(html, /₹1,200/);
  assert.equal(JSON.stringify(points), before);
});
test("MTD includes every available current-month day through the selected date", () => {
  const extended = Array.from({ length: 20 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, value: 100 }));
  assert.equal(trendPeriodPoints(extended, "mtd", "2026-09-20").length, 20);
  const html = render({ ...base, points: extended }, "mtd", "2026-09-20");
  assert.equal((html.match(/<time /g) || []).length, 20);
  assert.match(html, /MTD recorded total/);
  assert.match(html, /₹2,000/);
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
  assert.equal((desk.match(/<CostTrendCard metric=/g) || []).length, 6);
  for (const metric of ["salary_da_cps", "ad_hoc_van", "ad_hoc_da", "daily_cps", "mtd_cps", "allocation"])
    assert.match(desk, new RegExp(`metric="${metric}"`));
  assert.match(desk, /Click a card for its 7-day, 14-day or MTD history/);
  assert.match(desk, /snapshot.adHocVanRequests.map/);
  const trends = readFileSync(resolve(here,"performance-trends.tsx"),"utf8");
  assert.match(trends, /!expanded \? <PerformanceTrendValues/);
  assert.match(trends, /expanded && \(valid.length/);
  assert.match(trends, /Graph & details/);
});
