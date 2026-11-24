import assert from "node:assert/strict";
import { describe, test } from "node:test";

/** Mirror of FILTERS in ds-live-view for smoke coverage without React. */
const FILTERS = {
  all: () => true,
  slowPpi: (row) => (row.avgPptSeconds ?? 0) >= 90 && row.orderCount > 0,
  stale: (row) => row.ppiStale || row.siteStale,
  acceptance: (row) => row.breachingCount > 0,
  inbound: (row) => row.inboundOpen > 0 && (row.inboundAvgPct == null || row.inboundAvgPct < 100)
};

describe("ds live performance filters", () => {
  test("empty network keeps all empty", () => {
    assert.deepEqual([].filter(FILTERS.all), []);
  });

  test("classifies slow / stale / acceptance / inbound stores", () => {
    const stores = [
      { stationCode: "A", avgPptSeconds: 120, orderCount: 10, ppiStale: false, siteStale: false, breachingCount: 0, inboundOpen: 0, inboundAvgPct: null },
      { stationCode: "B", avgPptSeconds: 40, orderCount: 5, ppiStale: true, siteStale: false, breachingCount: 0, inboundOpen: 0, inboundAvgPct: null },
      { stationCode: "C", avgPptSeconds: 40, orderCount: 5, ppiStale: false, siteStale: false, breachingCount: 2, inboundOpen: 0, inboundAvgPct: null },
      { stationCode: "D", avgPptSeconds: 40, orderCount: 5, ppiStale: false, siteStale: false, breachingCount: 0, inboundOpen: 1, inboundAvgPct: 40 },
      { stationCode: "E", avgPptSeconds: 40, orderCount: 0, ppiStale: false, siteStale: false, breachingCount: 0, inboundOpen: 1, inboundAvgPct: 100 }
    ];
    assert.deepEqual(stores.filter(FILTERS.slowPpi).map((r) => r.stationCode), ["A"]);
    assert.deepEqual(stores.filter(FILTERS.stale).map((r) => r.stationCode), ["B"]);
    assert.deepEqual(stores.filter(FILTERS.acceptance).map((r) => r.stationCode), ["C"]);
    assert.deepEqual(stores.filter(FILTERS.inbound).map((r) => r.stationCode), ["D"]);
    assert.equal(stores.filter(FILTERS.all).length, 5);
  });
});
