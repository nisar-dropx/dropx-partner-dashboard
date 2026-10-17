import assert from "node:assert/strict";
import test from "node:test";
import { remapApproverPeople, selectActiveCoverRows } from "./approval-covers-core.ts";

test("all-workflow covers apply; leave-only covers stay out of Ops Pulse", () => {
  const rows = [
    { approver_person_id: "a1", delegate_person_id: "d1", workflow_code: null, reason: "acting", effective_from: "2026-10-01" },
    { approver_person_id: "a1", delegate_person_id: "d2", workflow_code: "leave_request", reason: "leave", effective_from: "2026-10-10" },
  ];
  assert.deepEqual(selectActiveCoverRows(rows).map((r) => r.delegate_person_id), ["d1"]);
  assert.deepEqual(selectActiveCoverRows(rows, "leave_request").map((r) => r.delegate_person_id), ["d2", "d1"]);
});

test("remap replaces covered people and dedupes", () => {
  const covers = new Map([["a1", { personId: "d1", name: "Delegate" }]]);
  assert.deepEqual(
    remapApproverPeople([{ personId: "a1", name: "Absent" }, { personId: "c1", name: "CM" }], covers),
    [{ personId: "d1", name: "Delegate" }, { personId: "c1", name: "CM" }],
  );
  assert.deepEqual(
    remapApproverPeople([{ personId: "a1", name: "Absent" }, { personId: "d1", name: "Delegate" }], covers),
    [{ personId: "d1", name: "Delegate" }],
  );
});
