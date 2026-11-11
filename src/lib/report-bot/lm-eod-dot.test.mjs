import test from "node:test";
import assert from "node:assert/strict";
import { eodDotRow, eodDotTotalRow, EOD_DOT_VISIBLE_COLUMNS } from "./lm-eod-dot.ts";

const totals = (total, delivered, atStation = 0) => ({
  total,
  delivered,
  atStation,
  dispatched: delivered,
  oor: 0,
  failed: 0,
  rejected: 0,
  other: Math.max(0, total - delivered - atStation),
  dotPct: total ? delivered / total * 100 : 0,
});

test("DOT combines standard, premium and weighted overall results in one compact row", () => {
  const row = eodDotRow("TEST", totals(100, 80, 20), totals(50, 45, 5));
  assert.equal(row["Standard eligible"], 100);
  assert.equal(row["Standard DOT %"], "80.0%");
  assert.equal(row["Premium eligible"], 50);
  assert.equal(row["Premium DOT %"], "90.0%");
  assert.equal(row["Overall eligible"], 150);
  assert.equal(row["Overall DOT %"], "83.3%");
  assert.deepEqual(EOD_DOT_VISIBLE_COLUMNS, ["Station", "Standard eligible", "Standard DOT %", "Premium eligible", "Premium DOT %", "Overall eligible", "Overall DOT %"]);
});

test("DOT grand total is weighted by eligible shipments, not averaged percentages", () => {
  const rows = [
    eodDotRow("A", totals(100, 90), totals(100, 80)),
    eodDotRow("B", totals(10, 1), totals(10, 2)),
  ];
  const total = eodDotTotalRow(rows);
  assert.equal(total["Standard DOT %"], "82.7%");
  assert.equal(total["Premium DOT %"], "74.5%");
  assert.equal(total["Overall DOT %"], "78.6%");
});

test("DOT marks incomplete lanes and overall as unavailable", () => {
  const row = eodDotRow("A", totals(10, 8), undefined);
  assert.equal(row["Standard DOT %"], "80.0%");
  assert.equal(row["Premium DOT %"], "—");
  assert.equal(row["Overall DOT %"], "—");
});
