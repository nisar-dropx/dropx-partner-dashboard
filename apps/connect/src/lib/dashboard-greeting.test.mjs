import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { dashboardGreeting } from "./dashboard-greeting.ts";

test("overnight, morning, noon and evening use the correct local-time greeting", () => {
  for (const [hour, minute, expected] of [
    [0, 0, "Hello"], [1, 49, "Hello"], [4, 59, "Hello"],
    [5, 0, "Good morning"], [11, 59, "Good morning"],
    [12, 0, "Good afternoon"], [16, 59, "Good afternoon"],
    [17, 0, "Good evening"], [23, 59, "Good evening"],
  ]) {
    const local = new Date(2026, 9, 10, hour, minute);
    assert.equal(dashboardGreeting(local.getHours()), expected, `${hour}:${minute}`);
  }
});

test("invalid clock values fall back to a neutral greeting", () => {
  for (const hour of [NaN, Infinity, -1, 24]) assert.equal(dashboardGreeting(hour), "Hello");
});

test("dashboard clock refreshes on activation, each minute, focus and browser wake; cleans up", () => {
  const updates = [];
  const effects = [];
  const windowHandlers = new Map();
  const documentHandlers = new Map();
  let interval;
  let cleared;
  const browser = {
    setInterval(callback, delay) { assert.equal(delay, 60_000); interval = callback; return 7; },
    clearInterval(id) { cleared = id; },
    addEventListener(event, callback) { windowHandlers.set(event, callback); },
    removeEventListener(event, callback) { assert.equal(windowHandlers.get(event), callback); windowHandlers.delete(event); },
  };
  const document = {
    visibilityState: "visible",
    addEventListener(event, callback) { documentHandlers.set(event, callback); },
    removeEventListener(event, callback) { assert.equal(documentHandlers.get(event), callback); documentHandlers.delete(event); },
  };
  const react = {
    useState(initial) { return [initial(), value => updates.push(value)]; },
    useEffect(effect, dependencies) { effects.push({ effect, dependencies }); },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL("./use-dashboard-clock.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", "window", "document", code)(name => {
    assert.equal(name, "react"); return react;
  }, module, module.exports, browser, document);

  const { useDashboardClock } = module.exports;
  assert.ok(useDashboardClock(true) instanceof Date);
  assert.deepEqual(effects[0].dependencies, [true]);
  const cleanup = effects[0].effect();
  assert.equal(updates.length, 1);
  interval();
  windowHandlers.get("focus")();
  documentHandlers.get("visibilitychange")();
  assert.equal(updates.length, 4);
  document.visibilityState = "hidden";
  documentHandlers.get("visibilitychange")();
  assert.equal(updates.length, 4);
  assert.ok(updates.every(date => date instanceof Date));
  cleanup();
  assert.equal(cleared, 7);
  assert.equal(windowHandlers.size, 0);
  assert.equal(documentHandlers.size, 0);

  useDashboardClock(false);
  assert.deepEqual(effects[1].dependencies, [false]);
  assert.equal(effects[1].effect(), undefined);
  assert.equal(updates.length, 4, "hidden keep-alive dashboards do not start clocks");
});

test("People and Workforce share the live clock and greeting without changing attendance data", () => {
  const source = readFileSync(new URL("../components/connect-dashboard.tsx", import.meta.url), "utf8");
  assert.match(source, /variant\?: "people" \| "workforce"/);
  assert.match(source, /const now = useDashboardClock\(active\)/);
  assert.match(source, /const greeting = dashboardGreeting\(now\.getHours\(\)\)/);
  assert.match(source, /<h1>\{greeting\}, \{firstName\}<\/h1>/);
  assert.doesNotMatch(source, /hour < 12 \? "Good morning"/);
});
