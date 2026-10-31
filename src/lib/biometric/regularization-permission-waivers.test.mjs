import assert from "node:assert/strict";
import test from "node:test";
import { regularizationPermissionWaivers } from "./regularization-permission-waivers.ts";

test("approved early-out permission waives early-out penalty only", () => {
  assert.deepEqual(
    regularizationPermissionWaivers("Attendance regularized: early out permission"),
    { late: false, earlyOut: true }
  );
});

test("approved late-in permission waives late penalty only", () => {
  assert.deepEqual(
    regularizationPermissionWaivers("Attendance regularized: late in permission"),
    { late: true, earlyOut: false }
  );
});

test("other regularization remarks do not waive timing penalties", () => {
  assert.deepEqual(
    regularizationPermissionWaivers("Attendance regularized: incorrect out"),
    { late: false, earlyOut: false }
  );
  assert.deepEqual(regularizationPermissionWaivers(""), { late: false, earlyOut: false });
});
