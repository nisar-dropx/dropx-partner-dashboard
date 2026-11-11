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
  assert.equal(row["Std eligible"], 100);
  assert.equal(row["Std attempted"], 80);
  assert.equal(row["Std delivered"], 80);
  assert.equal(row["Std DOT %"], "80.0%");
  assert.equal(row["Prem eligible"], 50);
  assert.equal(row["Prem attempted"], 45);
  assert.equal(row["Prem delivered"], 45);
  assert.equal(row["Prem DOT %"], "90.0%");
  assert.equal(row["All eligible"], 150);
  assert.equal(row["All attempted"], 125);
  assert.equal(row["All delivered"], 125);
  assert.equal(row["All DOT %"], "83.3%");
  assert.deepEqual(EOD_DOT_VISIBLE_COLUMNS, ["Station", "Std eligible", "Std attempted", "Std delivered", "Std DOT %", "Prem eligible", "Prem attempted", "Prem delivered", "Prem DOT %", "All eligible", "All attempted", "All delivered", "All DOT %"]);
});

test("DOT grand total is weighted by eligible shipments, not averaged percentages", () => {
  const rows = [
    eodDotRow("A", totals(100, 90), totals(100, 80)),
    eodDotRow("B", totals(10, 1), totals(10, 2)),
  ];
  const total = eodDotTotalRow(rows);
  assert.equal(total["Std DOT %"], "82.7%");
  assert.equal(total["Prem DOT %"], "74.5%");
  assert.equal(total["All DOT %"], "78.6%");
  assert.equal(total["All attempted"], 173);
});

test("DOT marks incomplete lanes and overall as unavailable", () => {
  const row = eodDotRow("A", totals(10, 8), undefined);
  assert.equal(row["Std DOT %"], "80.0%");
  assert.equal(row["Prem DOT %"], "—");
  assert.equal(row["All DOT %"], "—");
});

test("DOT attempted excludes parcels still at station, on-road or otherwise pending", () => {
  const standard = totals(100, 70, 10);
  standard.failed = 8;
  standard.rejected = 2;
  standard.oor = 5;
  standard.other = 5;
  const row = eodDotRow("A", standard, totals(0, 0));
  assert.equal(row["Std attempted"], 80);
  assert.equal(row["Std delivered"], 70);
});
