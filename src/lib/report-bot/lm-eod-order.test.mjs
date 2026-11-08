import test from "node:test";
import assert from "node:assert/strict";
import { orderEodCReturnRows, orderEodDotRows, orderEodDsrRows } from "./lm-eod-order.ts";

test("EOD DSR is ordered by DSR percentage descending", () => {
  const rows = orderEodDsrRows([
    { Station: "BEST", "DSR %": "99.0%" },
    { Station: "WORST", "DSR %": "70.0%" },
    { Station: "MID", "DSR %": "80.0%" },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["BEST", "MID", "WORST"]);
});

test("EOD DOT is ordered by DOT percentage descending", () => {
  const rows = orderEodDotRows([
    { Station: "LOW", "DOT %": "45.0%" },
    { Station: "HIGH", "DOT %": "90.0%" },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["HIGH", "LOW"]);
});

test("EOD C-return is ordered by pickup percentage descending", () => {
  const rows = orderEodCReturnRows([
    { Station: "CLEAR", "Pickup %": "100.0%" },
    { Station: "PENDING", "Pickup %": "40.0%" },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["CLEAR", "PENDING"]);
});

test("missing percentages sort last", () => {
  const rows = orderEodDsrRows([
    { Station: "NO DATA", "DSR %": "—" },
    { Station: "ACTIVE", "DSR %": "0.0%" },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["ACTIVE", "NO DATA"]);
});
