import assert from "node:assert/strict";
import test from "node:test";
import { amazonWeekPeriod } from "./performance-periods.ts";

test("uses the OpsPulse Sunday-Saturday performance week", () => {
  assert.deepEqual(amazonWeekPeriod(202635), {
    key: 202635,
    week: 35,
    year: 2026,
    startDate: "2026-08-23",
    endDate: "2026-08-29"
  });
});

test("keeps week one aligned when its Sunday starts in the prior year", () => {
  assert.deepEqual(amazonWeekPeriod(202601), {
    key: 202601,
    week: 1,
    year: 2026,
    startDate: "2025-12-28",
    endDate: "2026-01-03"
  });
});
