import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const resolver = read("apps/connect/src/lib/connect-expense-data.ts");
const workflow = read("apps/connect/src/lib/approval-workflow-routing.ts");
const route = read("apps/connect/app/api/connect/reimbursements/route.ts");
const employeeUi = read("apps/connect/src/components/connect-reimbursements.tsx");
const approvalUi = read("apps/connect/src/components/connect-approval-inbox.tsx");
const migration = read("supabase/migrations/20260915134500_reimbursement_manager_finance_chain.sql");

const checks = [
  [resolver.includes('reportingChainMaxLevel: 2') && resolver.includes('level3StepName: "Finance approval"'), "claims resolve two reporting-manager levels before Finance"],
  [!resolver.includes("trimReimbursementStepsAfterBusinessHead"), "National/Business Head no longer skips the remaining configured chain"],
  [resolver.includes('stage_code: step.step_name === "Finance approval" ? "finance" : "manager"'), "approval responsibility uses a stable stage code"],
  [workflow.includes("reportingChainMaxLevel") && workflow.includes("level3StepName"), "workflow resolver supports reporting-chain managers plus a functional final owner"],
  [route.includes("withPolicyExceptionApprovers") && route.includes('stage_code: "policy_exception"'), "special policy exceptions are inserted before Finance"],
  [route.includes("finance_policy_snapshot: quoteById.get(item.id)"), "immutable Finance policy snapshots are submitted with each expense line"],
  [!route.includes("if (approval.directToPayment"), "no claimant can bypass Finance into Payment Processing"],
  [migration.includes("Finance approval is required before Payment Processing") && migration.includes("v_step.stage_code <> 'finance'"), "database prevents manager-only release to Payments"],
  [migration.includes("v_payable_total") && migration.includes("policy_payable_total"), "Payments receives the policy-eligible amount"],
  [migration.includes("finance_policy_snapshot") && migration.includes("approved_amount"), "submit and resubmit preserve policy assessment and payable amount"],
  [employeeUi.includes("How approvals work for me") && employeeUi.includes("Your configured route"), "employees have a personalized approval guide"],
  [approvalUi.includes("Finance policy review by expense head") && approvalUi.includes("Policy payable"), "Finance receives a compact line-by-line policy review"],
  [route.includes("expenseOversightSummary") && approvalUi.includes("Organisation reimbursement visibility") && approvalUi.includes("Visibility does not make you an approver"), "top-level leaders retain read-only organisation visibility without default approval"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
