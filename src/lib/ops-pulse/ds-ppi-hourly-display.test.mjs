import test from "node:test";
import assert from "node:assert/strict";
import { buildPpiHourlyDisplay, istParts } from "./ds-ppi-hourly-display.ts";

test("10:05 as-of lists only hours with data and never pads an empty hour 10", () => {
  const rows = buildPpiHourlyDisplay(
    [
      { hour: 6, order_count: 44, unit_count: 110, avg_ppt_seconds: 67.55 },
      { hour: 9, order_count: 114, unit_count: 373, avg_ppt_seconds: 62.42 }
    ],
    10
  );
  assert.equal(rows[0]?.hour, 6);
  assert.equal(rows.at(-1)?.hour, 9);
  assert.deepEqual(
    rows.map((r) => r.hour),
    [6, 9]
  );
  assert.ok(!rows.some((r) => r.hour === 10), "empty as-of hour is omitted");
  assert.ok(!rows.some((r) => r.hour === 0), "no midnight orphan on daytime card");
});

test("exact 10:00 wall omits hour 10 when that bucket has no completions yet", () => {
  const rows = buildPpiHourlyDisplay([{ hour: 9, order_count: 1, unit_count: 1, avg_ppt_seconds: 50 }], 10);
  assert.equal(rows.at(-1)?.hour, 9);
  assert.ok(!rows.some((r) => r.hour === 10));
});

test("as-of hour is kept once it has completions", () => {
  const rows = buildPpiHourlyDisplay(
    [
      { hour: 9, order_count: 1, unit_count: 1, avg_ppt_seconds: 50 },
      { hour: 10, order_count: 2, unit_count: 4, avg_ppt_seconds: 40 }
    ],
    10
  );
  assert.equal(rows.at(-1)?.hour, 10);
  assert.equal(rows.find((r) => r.hour === 10)?.order_count, 2);
});

test("midnight EOD keeps hours with data and maps hour 0 → 24:00", () => {
  const rows = buildPpiHourlyDisplay(
    [
      { hour: 0, order_count: 1, unit_count: 1, avg_ppt_seconds: 110 },
      { hour: 22, order_count: 10, unit_count: 20, avg_ppt_seconds: 40 }
    ],
    0,
    { midnightEod: true }
  );
  assert.deepEqual(
    rows.map((r) => r.hour),
    [22, 24]
  );
  assert.ok(!rows.some((r) => r.hour === 0));
  assert.equal(rows.find((r) => r.hour === 24)?.order_count, 1);
  assert.equal(rows.find((r) => r.hour === 22)?.order_count, 10);
});

test("before open (01–05) returns no hourly rows", () => {
  assert.deepEqual(
    buildPpiHourlyDisplay([{ hour: 0, order_count: 1, unit_count: 1, avg_ppt_seconds: 10 }], 3),
    []
  );
});

test("istParts uses Asia/Kolkata offset", () => {
  // 2026-11-26 04:35 UTC → 10:05 IST
  const parts = istParts(Date.UTC(2026, 10, 26, 4, 35, 0));
  assert.equal(parts.hour, 10);
  assert.equal(parts.minute, 5);
  assert.equal(parts.date, "2026-11-26");
});
