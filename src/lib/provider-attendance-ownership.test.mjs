import assert from "node:assert/strict";
import test from "node:test";

import {
  providerAttendanceLocationKey,
  providerAttendanceOwnerOn,
  providerAttendanceRecordForStation,
  providerAttendanceSetupSignature
} from "./provider-attendance-ownership.ts";

function signature(rate) {
  return providerAttendanceSetupSignature([{
    code: "fixed_daily",
    paySchedule: "per_day",
    calculationType: "fixed_daily",
    calculationSource: "attendance_eligibility",
    rate
  }]);
}

function mapping(id, stationId, rate, effectiveFrom = "2026-09-01") {
  return {
    id,
    workforceId: "worker-1",
    stationId,
    effectiveFrom,
    effectiveTo: null,
    setupSignature: signature(rate)
  };
}

test("numeric and string attendance rates have the same setup signature", () => {
  assert.equal(signature(800), signature("800"));
  assert.equal(signature(800), signature(" 800.00 "));
});

test("attendance ownership is independent for simultaneous locations", () => {
  const mappings = [
    mapping("kgqa", "station-kgqa", 800),
    mapping("other", "station-other", 900)
  ];

  assert.deepEqual(
    providerAttendanceOwnerOn(mappings, "worker-1", "station-kgqa", "2026-09-15"),
    { ownerId: "kgqa", conflict: false }
  );
  assert.deepEqual(
    providerAttendanceOwnerOn(mappings, "worker-1", "station-other", "2026-09-15"),
    { ownerId: "other", conflict: false }
  );
});

test("different newest setups at the same location are ambiguous and choose no owner", () => {
  const mappings = [
    mapping("same-a", "station-kgqa", 800),
    mapping("same-b", "station-kgqa", 900),
    mapping("older", "station-kgqa", 700, "2026-08-01")
  ];

  assert.deepEqual(
    providerAttendanceOwnerOn(mappings, "worker-1", "station-kgqa", "2026-09-15"),
    { ownerId: "", conflict: true }
  );
});

test("equivalent newest same-location setups resolve deterministically", () => {
  const mappings = [
    mapping("same-a", "station-kgqa", 800),
    mapping("same-b", "station-kgqa", "800")
  ];

  assert.deepEqual(
    providerAttendanceOwnerOn(mappings, "worker-1", "station-kgqa", "2026-09-15"),
    { ownerId: "same-b", conflict: false }
  );
});

test("October located attendance is payable only at the recorded station", () => {
  const date = "2026-10-20";
  const located = new Map([
    [providerAttendanceLocationKey("kgqa1190", "station-kgqa", date), { status: "P" }]
  ]);
  const unlocated = new Map();

  assert.deepEqual(providerAttendanceRecordForStation({
    located,
    unlocated,
    workforceId: "kgqa1190",
    stationId: "station-kgqa",
    date,
    unlocatedOwnerStationId: ""
  }), { status: "P" });
  assert.equal(providerAttendanceRecordForStation({
    located,
    unlocated,
    workforceId: "kgqa1190",
    stationId: "station-other",
    date,
    unlocatedOwnerStationId: ""
  }), undefined);
});

test("legacy unlocated attendance is exposed only to its single owner station", () => {
  const date = "2026-10-01";
  const unlocated = new Map([["worker-1|2026-10-01", { status: "P" }]]);
  const input = { located: new Map(), unlocated, workforceId: "worker-1", date };

  assert.deepEqual(providerAttendanceRecordForStation({
    ...input,
    stationId: "station-a",
    unlocatedOwnerStationId: "station-a"
  }), { status: "P" });
  assert.equal(providerAttendanceRecordForStation({
    ...input,
    stationId: "station-b",
    unlocatedOwnerStationId: "station-a"
  }), undefined);
});
