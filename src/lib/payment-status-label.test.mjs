import assert from "node:assert/strict";
import test from "node:test";
import { paymentStatusLabel } from "./payment-status-label.ts";

test("final assigned approval is never labelled as initial approval", () => {
  assert.equal(paymentStatusLabel({
    status: "ZONAL_HEAD_APPROVED",
    approval_status: "ZONAL_HEAD_APPROVED",
    current_approver_user_id: "finance-user",
    current_approver_role_id: "finance-role",
    current_step_order: 4,
    total_steps: 4
  }), "Final Approval Pending");
});

test("middle approval stages and completed requests have distinct labels", () => {
  assert.equal(paymentStatusLabel({
    status: "OPERATIONS_CLM_APPROVED",
    approval_status: "OPERATIONS_CLM_APPROVED",
    current_approver_user_id: "aom-user",
    current_step_order: 2,
    total_steps: 4
  }), "Approval In Progress");
  assert.equal(paymentStatusLabel({
    status: "approved",
    approval_status: "FINAL_APPROVED",
    current_step_order: 4,
    total_steps: 4
  }), "Final Approved");
});
