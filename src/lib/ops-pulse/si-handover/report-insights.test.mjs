import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBucketTrends,
  buildPersonActivity,
  formatQuietLabel,
  formatTrendDelta,
} from "./report-insights.ts";

test("applies avgPct trend deltas by bucket key", () => {
  const current = [{ key: "a", avgPct: 80, trendDelta: null }];
  const prior = [{ key: "a", avgPct: 60, trendDelta: null }];
  const out = applyBucketTrends(current, prior);
  assert.equal(out[0].trendDelta, 20);
  assert.equal(formatTrendDelta(20), "Trend ↑ +20%");
  assert.equal(formatTrendDelta(-5), "Trend ↓ -5%");
  assert.equal(formatTrendDelta(0), "Trend · flat");
  assert.equal(formatTrendDelta(null), null);
});

test("empty prior buckets leave trend null", () => {
  const current = [{ key: "a", avgPct: 70, trendDelta: null }];
  const out = applyBucketTrends(current, []);
  assert.equal(out[0].trendDelta, null);
});

test("summarises person activity completed / open / missed", () => {
  const activity = buildPersonActivity([
    {
      id: "1",
      store_code: "S1",
      shift_date: "2026-10-20",
      shift_slot: "06:00",
      status: "accepted",
      personKey: "u1",
      personLabel: "Alex",
      started_at: "2026-10-20T01:00:00Z",
      updated_at: "2026-10-20T03:00:00Z",
      submitted_at: "2026-10-20T02:30:00Z",
      accepted_at: "2026-10-20T03:00:00Z",
      pct: 100,
      staleOpen: false,
    },
    {
      id: "2",
      store_code: "S1",
      shift_date: "2026-10-21",
      shift_slot: "06:00",
      status: "open",
      personKey: "u1",
      personLabel: "Alex",
      started_at: "2026-10-21T01:00:00Z",
      updated_at: "2026-10-21T01:05:00Z",
      submitted_at: null,
      pct: 10,
      staleOpen: true,
    },
  ]);
  assert.equal(activity.length, 1);
  assert.equal(activity[0].completed, 1);
  assert.equal(activity[0].missed, 1);
  assert.equal(activity[0].open, 0);
  assert.ok(activity[0].lastCompletedAt);
  assert.equal(formatQuietLabel(90), "1h 30m quiet");
});
