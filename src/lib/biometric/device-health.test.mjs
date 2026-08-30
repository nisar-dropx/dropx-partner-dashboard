import assert from "node:assert/strict";
import test from "node:test";

import { biometricDeviceHealth, biometricHealthPriority } from "./device-health.ts";

const now = new Date("2026-08-31T12:00:00.000Z");

test("recent attendance flow is reporting", () => {
  assert.deepEqual(
    biometricDeviceHealth({ last_seen_at: "2026-08-31T11:55:00.000Z", status: "Connected" }, now),
    { status: "Reporting", tone: "good" }
  );
});

test("heartbeat-only remains an orange warning", () => {
  assert.equal(biometricDeviceHealth({ last_seen_at: "2026-08-31T11:59:00.000Z", status: "Heartbeat only" }, now).tone, "warn");
});

test("a stale signal from today is orange", () => {
  assert.equal(biometricDeviceHealth({ last_seen_at: "2026-08-31T05:00:00.000Z" }, now).status, "Disconnected today");
});

test("an older or never-seen signal is red", () => {
  assert.equal(biometricDeviceHealth({ last_seen_at: "2026-08-30T18:20:00.000Z" }, now).tone, "bad");
  assert.equal(biometricDeviceHealth({ last_seen_at: null }, now).status, "Disconnected");
});

test("failures sort ahead of healthy devices", () => {
  assert.ok(biometricHealthPriority("Disconnected") < biometricHealthPriority("Disconnected today"));
  assert.ok(biometricHealthPriority("Disconnected today") < biometricHealthPriority("Reporting"));
});
