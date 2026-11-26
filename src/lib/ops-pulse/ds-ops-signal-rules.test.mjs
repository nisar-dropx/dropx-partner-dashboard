import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSignal, resolveSignalRule, defaultSignalRules } from "./ds-ops-signal-rules.ts";

test("resolveSignalRule prefers station override", () => {
  const rules = [
    { metric: "active_orders", baselineDays: 7, thresholdPct: 40, minSamples: 3, enabled: true, stationCode: null },
    { metric: "active_orders", baselineDays: 7, thresholdPct: 20, minSamples: 2, enabled: true, stationCode: "TCC3" }
  ];
  assert.equal(resolveSignalRule(rules, "active_orders", "TCC3")?.thresholdPct, 20);
  assert.equal(resolveSignalRule(rules, "active_orders", "TTB3")?.thresholdPct, 40);
});

test("evaluateSignal spikes when lift exceeds threshold", () => {
  const rule = defaultSignalRules()[0];
  const result = evaluateSignal(rule, { current: 20, samples: [10, 10, 10] });
  assert.equal(result.spiked, true);
  assert.ok((result.liftPct ?? 0) >= 40);
});

test("evaluateSignal waits for min samples", () => {
  const rule = { ...defaultSignalRules()[0], minSamples: 5 };
  const result = evaluateSignal(rule, { current: 100, samples: [1, 1] });
  assert.equal(result.spiked, false);
  assert.match(result.reason, /Need 5/);
});
