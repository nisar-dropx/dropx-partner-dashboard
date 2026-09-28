import test from "node:test";
import assert from "node:assert/strict";
import { paymentApproverNeedsReconciliation } from "./payment-approver-reconciliation-policy.ts";

const stored = {
  current_approver_user_id: "old-manager",
  current_approver_role_id: "cluster-manager",
  current_step_order: 1
};

test("reroutes a pending request when the live People owner changes", () => {
  assert.equal(paymentApproverNeedsReconciliation(stored, {
    userId: "current-manager",
    roleId: "cluster-manager"
  }, 1), true);
});

test("repairs the role and step together with the named owner", () => {
  assert.equal(paymentApproverNeedsReconciliation(stored, {
    userId: "area-manager",
    roleId: "area-manager-role"
  }, 2), true);
});

test("does not rewrite an already-correct pending assignment", () => {
  assert.equal(paymentApproverNeedsReconciliation(stored, {
    userId: "old-manager",
    roleId: "cluster-manager"
  }, 1), false);
});

test("clears a stale named owner when the configured step has no live approver", () => {
  assert.equal(paymentApproverNeedsReconciliation(stored, null, 1), true);
  assert.equal(paymentApproverNeedsReconciliation({
    current_approver_user_id: null,
    current_approver_role_id: null,
    current_step_order: 1
  }, null, 1), false);
});
