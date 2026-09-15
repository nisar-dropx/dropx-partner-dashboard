import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "apps/connect/src/lib/connect-expense-data.ts"), "utf8");
const migration = readFileSync(resolve(root, "supabase/migrations/20260915074438_expense_pre_request_manager_only.sql"), "utf8");

const start = source.indexOf("export async function resolveExpenseClaimRequestAssignees");
const next = source.indexOf("\nexport ", start + 1);
const resolver = start >= 0 ? source.slice(start, next >= 0 ? next : undefined) : "";

const checks = [
  [resolver.includes("resolveImmediateReportingManager"), "expense pre-requests resolve the immediate reporting manager"],
  [resolver.includes("assignees: [manager]"), "the reporting manager is the only pre-request assignee"],
  [!source.includes("resolveFinanceHeadAssignees"), "finance and owner roles are not collected for expense pre-requests"],
  [!resolver.includes("payment_heads") && !resolver.includes("OWNER"), "pre-request routing does not bypass configured claim approvals"],
  [migration.includes("assignee_role = 'finance_head'") && migration.includes("assignee_role = 'reporting_manager'"), "existing parallel finance assignees are skipped only when a manager remains pending"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
