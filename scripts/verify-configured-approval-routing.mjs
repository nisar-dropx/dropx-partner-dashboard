import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd().endsWith("apps/connect") ? resolve(process.cwd(), "../..") : process.cwd();
const read = (file) => readFileSync(resolve(root, file), "utf8");
const assertContains = (file, markers) => {
  const source = read(file);
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${file} no longer contains required approval-routing marker: ${marker}`);
  }
};

assertContains("packages/approval-routing/configured-approval-routing.ts", [
  "hr_approval_workflow_routes",
  "requester_person_id",
  "hr_final_required",
  "hr_approval_delegations",
  "hr_permission_pages",
  "approval cannot be assigned"
]);
assertContains("src/lib/connect-attendance-approval.ts", [
  "resolveConfiguredApprovalWorkflow",
  'workflowCode: "attendance_regularization"'
]);
assertContains("apps/connect/src/lib/connect-leave-data.ts", [
  "resolveConfiguredApprovalWorkflow",
  'workflowCode: "leave_request"'
]);
assertContains("apps/connect/src/lib/connect-expense-data.ts", [
  "resolveConfiguredApprovalWorkflow",
  'workflowCode: "reimbursement"'
]);

console.log("Configured People approval routes are wired to DropX One attendance, leave and reimbursement submissions.");
