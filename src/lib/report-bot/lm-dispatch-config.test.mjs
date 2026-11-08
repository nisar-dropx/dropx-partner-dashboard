import test from "node:test";
import assert from "node:assert/strict";
import { scheduleSlots, suggestedTimes } from "./lm-dispatch-config.ts";

test("dispatch windows are generated from master values rather than a fixed runtime list", () => {
  const slots = scheduleSlots("07:00", "22:00", 60);
  assert.equal(slots.length, 16);
  assert.equal(slots[0], "07:00");
  assert.equal(slots.at(-1), "22:00");
  assert.deepEqual(slots.slice(0, 3), ["07:00", "08:00", "09:00"]);
  assert.equal(scheduleSlots("07:00", "22:00", 30).length, 31);
  assert.deepEqual(scheduleSlots("08:15", "09:15", 20), ["08:15", "08:35", "08:55", "09:15"]);
});

test("dispatch windows reject invalid or excessive master configurations", () => {
  assert.throws(() => scheduleSlots("22:00", "07:00", 30), /after the start/);
  assert.throws(() => scheduleSlots("07:00", "22:00", 1), /between 5 and 720/);
  assert.throws(() => scheduleSlots("bad", "22:00", 30), /valid start and end/);
});

test("final EOD defaults to one configurable 23:30 slot", () => {
  assert.deepEqual(suggestedTimes("eod"), ["23:30"]);
});
