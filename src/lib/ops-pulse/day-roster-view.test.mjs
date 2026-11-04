import assert from "node:assert/strict";
import test from "node:test";
import { sortDayRosterGroupLabels } from "./day-roster-view.ts";

test("day roster groups sort by shift start with week off last", () => {
  assert.deepEqual(
    sortDayRosterGroupLabels([
      "09:00–18:00",
      "Week off",
      "06:30–15:30",
      "08:00–17:00",
      "22:00–07:00",
      "Rostered"
    ]),
    ["06:30–15:30", "08:00–17:00", "09:00–18:00", "22:00–07:00", "Rostered", "Week off"]
  );
});

test("day roster sort is stable for same start and puts odd labels before week off", () => {
  assert.deepEqual(
    sortDayRosterGroupLabels(["14:00–23:00", "14:00–22:00", "Custom cover", "Week off", "00:00–08:00"]),
    ["00:00–08:00", "14:00–22:00", "14:00–23:00", "Custom cover", "Week off"]
  );
  assert.deepEqual(sortDayRosterGroupLabels([]), []);
});
