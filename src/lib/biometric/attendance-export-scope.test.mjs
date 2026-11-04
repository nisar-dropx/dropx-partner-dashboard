import assert from "node:assert/strict";
import test from "node:test";
import {
  attendanceExportWorkerStationKey,
  resolveAttendanceExportLocationIds
} from "./attendance-export-scope.ts";

test("export location resolver keeps multi-select and rejects out-of-scope ids", () => {
  assert.deepEqual(
    resolveAttendanceExportLocationIds(["a", "b", "a", ""], ["a", "b", "c"]),
    { ok: true, outOfScope: [], locationIds: ["a", "b"] }
  );
  assert.deepEqual(
    resolveAttendanceExportLocationIds([], ["a", "b"]),
    { ok: true, outOfScope: [], locationIds: ["a", "b"] }
  );
  assert.deepEqual(
    resolveAttendanceExportLocationIds(["a", "x"], ["a", "b"]),
    { ok: false, outOfScope: ["x"], locationIds: [] }
  );
});

test("worker station key separates the same person across stations", () => {
  assert.notEqual(
    attendanceExportWorkerStationKey({
      workerCode: "D0998",
      workerName: "HARSHIT",
      designation: "Shift Incharge",
      location: "TZC4"
    }),
    attendanceExportWorkerStationKey({
      workerCode: "D0998",
      workerName: "HARSHIT",
      designation: "Shift Incharge",
      location: "CHM"
    })
  );
  assert.equal(
    attendanceExportWorkerStationKey({
      workerCode: "D1",
      workerName: "A",
      designation: "SI",
      location: ""
    }),
    "D1|A|SI|-"
  );
});

test("export location resolver trims blanks and preserves allowed order for empty selection", () => {
  assert.deepEqual(
    resolveAttendanceExportLocationIds(["  ", "\t"], ["z", "a"]),
    { ok: true, outOfScope: [], locationIds: ["z", "a"] }
  );
  assert.deepEqual(
    resolveAttendanceExportLocationIds([" b ", "a"], ["a", "b", "c"]),
    { ok: true, outOfScope: [], locationIds: ["b", "a"] }
  );
});
