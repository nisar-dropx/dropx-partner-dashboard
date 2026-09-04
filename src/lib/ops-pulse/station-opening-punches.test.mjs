import assert from "node:assert/strict";
import test from "node:test";
import { firstOpeningPunches, physicalPunchLocation } from "./station-opening-punches.ts";

const deviceLocations = new Map([["device-f", "JUGF"], ["device-d", "JUGD"]]);
const serialLocations = new Map([["serial-f", "JUGF"]]);
const windows = new Map(["JUGD", "JUGF"].map((id) => [id, { start: "02:00:00", end: "10:00:00" }]));
const biometric = (overrides = {}) => ({ device_id: "device-f", device_serial: "serial-f",
  source: "biometric", location_id: "JUGD", geofence_status: null, ...overrides });

test("JUGF physical punch cannot open assigned/parent JUGD", () => {
  const physical = physicalPunchLocation(biometric(), deviceLocations, serialLocations);
  const result = firstOpeningPunches([
    { locationId: physical, time: "2026-09-03T01:17:23Z", enrolmentId: "140071" },
    { locationId: "JUGD", time: "2026-09-03T04:08:09Z", enrolmentId: "714" }
  ], windows);
  assert.equal(result.get("JUGF").enrolmentId, "140071");
  assert.equal(result.get("JUGD").time, "2026-09-03T04:08:09Z");
});

test("unknown or out-of-scope biometric device never falls back to worker assignment", () => {
  assert.equal(physicalPunchLocation(biometric({ device_id: "unknown" }), deviceLocations, serialLocations), null);
  assert.equal(physicalPunchLocation(biometric({ device_id: null, device_serial: null }), deviceLocations, serialLocations), null);
  assert.equal(physicalPunchLocation(biometric({ device_id: null }), deviceLocations, serialLocations), "JUGF");
});

test("GPS punch needs confirmed physical geofence; remote/unknown GPS does not open a station", () => {
  assert.equal(physicalPunchLocation(biometric({ source: "app_gps", geofence_status: "inside" }), deviceLocations, serialLocations), "JUGD");
  for (const geofence_status of [null, "outside", "unknown"]) {
    assert.equal(physicalPunchLocation(biometric({ source: "app_gps", geofence_status }), deviceLocations, serialLocations), null);
  }
});

test("same worker can open another physical station on a later check-in", () => {
  const result = firstOpeningPunches([
    { locationId: "JUGF", time: "2026-09-03T01:17:23Z", enrolmentId: "140071" },
    { locationId: "JUGD", time: "2026-09-03T02:00:00Z", enrolmentId: "140071" }
  ], windows);
  assert.equal(result.size, 2);
  assert.equal(result.get("JUGD").time, "2026-09-03T02:00:00Z");
});

test("opening requires a punch within the physical station's configured window", () => {
  const result = firstOpeningPunches([
    { locationId: "JUGD", time: "2026-09-03T05:00:00Z", enrolmentId: "late" },
    { locationId: "JUGF", time: "2026-09-03T01:17:23Z", enrolmentId: "140071" },
    { locationId: "OTHER", time: "2026-09-03T01:00:00Z", enrolmentId: "other" }
  ], windows);
  assert.equal(result.has("JUGD"), false);
  assert.equal(result.size, 1);
});
