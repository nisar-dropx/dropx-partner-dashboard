import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWeeklyRosterIndex,
  weeklyRosterValueForDate
} from "./weekly-roster.ts";

test("picks the worker's active recurring plan instead of another station plan", () => {
  const index = buildWeeklyRosterIndex(
    [
      { id: "other-station", effective_from: "2026-08-31", superseded_at: null, revision_no: 2 },
      { id: "joseph-station", effective_from: "2026-08-31", superseded_at: null, revision_no: 1 }
    ],
    [
      {
        plan_id: "joseph-station",
        worker_type: "contractor",
        worker_id: "joseph",
        roster_date: "2026-09-04",
        value: { start: "09:30" }
      }
    ]
  );

  assert.deepEqual(
    weeklyRosterValueForDate(index, "contractor", "joseph", "2026-09-04"),
    { start: "09:30" }
  );
  assert.equal(weeklyRosterValueForDate(index, "contractor", "joseph", "2026-09-03"), null);
});
