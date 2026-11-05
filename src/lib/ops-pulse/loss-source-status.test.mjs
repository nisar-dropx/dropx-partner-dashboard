import assert from "node:assert/strict";
import test from "node:test";
import { recoveryDetailsUpdated, recoverySourceStatusKey } from "./loss-final-summary.ts";
import { recoveryNeedsReview } from "./nl-loss-policy.ts";

const base = "Recoverable - Missed SLA by eDSP";
const plan = { source_amount: 100, source_status: base, approval_status: "approved", outcome_code: "deduct", allocations: [{ amount: 100 }] };
test("live and historic eDSP labels preserve saved updates and do not require review", () => {
  for (const saved of [base, base + "1", base + "2"]) {
    for (const incoming of [base, base + "1", base + "2"]) {
      const recovery = { ...plan, source_status: saved };
      const row = { amount: 100, source_status: incoming, report: "nl", recovery };
      assert.equal(recoveryDetailsUpdated(row, recovery), true);
      assert.equal(recoveryNeedsReview(row), false);
    }
  }
});
test("genuine outcome or amount changes, deleted plans and returned approvals stay blocked", () => {
  for (const status of ["Non-recoverable", base + "3", "Recoverable - Lost package", null]) {
    const row = { amount: 100, source_status: status, report: "nl", recovery: plan };
    assert.equal(recoveryDetailsUpdated(row, plan), false);
    assert.equal(recoveryNeedsReview(row), true);
  }
  assert.equal(recoveryDetailsUpdated({ amount: 101, source_status: base + "1" }, plan), false);
  for (const extra of [{ is_deleted: true }, { approval_status: "returned" }, { approval_status: "needs_review" }, { allocations: [{ amount: 90 }] }]) {
    assert.equal(recoveryDetailsUpdated({ amount: 100, source_status: base + "2" }, { ...plan, ...extra }), false);
  }
  assert.equal(recoverySourceStatusKey("Other status"), "Other status");
});
