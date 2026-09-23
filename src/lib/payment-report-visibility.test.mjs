import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const reportPage = readFileSync(new URL("../app/payments/report/page.tsx", import.meta.url), "utf8");
const reportTable = readFileSync(new URL("../components/payment-report-table.tsx", import.meta.url), "utf8");

test("payment report loads estimated amounts and current workflow ownership", () => {
  assert.match(reportPage, /amount, amount_requested/);
  assert.match(reportPage, /current_step_order, total_steps/);
  assert.match(reportPage, /current_approver_name:/);
  assert.match(reportPage, /current_approver_role_names:/);
});

test("payment report makes details and workflow responsibility visible", () => {
  assert.match(reportTable, /request\.amount \?\? request\.amount_requested/);
  assert.match(reportTable, /View details/);
  assert.match(reportTable, />Current Owner</);
  assert.match(reportTable, />Current Approver</);
  assert.match(reportTable, />Responsible Role</);
  assert.match(reportTable, />Approval Step</);
});
