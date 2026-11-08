import test from "node:test";
import assert from "node:assert/strict";
import { orderEodCReturnRows, orderEodDotRows, orderEodDsrRows } from "./lm-eod-order.ts";

test("EOD DSR is ordered by unresolved shipments descending", () => {
  const rows = orderEodDsrRows([
    { Station: "BEST", Assigned: 100, Delivered: 99, "Delivery failed": 1 },
    { Station: "WORST", Assigned: 100, Delivered: 70, "Delivery failed": 10 },
    { Station: "MID", Assigned: 100, Delivered: 80, "Delivery failed": 20 },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["WORST", "MID", "BEST"]);
});

test("EOD DOT is ordered by eligible but undelivered descending", () => {
  const rows = orderEodDotRows([
    { Station: "LOW", Eligible: 50, Delivered: 45, "At station": 1 },
    { Station: "HIGH", Eligible: 80, Delivered: 20, "At station": 40 },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["HIGH", "LOW"]);
});

test("EOD C-return is ordered by pending pickup descending", () => {
  const rows = orderEodCReturnRows([
    { Station: "CLEAR", Total: 50, "Pending pickup": 0 },
    { Station: "PENDING", Total: 20, "Pending pickup": 12 },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["PENDING", "CLEAR"]);
});
