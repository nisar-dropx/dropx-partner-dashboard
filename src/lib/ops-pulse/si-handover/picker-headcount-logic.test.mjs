import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPickerHeadcountNote,
  isPartTimePicker,
  isPickerDesignation,
  punchDatesCovering,
  shiftWindowIso,
} from "./picker-headcount-logic.ts";

test("picker designation matches PC / PTPC / name with picker", () => {
  assert.equal(isPickerDesignation({ code: "PC", name: "Picker" }), true);
  assert.equal(isPickerDesignation({ code: "PTPC", name: "Part Time Pickers" }), true);
  assert.equal(isPickerDesignation({ code: "X", name: "Floor Picker Lead" }), true);
  assert.equal(isPickerDesignation({ code: "SSA", name: "Station Support Associate" }), false);
  assert.equal(isPickerDesignation({ code: "HK", name: "House Keeping" }), false);
  assert.equal(isPickerDesignation({ code: "PTSSA", name: "Part Time Station Support" }), false);
});

test("part-time pickers mirror People isPartTimeWorker", () => {
  assert.equal(isPartTimePicker({ employmentType: "part_time" }), true);
  assert.equal(
    isPartTimePicker({
      employmentType: "full_time",
      designationCode: "PTPC",
      designationName: "Part Time Pickers",
    }),
    true,
  );
  assert.equal(
    isPartTimePicker({
      employmentType: "full_time",
      designationCode: "PC",
      designationName: "Picker",
    }),
    false,
  );
  // PTSSA is part-time in People, but not a picker — only used if designation matched.
  assert.equal(
    isPartTimePicker({
      employmentType: "full_time",
      designationCode: "PTSSA",
      designationName: "Part Time Station Support",
    }),
    true,
  );
  assert.equal(
    isPartTimePicker({
      employmentType: "full_time",
      designationCode: "PTEMP",
      designationName: "Something Else",
    }),
    false,
  );
});

test("night shift window spans midnight and covers two punch dates", () => {
  const win = shiftWindowIso("2026-10-22", "22:00");
  assert.equal(win.startMs, Date.parse("2026-10-22T22:00:00+05:30"));
  assert.equal(win.endMs, Date.parse("2026-10-23T06:00:00+05:30"));
  assert.deepEqual(punchDatesCovering("2026-10-22", "22:00"), [
    "2026-10-22",
    "2026-10-23",
  ]);
  assert.deepEqual(punchDatesCovering("2026-10-22", "06:00"), ["2026-10-22"]);
});

test("note covers zero punches, unmatched, and non-picker edge cases", () => {
  const empty = buildPickerHeadcountNote({
    punchedPickers: 0,
    unmatchedAtStore: 2,
    nonPickerAtStore: 1,
  });
  assert.match(empty, /Enter headcount manually/);
  assert.match(empty, /2 punches/);
  assert.match(empty, /1 punched person/);

  const filled = buildPickerHeadcountNote({
    punchedPickers: 3,
    unmatchedAtStore: 0,
    nonPickerAtStore: 0,
  });
  assert.match(filled, /Fields stay editable/);
  assert.match(filled, /Edit if someone/);
});
