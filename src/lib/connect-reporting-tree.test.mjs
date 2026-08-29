import assert from "node:assert/strict";
import test from "node:test";

import { collectConnectReporteeAssignmentIds } from "../../apps/connect/src/lib/connect-reporting-tree.ts";

const relationships = [
  { manager_assignment_id: "manager", subject_assignment_id: "direct-a" },
  { manager_assignment_id: "manager", subject_assignment_id: "direct-b" },
  { manager_assignment_id: "direct-a", subject_assignment_id: "level-2" },
  { manager_assignment_id: "level-2", subject_assignment_id: "level-3" },
  { manager_assignment_id: "outside", subject_assignment_id: "not-in-tree" }
];

test("immediate scope contains only direct Org Chart reportees", () => {
  assert.deepEqual(
    [...collectConnectReporteeAssignmentIds("manager", relationships, false)].sort(),
    ["direct-a", "direct-b"]
  );
});

test("entire team scope recursively contains every Org Chart descendant", () => {
  assert.deepEqual(
    [...collectConnectReporteeAssignmentIds("manager", relationships, true)].sort(),
    ["direct-a", "direct-b", "level-2", "level-3"]
  );
});

test("reporting cycles cannot include the manager or loop forever", () => {
  const cyclic = [...relationships, { manager_assignment_id: "level-3", subject_assignment_id: "manager" }];
  assert.deepEqual(
    [...collectConnectReporteeAssignmentIds("manager", cyclic, true)].sort(),
    ["direct-a", "direct-b", "level-2", "level-3"]
  );
});
