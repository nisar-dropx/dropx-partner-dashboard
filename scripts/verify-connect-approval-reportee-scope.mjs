import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const component = read("apps/connect/src/components/connect-approval-inbox.tsx");
const scope = read("apps/connect/src/lib/connect-reportee-scope.ts");
const reportingTree = read("apps/connect/src/lib/connect-reporting-tree.ts");
const approvals = read("apps/connect/app/api/connect/approvals/route.ts");
const reimbursements = read("apps/connect/app/api/connect/reimbursements/route.ts");
const attendance = read("apps/connect/src/lib/connect-manager-approvals.ts");
const location = read("apps/connect/src/lib/connect-location-integrity.ts");

const checks = [
  [component.includes('useState<ReporteeScope>("immediate")'), "Approval Inbox always opens with immediate reportees"],
  [component.includes("Immediate reportees") && component.includes("Entire team"), "the user-controlled scope switch is present"],
  [component.includes("reporteeScope })"), "all Approval Inbox fetches send the selected reportee scope"],
  [scope.includes('=== "team" ? "team" : "immediate"'), "unknown or missing scope values safely default to immediate"],
  [scope.includes('relationship_type", "solid_line"') && scope.includes('is_primary", true'), "scope follows active primary solid-line Org Chart relationships"],
  [reportingTree.includes("while (queue.length)"), "Entire team recursively traverses the reporting tree"],
  [approvals.includes("loadConnectReporteeAccess(account, scope)"), "leave, attendance and location APIs load one shared reportee scope"],
  [attendance.match(/connectReporteeMatches\(reportees/g)?.length >= 2, "manager and HR attendance queues are both reportee-scoped"],
  [reimbursements.includes("connectReporteeMatches(reportees"), "claims are reportee-scoped"],
  [location.includes("loadConnectReporteeAccess(account, reporteeScope)"), "location review authorization follows the selected reporting scope"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
