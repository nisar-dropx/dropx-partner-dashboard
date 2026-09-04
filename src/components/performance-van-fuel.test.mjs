import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const require = createRequire(import.meta.url),
  root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function load(file) {
  const m = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  new Function("require", "module", "exports", code)(
    (name) =>
      name.endsWith(".css")
        ? {}
        : name.startsWith("@/")
          ? load(resolve(root, name.slice(2) + ".ts"))
          : name.startsWith(".")
            ? load(resolve(dirname(file), name + ".ts"))
            : require(name),
    m,
    m.exports,
  );
  return m.exports;
}
const { FuelHistory, FuelVehicleTable } = load(
  resolve(root, "components/performance-van-fuel.tsx"),
);
const data = {
  station: "QA",
  date: "2026-09-14",
  available: true,
  latestCardDate: "2026-09-14",
  latestPortalDate: "2026-09-14",
  entries: [
    {
      id: "c1",
      date: "2026-09-01",
      source: "card",
      reference: "F1",
      provider: "IOC",
      vehicle: "KL11AB1234",
      amount: 100,
      litres: 1,
      note: "",
    },
    {
      id: "c2",
      date: "2026-09-02",
      source: "card",
      reference: "F2",
      provider: "IOC",
      vehicle: "KL11AB1234",
      amount: 1000,
      litres: 10,
      note: "",
    },
    {
      id: "c3",
      date: "2026-09-14",
      source: "card",
      reference: "F3",
      provider: "IOC",
      vehicle: "KL11AB1234",
      amount: 500,
      litres: 5,
      note: "",
    },
    {
      id: "p1",
      date: "2026-09-14",
      source: "portal",
      reference: "P1",
      provider: "Approved portal expense",
      vehicle: null,
      amount: 450,
      litres: null,
      note: "<script>unsafe()</script>",
    },
  ],
};
test("compact history starts with seven exact daily values, separate source/MTD totals and no chart", () => {
  const html = renderToStaticMarkup(createElement(FuelHistory, { data }));
  assert.equal((html.match(/<time /g) || []).length, 7);
  for (const value of [
    "₹500",
    "₹450",
    "₹1,600",
    "₹0",
    "MTD",
    "14 days",
    "Expand vehicle table",
  ])
    assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<svg|<form|<input|<script>/);
  assert.match(html, /&lt;script&gt;/);
});
test("vehicle table contains individual day amounts, blank vehicle bucket, period and MTD columns", () => {
  const html = renderToStaticMarkup(
    createElement(FuelVehicleTable, { data, period: 14 }),
  );
  for (const value of [
    "KL11AB1234",
    "Vehicle not recorded",
    "₹100",
    "₹1,000",
    "₹0",
    "₹1,600",
    "Period total",
    "MTD total",
    "Litres filled",
  ])
    assert.ok(html.includes(value), value);
  assert.match(html, /scroll for all dates/);
  assert.doesNotMatch(html, /<form|<input/);
});
test("fuel tables override the shared 880px minimum and stay in a bounded scrolling region", () => {
  const css = readFileSync(
    resolve(root, "app/ops-pulse/performance/review-fuel.css"),
    "utf8",
  );
  assert.match(css, /\.review-fuel-scroll table\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.review-fuel-scroll\s*\{[^}]*overflow:\s*auto/);
  const component = readFileSync(
    resolve(root, "components/performance-van-fuel.tsx"),
    "utf8",
  );
  assert.match(component, /if \(!data.available\) return null/);
  assert.match(component, /AbortController/);
  assert.match(component, /cache: "no-store"/);
  assert.doesNotMatch(component, /window\.open|location\.href/);
});
