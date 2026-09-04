import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const source = ts.transpileModule(readFileSync(new URL("./performance-opening-card.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText;
const exported = {};
const localRequire = createRequire(import.meta.url);
vm.runInNewContext(source, { exports: exported, require: (name) => name === "@/components/performance-trends" ? { TrendButton: () => null } : localRequire(name), Date, Intl });
const snapshot = { firstPunchAt: "2026-09-03T02:30:00Z", firstPunchBy: "People Employee", openingLateMinutes: 0,
  scheduledOpeningTime: "08:00", openingShiftName: "Morning", openingShiftSource: "Approved roster",
  openingWindowStart: "02:00", openingWindowEnd: "10:00",
  openingFirstOtherPunch: { time: "2026-09-03T01:17:23Z", name: "Earlier Associate", profileLabel: "Delivery associate (DA)", workerCode: "DA123" } };
const render = (overrides = {}) => renderToStaticMarkup(createElement(exported.PerformanceOpeningCard, { snapshot: { ...snapshot, ...overrides } }));

test("card shows only People time/name; orange warning details identify the earlier DA", () => {
  const html = render(), summary = html.match(/<summary>(.*?)<\/summary>/s)[1];
  assert.match(html, /class="performance-fact-card opening opening-warning"/);
  assert.match(summary, /08:00/);
  assert.match(summary, /People Employee/);
  assert.doesNotMatch(summary, /06:47|Earlier Associate|DA123/);
  assert.match(html, /06:47/);
  assert.match(html, /Earlier Associate/);
  assert.match(html, /Delivery associate \(DA\)/);
});

test("late People punch remains red while the earlier non-People badge stays orange", () => {
  const html = render({ openingLateMinutes: 30 });
  assert.match(html, /class="performance-fact-card opening late"/);
  assert.match(html, /class="opening-warning">Earlier non-People punch/);
  assert.match(html, /class="late">30 min late/);
});

test("no People punch never substitutes the DA time or an on-time status", () => {
  const html = render({ firstPunchAt: null, firstPunchBy: null, openingLateMinutes: null });
  const summary = html.match(/<summary>(.*?)<\/summary>/s)[1];
  assert.match(summary, /<strong>—<\/strong>/);
  assert.match(summary, /No People opening punch/);
  assert.doesNotMatch(summary, /06:47|Earlier Associate|On time/);
  assert.match(html, /class="performance-fact-card opening opening-warning"/);
});

test("ordinary People opening retains on-time/late behavior without a non-People warning", () => {
  assert.match(render({ openingFirstOtherPunch: null }), /class="on-time">On time/);
  assert.doesNotMatch(render({ openingFirstOtherPunch: null }), /Earlier non-People punch/);
  assert.match(render({ openingFirstOtherPunch: null, openingLateMinutes: 20 }), /class="performance-fact-card opening late"/);
});
