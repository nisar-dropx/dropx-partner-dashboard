import assert from "node:assert/strict";
import test from "node:test";
import { resolveStationOpeningSchedule, stationOpeningLateMinutes } from "./station-opening.ts";

const rosterPerson = (shiftStartTime, overrides = {}) => ({
  locationId: "STATION-1",
  today: {
    rosterDayType: "working",
    shiftEndTime: "17:00:00",
    shiftName: `Shift ${shiftStartTime}`,
    shiftSource: "Active approved roster",
    shiftStartTime,
    ...overrides
  }
});

test("uses the station's earliest approved opening shift, not the first punch employee's shift", () => {
  const schedule = resolveStationOpeningSchedule([
    rosterPerson("09:00:00"),
    rosterPerson("06:00:00"),
    rosterPerson("10:00:00")
  ], "STATION-1", "02:00:00", "10:00:00");

  assert.equal(schedule.scheduledTime, "06:00:00");
  assert.equal(schedule.shiftName, "Shift 06:00:00");
  assert.match(schedule.shiftSource, /station roster/i);
});

test("ignores weekly-off workers and shifts outside the station opening window", () => {
  const schedule = resolveStationOpeningSchedule([
    rosterPerson("01:00:00"),
    rosterPerson("05:00:00", { rosterDayType: "weekly_off" }),
    rosterPerson("07:00:00")
  ], "STATION-1", "02:00:00", "10:00:00");

  assert.equal(schedule.scheduledTime, "07:00:00");
});

test("calculates lateness from the station opening shift without employee grace", () => {
  assert.equal(stationOpeningLateMinutes(8 * 60, "07:00:00", "02:00:00"), 60);
  assert.equal(stationOpeningLateMinutes(5 * 60 + 45, "06:00:00", "02:00:00"), 0);
});

test("supports station opening windows that cross midnight", () => {
  const schedule = resolveStationOpeningSchedule([
    rosterPerson("01:00:00"),
    rosterPerson("23:00:00")
  ], "STATION-1", "22:00:00", "02:00:00");

  assert.equal(schedule.scheduledTime, "23:00:00");
  assert.equal(stationOpeningLateMinutes(30, "23:00:00", "22:00:00"), 90);
});
