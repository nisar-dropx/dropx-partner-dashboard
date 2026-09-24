import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "apps/connect/src/lib/connect-expense-data.ts"), "utf8");
const migration = readFileSync(resolve(root, "supabase/migrations/20260924180804_expense_request_single_owner.sql"), "utf8");
const expenseUi = readFileSync(resolve(root, "apps/connect/src/components/connect-reimbursements.tsx"), "utf8");

const start = source.indexOf("export async function resolveExpenseClaimRequestAssignees");
const next = source.indexOf("\nexport ", start + 1);
const resolver = start >= 0 ? source.slice(start, next >= 0 ? next : undefined) : "";

const checks = [
  [resolver.includes("resolveImmediateReportingManager"), "expense pre-requests resolve the immediate reporting manager"],
  [resolver.includes("if (!manager)") && resolver.includes("throw new Error"), "the reporting manager is a mandatory pre-request assignee"],
  [resolver.includes("assignees: [manager]") && !resolver.includes("resolveFinanceHeadApprover") && !resolver.includes("resolveCompanyDesignationApprover"), "only the reporting manager owns pre-request approval"],
  [!resolver.includes("payment_heads") && !resolver.includes("OWNER"), "pre-request routing does not bypass configured claim approvals"],
  [migration.includes("fallback.assignee_role in ('finance_head', 'managing_partner')") && migration.includes("manager.status = 'pending'"), "existing parallel fallback assignees are skipped only when a manager remains pending"],
  [migration.includes("v_manager_count <> 1") && migration.includes("assignee.assignee_role='reporting_manager'"), "database submission and decisions enforce the single manager owner"],
  [expenseUi.includes("Approval is required before spending"), "the expense request screen clearly requires approval before spending"],
  [expenseUi.includes("Do not raise an expense request after the expense has already been incurred."), "the expense request screen warns against after-the-fact requests"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
