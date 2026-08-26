import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OUTSIDE_STATION_ALLOWANCE_MINUTES,
  normalizeOutsideStationMinutes,
  outsideStationThresholdMinutes
} from "./attendance-outside-policy.ts";

test("defaults and bounds the configurable outside-station allowance", () => {
  assert.equal(normalizeOutsideStationMinutes(undefined), DEFAULT_OUTSIDE_STATION_ALLOWANCE_MINUTES);
  assert.equal(normalizeOutsideStationMinutes(0), DEFAULT_OUTSIDE_STATION_ALLOWANCE_MINUTES);
  assert.equal(normalizeOutsideStationMinutes(241), DEFAULT_OUTSIDE_STATION_ALLOWANCE_MINUTES);
  assert.equal(normalizeOutsideStationMinutes("45"), 45);
});

test("uses the longer of the configured allowance and assigned shift break", () => {
  assert.equal(outsideStationThresholdMinutes(30, 0), 30);
  assert.equal(outsideStationThresholdMinutes(30, 45), 45);
  assert.equal(outsideStationThresholdMinutes(60, 30), 60);
});
