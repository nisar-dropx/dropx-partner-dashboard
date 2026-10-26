import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBucketTrends,
  buildPersonActivity,
  buildStoreContinuity,
  datesInInclusiveRange,
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

test("datesInInclusiveRange is inclusive and swaps inverted bounds", () => {
  assert.deepEqual(datesInInclusiveRange("2026-10-24", "2026-10-26"), [
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
  ]);
  assert.deepEqual(datesInInclusiveRange("2026-10-26", "2026-10-24"), [
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
  ]);
  assert.deepEqual(datesInInclusiveRange("", "2026-10-24"), []);
});

test("buildStoreContinuity marks missing slots and empty stores", () => {
  const board = buildStoreContinuity({
    stores: [
      { id: "s1", station_code: "TCD4" },
      { id: "s2", station_code: "TTB3" },
    ],
    rows: [
      {
        id: "c1",
        location_id: "s1",
        store_code: "TCD4",
        shift_date: "2026-10-26",
        shift_slot: "06:00",
        status: "accepted",
        pct: 100,
        outgoing_name: "A",
      },
      {
        id: "c2",
        location_id: "s1",
        store_code: "TCD4",
        shift_date: "2026-10-26",
        shift_slot: "22:00",
        status: "open",
        pct: 20,
        staleOpen: true,
        outgoing_name: "B",
      },
    ],
    slots: ["06:00", "22:00"],
    from: "2026-10-26",
    to: "2026-10-26",
  });
  assert.equal(board.expected, 4);
  assert.equal(board.covered, 2);
  assert.equal(board.missing, 2);
  assert.equal(board.stores.length, 2);
  const tcd4 = board.stores.find((s) => s.storeCode === "TCD4");
  const ttb3 = board.stores.find((s) => s.storeCode === "TTB3");
  assert.equal(tcd4?.health, "at_risk");
  assert.equal(tcd4?.stale, 1);
  assert.equal(tcd4?.accepted, 1);
  assert.equal(ttb3?.health, "empty");
  assert.equal(ttb3?.missing, 2);
});

test("buildStoreContinuity prefers accepted over cancelled duplicate", () => {
  const board = buildStoreContinuity({
    stores: [{ id: "s1", station_code: "TCD4" }],
    rows: [
      {
        id: "gone",
        location_id: "s1",
        store_code: "TCD4",
        shift_date: "2026-10-26",
        shift_slot: "06:00",
        status: "cancelled",
        pct: 0,
      },
      {
        id: "ok",
        location_id: "s1",
        store_code: "TCD4",
        shift_date: "2026-10-26",
        shift_slot: "06:00",
        status: "accepted",
        pct: 100,
      },
      {
        id: "night",
        location_id: "s1",
        store_code: "TCD4",
        shift_date: "2026-10-26",
        shift_slot: "22:00",
        status: "accepted",
        pct: 100,
      },
    ],
    slots: ["06:00", "22:00"],
    from: "2026-10-26",
    to: "2026-10-26",
  });
  assert.equal(board.stores[0]?.health, "continuous");
  assert.equal(board.stores[0]?.continuityPct, 100);
  assert.equal(
    board.stores[0]?.cells.find((c) => c.slot === "06:00")?.checklistId,
    "ok",
  );
});

test("buildStoreContinuity marks broken when a slot is missing", () => {
  const board = buildStoreContinuity({
    stores: [{ id: "s1", station_code: "TCD4" }],
    rows: [
      {
        id: "c1",
        location_id: "s1",
        store_code: "TCD4",
        shift_date: "2026-10-26",
        shift_slot: "06:00",
        status: "submitted",
        pct: 90,
      },
    ],
    slots: ["06:00", "22:00"],
    from: "2026-10-26",
    to: "2026-10-26",
  });
  assert.equal(board.stores[0]?.health, "broken");
  assert.equal(board.brokenStores, 1);
});
