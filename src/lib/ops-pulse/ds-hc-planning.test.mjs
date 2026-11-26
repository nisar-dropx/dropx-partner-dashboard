import test from "node:test";
import assert from "node:assert/strict";
import { planHourlyHc, resolveHcTarget, summarizeHcPlan } from "./ds-hc-planning.ts";

test("planHourlyHc divides demand by productivity target", () => {
  const rows = planHourlyHc({
    demand: [
      { hour: 10, orderCount: 24 },
      { hour: 11, orderCount: 0 },
      { hour: 12, orderCount: 13 }
    ],
    target: { stationCode: null, ordersPerAssociateHour: 12, targetPptSeconds: 90, enabled: true },
    rosteredByHour: { 10: 1, 12: 2 }
  });
  assert.equal(rows.find((r) => r.hour === 10)?.requiredHc, 2);
  assert.equal(rows.find((r) => r.hour === 10)?.variance, -1);
  assert.equal(rows.find((r) => r.hour === 11)?.requiredHc, 0);
  assert.equal(rows.find((r) => r.hour === 12)?.requiredHc, 2);
  assert.equal(rows.find((r) => r.hour === 12)?.variance, 0);
});

test("resolveHcTarget prefers station", () => {
  const t = resolveHcTarget(
    [
      { stationCode: null, ordersPerAssociateHour: 12, targetPptSeconds: 90, enabled: true },
      { stationCode: "TCC3", ordersPerAssociateHour: 8, targetPptSeconds: 90, enabled: true }
    ],
    "TCC3"
  );
  assert.equal(t.ordersPerAssociateHour, 8);
});

test("summarizeHcPlan reports peak and understaffed hours", () => {
  const summary = summarizeHcPlan([
    { hour: 10, orderCount: 24, requiredHc: 2, rosteredHc: 1, variance: -1 },
    { hour: 11, orderCount: 12, requiredHc: 1, rosteredHc: 2, variance: 1 }
  ]);
  assert.equal(summary.peakRequired, 2);
  assert.equal(summary.understaffedHours, 1);
  assert.equal(summary.totalOrders, 36);
});
